from __future__ import annotations

import stat
import sys
from collections import defaultdict, deque
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from madar_agent.lifecycle import (
    SpeedEnforcerLifecycleError,
    SystemdSpeedEnforcerLifecycle,
)

SERVICE = "madar-speed-enforcer.service"
SHOW = (
    "systemctl",
    "show",
    SERVICE,
    "--property=ActiveState",
    "--property=SubState",
    "--property=MainPID",
    "--no-pager",
)
STOP = ("systemctl", "stop", SERVICE)
KILL = (
    "systemctl",
    "kill",
    "--kill-who=all",
    "--signal=SIGKILL",
    SERVICE,
)
RESTART = ("systemctl", "restart", SERVICE)


def result(returncode: int = 0, stdout: str = "", stderr: str = ""):
    return SimpleNamespace(returncode=returncode, stdout=stdout, stderr=stderr)


def state(active_state: str, *, sub_state: str = "dead", pid: int = 0) -> str:
    return f"ActiveState={active_state}\nSubState={sub_state}\nMainPID={pid}\n"


class ScriptedRunner:
    def __init__(self) -> None:
        self.calls: list[tuple[str, ...]] = []
        self._responses: dict[tuple[str, ...], deque[object]] = defaultdict(deque)

    def add(self, argv: tuple[str, ...], *responses: object) -> None:
        self._responses[argv].extend(responses)

    def __call__(self, argv: list[str]):
        key = tuple(argv)
        self.calls.append(key)
        queue = self._responses[key]
        if not queue:
            raise AssertionError(f"unexpected command: {key}")
        response = queue.popleft()
        if isinstance(response, BaseException):
            raise response
        return response


def lifecycle(tmp_path: Path, runner: ScriptedRunner, **kwargs) -> SystemdSpeedEnforcerLifecycle:
    runtime = tmp_path / "run" / "madar-node-agent"
    runtime.mkdir(parents=True, exist_ok=True)
    return SystemdSpeedEnforcerLifecycle(
        run=runner,
        marker_path=runtime / "speed-enforcer-authorized",
        sleep=lambda _seconds: None,
        poll_attempts=kwargs.pop("poll_attempts", 2),
        poll_interval_seconds=kwargs.pop("poll_interval_seconds", 0.01),
        **kwargs,
    )


def test_speed_marker_requires_private_regular_file_in_existing_runtime_directory(tmp_path: Path) -> None:
    runner = ScriptedRunner()
    runtime = tmp_path / "run" / "madar-node-agent"
    marker = runtime / "speed-enforcer-authorized"
    controller = SystemdSpeedEnforcerLifecycle(run=runner, marker_path=marker)

    with pytest.raises(SpeedEnforcerLifecycleError):
        controller.grant_authorization()

    runtime.mkdir(parents=True)
    controller.grant_authorization()
    assert marker.read_text(encoding="utf-8") == "authorized\n"
    assert stat.S_IMODE(marker.stat().st_mode) == 0o600

    controller.revoke_authorization()
    target = runtime / "target"
    target.write_text("sentinel", encoding="utf-8")
    marker.symlink_to(target)
    with pytest.raises(SpeedEnforcerLifecycleError):
        controller.grant_authorization()
    assert target.read_text(encoding="utf-8") == "sentinel"


def test_speed_is_active_parses_only_explicit_safe_systemd_states(tmp_path: Path) -> None:
    runner = ScriptedRunner()
    runner.add(
        SHOW,
        result(stdout=state("active", sub_state="running", pid=123)),
        result(stdout=state("inactive")),
        result(stdout="ActiveState=active\nSubState=running\n"),
    )
    controller = lifecycle(tmp_path, runner)

    assert controller.is_active() is True
    assert controller.is_active() is False
    with pytest.raises(SpeedEnforcerLifecycleError):
        controller.is_active()


def test_speed_ensure_inactive_uses_stop_then_kill_then_bounded_poll(tmp_path: Path) -> None:
    runner = ScriptedRunner()
    runner.add(STOP, result(returncode=0))
    runner.add(
        SHOW,
        result(stdout=state("active", sub_state="running", pid=321)),
        result(stdout=state("inactive")),
    )
    runner.add(KILL, result(returncode=0))
    controller = lifecycle(tmp_path, runner)
    controller.grant_authorization()

    controller.ensure_inactive()

    assert controller.authorization_granted() is False
    assert runner.calls == [STOP, SHOW, KILL, SHOW]


def test_speed_ensure_inactive_fails_closed_when_shutdown_cannot_be_proven(tmp_path: Path) -> None:
    runner = ScriptedRunner()
    runner.add(STOP, result(returncode=0))
    runner.add(
        SHOW,
        result(stdout=state("active", sub_state="running", pid=321)),
        result(stdout=state("active", sub_state="running", pid=321)),
        result(stdout=state("active", sub_state="running", pid=321)),
    )
    runner.add(KILL, result(returncode=0))
    controller = lifecycle(tmp_path, runner, poll_attempts=2)
    controller.grant_authorization()

    with pytest.raises(SpeedEnforcerLifecycleError):
        controller.ensure_inactive()

    assert controller.authorization_granted() is False
    assert runner.calls == [STOP, SHOW, KILL, SHOW, SHOW]


def test_speed_restart_requires_marker_and_verifies_active_state(tmp_path: Path) -> None:
    runner = ScriptedRunner()
    controller = lifecycle(tmp_path, runner)
    with pytest.raises(SpeedEnforcerLifecycleError):
        controller.restart_authorized()
    assert runner.calls == []

    controller.grant_authorization()
    runner.add(RESTART, result(returncode=0))
    runner.add(SHOW, result(stdout=state("active", sub_state="running", pid=555)))
    controller.restart_authorized()
    assert runner.calls == [RESTART, SHOW]


def test_speed_restart_failure_revokes_marker_and_proves_inactive(tmp_path: Path) -> None:
    runner = ScriptedRunner()
    runner.add(RESTART, result(returncode=1, stderr="private-systemctl-detail"))
    runner.add(STOP, result(returncode=0))
    runner.add(SHOW, result(stdout=state("inactive")))
    controller = lifecycle(tmp_path, runner)
    controller.grant_authorization()

    with pytest.raises(SpeedEnforcerLifecycleError) as raised:
        controller.restart_authorized()

    assert "private-systemctl-detail" not in str(raised.value)
    assert controller.authorization_granted() is False
    assert runner.calls == [RESTART, STOP, SHOW]
