from __future__ import annotations

import stat
import sys
from collections import defaultdict, deque
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from madar_agent.lifecycle import SystemdXrayLifecycle, XrayLifecycleError


SERVICE = "madar-xray.service"
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


def lifecycle(tmp_path: Path, runner: ScriptedRunner, **kwargs) -> SystemdXrayLifecycle:
    runtime = tmp_path / "run" / "madar-node-agent"
    runtime.mkdir(parents=True, exist_ok=True)
    return SystemdXrayLifecycle(
        run=runner,
        marker_path=runtime / "xray-authorized",
        sleep=lambda _seconds: None,
        poll_attempts=kwargs.pop("poll_attempts", 2),
        poll_interval_seconds=kwargs.pop("poll_interval_seconds", 0.01),
        **kwargs,
    )


def test_grant_authorization_requires_existing_runtime_directory_and_writes_owner_only_marker(tmp_path: Path) -> None:
    runner = ScriptedRunner()
    runtime = tmp_path / "run" / "madar-node-agent"
    marker = runtime / "xray-authorized"
    controller = SystemdXrayLifecycle(run=runner, marker_path=marker)

    with pytest.raises(XrayLifecycleError):
        controller.grant_authorization()

    runtime.mkdir(parents=True)
    controller.grant_authorization()

    assert marker.read_text(encoding="utf-8") == "authorized\n"
    assert stat.S_IMODE(marker.stat().st_mode) == 0o600
    assert controller.authorization_granted() is True

    controller.revoke_authorization()
    controller.revoke_authorization()
    assert marker.exists() is False
    assert controller.authorization_granted() is False


def test_grant_authorization_rejects_symlink_and_non_regular_marker_targets(tmp_path: Path) -> None:
    runner = ScriptedRunner()
    runtime = tmp_path / "run" / "madar-node-agent"
    runtime.mkdir(parents=True)
    target = runtime / "target"
    target.write_text("sentinel", encoding="utf-8")
    marker = runtime / "xray-authorized"
    marker.symlink_to(target)
    controller = SystemdXrayLifecycle(run=runner, marker_path=marker)

    with pytest.raises(XrayLifecycleError):
        controller.grant_authorization()
    assert target.read_text(encoding="utf-8") == "sentinel"

    marker.unlink()
    marker.mkdir()
    with pytest.raises(XrayLifecycleError):
        controller.grant_authorization()


@pytest.mark.parametrize(
    ("payload", "expected"),
    [
        (state("inactive"), False),
        (state("failed"), False),
        (state("active", sub_state="running", pid=123), True),
    ],
)
def test_is_active_uses_explicit_systemd_state(payload: str, expected: bool, tmp_path: Path) -> None:
    runner = ScriptedRunner()
    runner.add(SHOW, result(stdout=payload))
    controller = lifecycle(tmp_path, runner)

    assert controller.is_active() is expected
    assert runner.calls == [SHOW]


@pytest.mark.parametrize(
    "response",
    [
        result(returncode=1, stdout=state("inactive"), stderr="fixture-secret-detail"),
        result(stdout="ActiveState=inactive\nSubState=dead\n"),
        result(stdout=state("inactive", pid=99)),
        result(stdout=state("activating", sub_state="start", pid=0)),
        result(stdout="not-systemd-output"),
    ],
)
def test_is_active_rejects_unverifiable_or_unsafe_state_without_leaking_output(response, tmp_path: Path) -> None:
    runner = ScriptedRunner()
    runner.add(SHOW, response)
    controller = lifecycle(tmp_path, runner)

    with pytest.raises(XrayLifecycleError) as raised:
        controller.is_active()

    assert "fixture-secret-detail" not in str(raised.value)


def test_ensure_inactive_accepts_failed_stop_only_after_verified_inactive(tmp_path: Path) -> None:
    runner = ScriptedRunner()
    runner.add(STOP, result(returncode=1, stderr="stop failed"))
    runner.add(SHOW, result(stdout=state("inactive")))
    controller = lifecycle(tmp_path, runner)
    controller.grant_authorization()

    controller.ensure_inactive()

    assert controller.authorization_granted() is False
    assert runner.calls == [STOP, SHOW]


def test_ensure_inactive_force_kills_when_stop_reports_success_but_xray_is_still_active(tmp_path: Path) -> None:
    runner = ScriptedRunner()
    runner.add(STOP, result(returncode=0))
    runner.add(
        SHOW,
        result(stdout=state("active", sub_state="running", pid=123)),
        result(stdout=state("inactive")),
    )
    runner.add(KILL, result(returncode=0))
    controller = lifecycle(tmp_path, runner)
    controller.grant_authorization()

    controller.ensure_inactive()

    assert runner.calls == [STOP, SHOW, KILL, SHOW]
    assert controller.authorization_granted() is False


def test_ensure_inactive_force_kills_after_failed_stop_when_state_is_active(tmp_path: Path) -> None:
    runner = ScriptedRunner()
    runner.add(STOP, result(returncode=1))
    runner.add(
        SHOW,
        result(stdout=state("active", sub_state="running", pid=321)),
        result(stdout=state("inactive")),
    )
    runner.add(KILL, result(returncode=0))
    controller = lifecycle(tmp_path, runner)

    controller.ensure_inactive()

    assert runner.calls == [STOP, SHOW, KILL, SHOW]


def test_ensure_inactive_raises_when_bounded_force_path_cannot_prove_shutdown(tmp_path: Path) -> None:
    runner = ScriptedRunner()
    runner.add(STOP, result(returncode=0))
    runner.add(
        SHOW,
        result(stdout=state("active", sub_state="running", pid=111)),
        result(stdout=state("active", sub_state="running", pid=111)),
        result(stdout=state("active", sub_state="running", pid=111)),
    )
    runner.add(KILL, result(returncode=0))
    controller = lifecycle(tmp_path, runner, poll_attempts=2)
    controller.grant_authorization()

    with pytest.raises(XrayLifecycleError):
        controller.ensure_inactive()

    assert controller.authorization_granted() is False
    assert runner.calls == [STOP, SHOW, KILL, SHOW, SHOW]


def test_restart_authorized_rejects_missing_marker(tmp_path: Path) -> None:
    runner = ScriptedRunner()
    controller = lifecycle(tmp_path, runner)

    with pytest.raises(XrayLifecycleError):
        controller.restart_authorized()

    assert runner.calls == []


def test_restart_authorized_succeeds_only_when_restart_and_active_state_are_verified(tmp_path: Path) -> None:
    runner = ScriptedRunner()
    runner.add(RESTART, result(returncode=0))
    runner.add(SHOW, result(stdout=state("active", sub_state="running", pid=555)))
    controller = lifecycle(tmp_path, runner)
    controller.grant_authorization()

    controller.restart_authorized()

    assert controller.authorization_granted() is True
    assert runner.calls == [RESTART, SHOW]


def test_restart_failure_revokes_marker_and_best_effort_closes_runtime_without_leaking_output(tmp_path: Path) -> None:
    runner = ScriptedRunner()
    runner.add(RESTART, result(returncode=1, stderr="private-value-from-systemctl"))
    runner.add(STOP, result(returncode=0))
    runner.add(SHOW, result(stdout=state("inactive")))
    controller = lifecycle(tmp_path, runner)
    controller.grant_authorization()

    with pytest.raises(XrayLifecycleError) as raised:
        controller.restart_authorized()

    assert "private-value-from-systemctl" not in str(raised.value)
    assert controller.authorization_granted() is False
    assert runner.calls == [RESTART, STOP, SHOW]


def test_post_restart_inactive_state_revokes_marker_and_closes_runtime(tmp_path: Path) -> None:
    runner = ScriptedRunner()
    runner.add(RESTART, result(returncode=0))
    runner.add(SHOW, result(stdout=state("inactive")), result(stdout=state("inactive")))
    runner.add(STOP, result(returncode=0))
    controller = lifecycle(tmp_path, runner)
    controller.grant_authorization()

    with pytest.raises(XrayLifecycleError):
        controller.restart_authorized()

    assert controller.authorization_granted() is False
    assert runner.calls == [RESTART, SHOW, STOP, SHOW]


def test_disable_is_idempotent_and_always_revokes_authorization_first(tmp_path: Path) -> None:
    runner = ScriptedRunner()
    runner.add(STOP, result(returncode=0), result(returncode=0))
    runner.add(SHOW, result(stdout=state("inactive")), result(stdout=state("inactive")))
    controller = lifecycle(tmp_path, runner)
    controller.grant_authorization()

    controller.disable()
    controller.disable()

    assert controller.authorization_granted() is False
    assert runner.calls == [STOP, SHOW, STOP, SHOW]
