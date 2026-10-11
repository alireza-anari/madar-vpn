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
    def __init__(self, events: list[str]) -> None:
        self.events = events
        self.disable_calls = 0
        self.required = False
        self.healthy = True
        self.calls = 0
        self.fail_on_call: int | None = None
        self.snapshots: list[list[str]] = []

    def apply_clients(self, clients, generation: int):
        self.calls += 1
        free = sorted(client.client_id for client in clients if client.tier == "free")
        self.snapshots.append(free)
        self.events.append(f"speed:{generation}:{','.join(free)}")
        if self.fail_on_call == self.calls:
            raise RuntimeError("speed failed")
        self.required = bool(free)
        return {
            client.client_id: SpeedRouteCredential(
                client_id=client.client_id,
                alias=f"opaque-{client.client_id}",
                password=f"fixture-password-{client.client_id}",
            )
            for client in clients
            if client.tier == "free"
        }

    def disable_managed_access(self):
        self.disable_calls += 1
        self.required = False
        self.events.append("speed:disable")

    def health(self, expected_generation: int):
        return self.healthy and self.required and expected_generation > 0


class FakeXray:
    def __init__(self, events: list[str], *, fail: bool = False) -> None:
        self.events = events
        self.fail = fail
        self.healthy = True
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
        return self.healthy


def client(client_id: str, tier: str, revision: int, speed: int | None = None) -> PolicyClient:
    return PolicyClient(
        user_id=f"user-{client_id}",
        policy_revision=revision,
        client_id=client_id,
        tier=tier,
        speed_kbps=speed,
    )


def make_policy(
    *,
    revision: int = 7,
    clients: tuple[PolicyClient, ...] | None = None,
    free_speed: int | None = 5000,
) -> Policy:
    if clients is None:
        clients = (
            client("free-client", "free", revision, free_speed),
            client("premium-client", "premium", revision, None),
        )
    return Policy(
        revision=revision,
        valid_until=NOW + timedelta(minutes=5),
        clients=clients,
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


def test_policy_apply_is_sidecar_xray_prune_and_commits_revision_only_after_all_three(tmp_path: Path) -> None:
    events: list[str] = []
    speed = FakeSpeed(events)
    xray = FakeXray(events)
    agent = make_agent(tmp_path, speed, xray)

    result = agent.apply_policy(make_policy())

    assert result.applied is True
    assert events == ["speed:7:free-client", "xray", "speed:7:free-client"]
    assert set(xray.applied[0][1]) == {"free-client"}
    assert agent.is_authorization_fresh(NOW) is True
    agent.fetch_policy()
    assert agent.api.known == [7]


def test_invalid_policy_is_rejected_before_either_runtime_promotion(tmp_path: Path) -> None:
    events: list[str] = []
    speed = FakeSpeed(events)
    xray = FakeXray(events)
    agent = make_agent(tmp_path, speed, xray)

    result = agent.apply_policy(make_policy(free_speed=0))

    assert result.applied is False
    assert result.reason == "invalid_policy"
    assert events == ["xray:disable", "speed:disable"]
    assert xray.applied == []
    assert speed.snapshots == []


def test_client_id_rotation_keeps_old_alias_through_xray_switch_then_prunes_before_revision_commit(tmp_path: Path) -> None:
    events: list[str] = []
    speed = FakeSpeed(events)
    xray = FakeXray(events)
    agent = make_agent(tmp_path, speed, xray)
    old = make_policy(
        revision=7,
        clients=(client("old-free", "free", 7, 5000),),
    )
    agent.apply_policy(old)
    events.clear()
    speed.snapshots.clear()

    rotated = make_policy(
        revision=8,
        clients=(client("new-free", "free", 8, 5000),),
    )
    result = agent.apply_policy(rotated)

    assert result.applied is True
    assert events == ["speed:8:new-free,old-free", "xray", "speed:8:new-free"]
    assert speed.snapshots == [["new-free", "old-free"], ["new-free"]]
    assert set(xray.applied[-1][1]) == {"new-free"}
    agent.fetch_policy()
    assert agent.api.known[-1] == 8


def test_free_to_premium_retains_old_limiter_until_xray_direct_switch(tmp_path: Path) -> None:
    events: list[str] = []
    speed = FakeSpeed(events)
    xray = FakeXray(events)
    agent = make_agent(tmp_path, speed, xray)
    agent.apply_policy(
        make_policy(revision=7, clients=(client("same-client", "free", 7, 5000),))
    )
    events.clear()
    speed.snapshots.clear()

    result = agent.apply_policy(
        make_policy(revision=8, clients=(client("same-client", "premium", 8, None),))
    )

    assert result.applied is True
    assert events == ["speed:8:same-client", "xray", "speed:8:"]
    assert speed.snapshots == [["same-client"], []]
    assert xray.applied[-1][1] == {}
    assert speed.required is False


def test_premium_to_free_prepares_limiter_before_xray_switch(tmp_path: Path) -> None:
    events: list[str] = []
    speed = FakeSpeed(events)
    xray = FakeXray(events)
    agent = make_agent(tmp_path, speed, xray)
    agent.apply_policy(
        make_policy(revision=7, clients=(client("same-client", "premium", 7, None),))
    )
    events.clear()
    speed.snapshots.clear()

    result = agent.apply_policy(
        make_policy(revision=8, clients=(client("same-client", "free", 8, 5000),))
    )

    assert result.applied is True
    assert events == ["speed:8:same-client", "xray", "speed:8:same-client"]
    assert speed.snapshots[0] == ["same-client"]
    assert set(xray.applied[-1][1]) == {"same-client"}


def test_final_prune_failure_closes_both_keeps_previous_revision_and_allows_retry(tmp_path: Path) -> None:
    events: list[str] = []
    speed = FakeSpeed(events)
    xray = FakeXray(events)
    agent = make_agent(tmp_path, speed, xray)
    agent.apply_policy(
        make_policy(revision=7, clients=(client("old-free", "free", 7, 5000),))
    )
    events.clear()
    speed.fail_on_call = speed.calls + 2

    candidate = make_policy(
        revision=8,
        clients=(client("new-free", "free", 8, 5000),),
    )
    with pytest.raises(RuntimeError, match="speed failed"):
        agent.apply_policy(candidate)

    assert events == [
        "speed:8:new-free,old-free",
        "xray",
        "speed:8:new-free",
        "xray:disable",
        "speed:disable",
    ]
    agent.fetch_policy()
    assert agent.api.known[-1] == 7

    speed.fail_on_call = None
    events.clear()
    assert agent.apply_policy(candidate).applied is True
    agent.fetch_policy()
    assert agent.api.known[-1] == 8


def test_xray_failure_after_speed_stage_closes_both_and_does_not_advance_revision(tmp_path: Path) -> None:
    events: list[str] = []
    speed = FakeSpeed(events)
    xray = FakeXray(events, fail=True)
    agent = make_agent(tmp_path, speed, xray)

    with pytest.raises(RuntimeError, match="xray failed"):
        agent.apply_policy(make_policy(revision=9))

    assert events == [
        "speed:9:free-client",
        "xray",
        "xray:disable",
        "speed:disable",
    ]
    assert agent.is_authorization_fresh(NOW) is False
    agent.fetch_policy()
    assert agent.api.known == [0]


def test_speed_stage_failure_never_promotes_xray(tmp_path: Path) -> None:
    events: list[str] = []
    speed = FakeSpeed(events)
    speed.fail_on_call = 1
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


def test_runtime_health_requires_sidecar_only_while_current_policy_has_free_clients(tmp_path: Path) -> None:
    events: list[str] = []
    speed = FakeSpeed(events)
    xray = FakeXray(events)
    agent = make_agent(tmp_path, speed, xray)
    agent.apply_policy(make_policy(revision=7, clients=(client("free", "free", 7, 5000),)))
    speed.healthy = False
    assert agent.runtime_health() is False

    speed.healthy = True
    agent.apply_policy(make_policy(revision=8, clients=(client("premium", "premium", 8, None),)))
    speed.healthy = False
    assert speed.required is False
    assert agent.runtime_health() is True


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
