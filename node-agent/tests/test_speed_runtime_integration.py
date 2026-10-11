from __future__ import annotations

import stat
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from madar_agent.agent import NodeAgent
from madar_agent.lifecycle import SystemdSpeedEnforcerLifecycle
from madar_agent.models import AgentConfig, Policy, PolicyClient, SpeedRouteCredential

UTC = timezone.utc
NOW = datetime(2026, 10, 11, 9, 10, tzinfo=UTC)


class FakeApi:
    def __init__(self) -> None:
        self.known: list[int] = []

    def fetch_policy(self, known_revision: int):
        self.known.append(known_revision)
        return None


class FakeEnvironment:
    def operating_system(self):
        return ("ubuntu", "24.04")

    def architecture(self):
        return "x86_64"


class FakeSpeed:
    def __init__(self, events: list[str], *, fail: bool = False) -> None:
        self.events = events
        self.fail = fail
        self.disable_calls = 0
        self.required = False
        self.routes = {
            "free-client": SpeedRouteCredential(
                client_id="free-client",
                alias="opaque-route",
                password="fixture-route-password",
            )
        }

    def apply_clients(self, clients, generation: int):
        self.events.append(f"speed:{generation}")
        if self.fail:
            raise RuntimeError("speed failed")
        self.required = any(client.tier == "free" for client in clients)
        return dict(self.routes) if self.required else {}

    def disable_managed_access(self):
        self.disable_calls += 1
        self.required = False
        self.events.append("speed:disable")

    def health(self, expected_generation: int):
        return self.required and expected_generation > 0


class FakeXray:
    def __init__(self, events: list[str], *, fail: bool = False) -> None:
        self.events = events
        self.fail = fail
        self.applied = []
        self.disable_calls = 0

    def apply_clients(self, clients, routes):
        self.events.append("xray")
        self.applied.append((list(clients), dict(routes)))
        if self.fail:
            raise RuntimeError("xray failed")

    def disable_managed_access(self):
        self.disable_calls += 1
        self.events.append("xray:disable")

    def collect_observed_activity(self):
        return []

    def health(self):
        return True


def make_policy(*, revision: int = 7, free_speed: int | None = 5000) -> Policy:
    return Policy(
        revision=revision,
        valid_until=NOW + timedelta(minutes=5),
        clients=(
            PolicyClient(
                user_id="free-user",
                policy_revision=revision,
                client_id="free-client",
                tier="free",
                speed_kbps=free_speed,
            ),
            PolicyClient(
                user_id="premium-user",
                policy_revision=revision,
                client_id="premium-client",
                tier="premium",
                speed_kbps=None,
            ),
        ),
    )


def make_agent(tmp_path: Path, speed: FakeSpeed, xray: FakeXray) -> NodeAgent:
    credential = tmp_path / "node.credential"
    credential.write_text("fixture", encoding="utf-8")
    credential.chmod(0o600)
    return NodeAgent(
        AgentConfig(api_base_url="https://control.example.test", credential_path=credential),
        api=FakeApi(),
        xray=xray,
        speed_enforcer=speed,
        environment=FakeEnvironment(),
        now=lambda: NOW,
    )


def test_policy_apply_is_speed_before_xray_and_commits_revision_only_after_both(tmp_path: Path) -> None:
    events: list[str] = []
    speed = FakeSpeed(events)
    xray = FakeXray(events)
    agent = make_agent(tmp_path, speed, xray)

    result = agent.apply_policy(make_policy())

    assert result.applied is True
    assert events[:2] == ["speed:7", "xray"]
    assert xray.applied[0][1] == speed.routes
    assert agent.is_authorization_fresh(NOW) is True
    agent.fetch_policy()
    assert agent.api.known == [7]


def test_invalid_policy_is_rejected_before_either_runtime_side_effect(tmp_path: Path) -> None:
    events: list[str] = []
    speed = FakeSpeed(events)
    xray = FakeXray(events)
    agent = make_agent(tmp_path, speed, xray)

    result = agent.apply_policy(make_policy(free_speed=0))

    assert result.applied is False
    assert result.reason == "invalid_policy"
    assert events == ["xray:disable", "speed:disable"]
    assert xray.applied == []


def test_xray_failure_after_speed_success_closes_both_and_does_not_advance_revision(tmp_path: Path) -> None:
    events: list[str] = []
    speed = FakeSpeed(events)
    xray = FakeXray(events, fail=True)
    agent = make_agent(tmp_path, speed, xray)

    with pytest.raises(RuntimeError, match="xray failed"):
        agent.apply_policy(make_policy(revision=9))

    assert events == ["speed:9", "xray", "xray:disable", "speed:disable"]
    assert agent.is_authorization_fresh(NOW) is False
    agent.fetch_policy()
    assert agent.api.known == [0]


def test_speed_failure_never_promotes_xray(tmp_path: Path) -> None:
    events: list[str] = []
    speed = FakeSpeed(events, fail=True)
    xray = FakeXray(events)
    agent = make_agent(tmp_path, speed, xray)

    with pytest.raises(RuntimeError, match="speed failed"):
        agent.apply_policy(make_policy())

    assert xray.applied == []
    assert "xray" not in events


def test_combined_disable_orders_xray_before_speed(tmp_path: Path) -> None:
    events: list[str] = []
    speed = FakeSpeed(events)
    xray = FakeXray(events)
    agent = make_agent(tmp_path, speed, xray)

    agent.disable_managed_access()

    assert events == ["xray:disable", "speed:disable"]


def test_speed_lifecycle_uses_sidecar_unit_and_private_marker(tmp_path: Path) -> None:
    calls: list[tuple[str, ...]] = []
    runtime = tmp_path / "run" / "madar-node-agent"
    runtime.mkdir(parents=True)
    marker = runtime / "speed-enforcer-authorized"

    def run(argv: list[str]):
        calls.append(tuple(argv))
        if argv[:2] == ["systemctl", "restart"]:
            return SimpleNamespace(returncode=0, stdout="", stderr="")
        if argv[:2] == ["systemctl", "show"]:
            return SimpleNamespace(
                returncode=0,
                stdout="ActiveState=active\nSubState=running\nMainPID=123\n",
                stderr="",
            )
        raise AssertionError(argv)

    lifecycle = SystemdSpeedEnforcerLifecycle(run=run, marker_path=marker)
    lifecycle.grant_authorization()
    lifecycle.restart_authorized()

    assert marker.read_text(encoding="utf-8") == "authorized\n"
    assert stat.S_IMODE(marker.stat().st_mode) == 0o600
    assert calls[0] == ("systemctl", "restart", "madar-speed-enforcer.service")
    assert calls[1][0:3] == ("systemctl", "show", "madar-speed-enforcer.service")


def test_sidecar_systemd_unit_is_agent_bound_and_not_boot_installable() -> None:
    unit = Path(__file__).resolve().parents[1] / "systemd" / "madar-speed-enforcer.service"
    text = unit.read_text(encoding="utf-8")
    assert "BindsTo=madar-node-agent.service" in text
    assert "ConditionPathExists=/etc/madar-node-agent/speed-enforcer.json" in text
    assert "ConditionPathExists=/run/madar-node-agent/speed-enforcer-authorized" in text
    assert "ExecStart=/opt/madar-speed-enforcer/madar-speed-enforcer --config /etc/madar-node-agent/speed-enforcer.json" in text
    assert "[Install]" not in text
