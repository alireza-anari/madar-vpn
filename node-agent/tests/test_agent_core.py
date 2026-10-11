from __future__ import annotations

import stat
import sys
import pytest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from madar_agent.agent import NodeAgent
from madar_agent.models import (
    AgentConfig,
    ObservedActivity,
    Policy,
    PolicyClient,
    SpeedRouteCredential,
)
from madar_agent.retry import RetryExhausted


UTC = timezone.utc
NOW = datetime(2026, 10, 8, 13, 0, tzinfo=UTC)


class FakeEnvironment:
    def __init__(self, *, distro: str = "ubuntu", version: str = "24.04", machine: str = "x86_64") -> None:
        self.distro = distro
        self.version = version
        self.machine = machine

    def operating_system(self) -> tuple[str, str]:
        return self.distro, self.version

    def architecture(self) -> str:
        return self.machine


class FakeApi:
    def __init__(self, policy: Policy | None = None) -> None:
        self.policy = policy
        self.known_revisions: list[int] = []

    def fetch_policy(self, known_revision: int) -> Policy | None:
        self.known_revisions.append(known_revision)
        return self.policy


class FakeXray:
    def __init__(self, observed: list[ObservedActivity] | None = None) -> None:
        self.applied: list[tuple[list[object], dict[str, SpeedRouteCredential]]] = []
        self.disable_calls = 0
        self.observed = observed or []

    def apply_clients(self, clients, speed_routes=None):
        self.applied.append((list(clients), dict(speed_routes or {})))

    def disable_managed_access(self) -> None:
        self.disable_calls += 1

    def collect_observed_activity(self) -> list[ObservedActivity]:
        return list(self.observed)

    def health(self) -> bool:
        return True


class FakeSpeed:
    def __init__(self) -> None:
        self.applied: list[tuple[list[object], int]] = []
        self.disable_calls = 0
        self.required = False

    def apply_clients(self, clients, generation: int):
        snapshot = list(clients)
        self.applied.append((snapshot, generation))
        self.required = any(client.tier == "free" for client in snapshot)
        return {
            client.client_id: SpeedRouteCredential(
                client_id=client.client_id,
                alias=f"alias-{client.client_id}",
                password=f"password-{client.client_id}",
            )
            for client in snapshot
            if client.tier == "free"
        }

    def disable_managed_access(self) -> None:
        self.disable_calls += 1
        self.required = False

    def health(self, expected_generation: int) -> bool:
        return expected_generation > 0


def policy(*, revision: int = 4, valid_for: int = 300) -> Policy:
    return Policy(
        revision=revision,
        valid_until=NOW + timedelta(seconds=valid_for),
        clients=(
            PolicyClient(
                user_id="user-free",
                policy_revision=7,
                client_id="client-free",
                tier="free",
                speed_kbps=256,
            ),
            PolicyClient(
                user_id="user-premium",
                policy_revision=3,
                client_id="client-premium",
                tier="premium",
                speed_kbps=None,
            ),
        ),
    )


def make_agent(
    tmp_path: Path,
    *,
    environment: FakeEnvironment | None = None,
    xray: FakeXray | None = None,
    speed: FakeSpeed | None = None,
    api: FakeApi | None = None,
    now=lambda: NOW,
) -> NodeAgent:
    credential = tmp_path / "node.credential"
    credential.write_text("test-node-credential", encoding="utf-8")
    credential.chmod(stat.S_IRUSR | stat.S_IWUSR)
    return NodeAgent(
        AgentConfig(
            api_base_url="https://control.example.test",
            credential_path=credential,
        ),
        api=api or FakeApi(),
        xray=xray or FakeXray(),
        speed_enforcer=speed or FakeSpeed(),
        environment=environment or FakeEnvironment(),
        now=now,
    )


def test_validate_environment_rejects_unsupported_ubuntu_and_loose_credential_permissions(tmp_path: Path) -> None:
    credential = tmp_path / "node.credential"
    credential.write_text("test-node-credential", encoding="utf-8")
    credential.chmod(0o644)
    agent = NodeAgent(
        AgentConfig(api_base_url="https://control.example.test", credential_path=credential),
        api=FakeApi(),
        xray=FakeXray(),
        speed_enforcer=FakeSpeed(),
        environment=FakeEnvironment(version="20.04"),
        now=lambda: NOW,
    )

    report = agent.validate_environment()

    assert report.valid is False
    assert "unsupported_ubuntu" in report.errors
    assert "credential_permissions" in report.errors


def test_apply_policy_keeps_free_speed_cap_distinct_from_uncapped_premium(tmp_path: Path) -> None:
    xray = FakeXray()
    speed = FakeSpeed()
    agent = make_agent(tmp_path, xray=xray, speed=speed)

    result = agent.apply_policy(policy())

    assert result.applied is True
    assert result.disabled is False
    assert len(xray.applied) == 1
    clients, routes = xray.applied[0]
    free, premium = clients
    assert free.client_id == "client-free"
    assert free.tier == "free"
    assert free.speed_kbps == 256
    assert premium.client_id == "client-premium"
    assert premium.tier == "premium"
    assert premium.speed_kbps is None
    assert set(routes) == {"client-free"}
    assert len(speed.applied) == 2
    assert agent.is_authorization_fresh(NOW) is True


def test_stale_policy_disables_managed_access_fail_closed(tmp_path: Path) -> None:
    xray = FakeXray()
    speed = FakeSpeed()
    agent = make_agent(tmp_path, xray=xray, speed=speed)
    stale = policy(valid_for=-1)

    result = agent.apply_policy(stale)

    assert result.applied is False
    assert result.disabled is True
    assert result.reason == "stale_policy"
    assert xray.disable_calls == 1
    assert speed.disable_calls == 1
    assert agent.is_authorization_fresh(NOW) is False


def test_policy_refresh_disables_access_when_existing_authorization_expires_without_new_policy(tmp_path: Path) -> None:
    current = NOW
    xray = FakeXray()
    speed = FakeSpeed()
    api = FakeApi(policy=None)
    agent = make_agent(tmp_path, xray=xray, speed=speed, api=api, now=lambda: current)
    agent.apply_policy(policy(valid_for=60))
    assert xray.disable_calls == 0

    current = NOW + timedelta(seconds=61)
    refreshed = agent.fetch_policy()

    assert refreshed is None
    assert api.known_revisions == [4]
    assert xray.disable_calls == 1
    assert speed.disable_calls == 1
    assert agent.is_authorization_fresh(current) is False


def test_collect_usage_assigns_monotonic_sequence_per_window(tmp_path: Path) -> None:
    xray = FakeXray([
        ObservedActivity(
            client_id="client-free",
            window_id="window-2026-10-08T13:00Z",
            seconds=4,
            timestamp=NOW,
            session_id="session-a",
        ),
        ObservedActivity(
            client_id="client-premium",
            window_id="window-2026-10-08T13:00Z",
            seconds=7,
            timestamp=NOW + timedelta(seconds=7),
            session_id="session-b",
        ),
    ])
    agent = make_agent(tmp_path, xray=xray)

    first = agent.collect_usage()
    second = agent.collect_usage()

    assert [report.sequence for report in first] == [1, 2]
    assert [report.sequence for report in second] == [3, 4]
    assert {report.client_id for report in first} == {"client-free", "client-premium"}
    assert all(report.window_id == "window-2026-10-08T13:00Z" for report in first)


@pytest.mark.parametrize("expire_during_request", [False, True])
def test_policy_fetch_outage_cannot_leave_expired_access_enabled(tmp_path: Path, expire_during_request: bool) -> None:
    current = NOW
    xray = FakeXray()
    speed = FakeSpeed()

    class UnavailableApi:
        def fetch_policy(self, known_revision: int) -> Policy | None:
            nonlocal current
            assert known_revision == 4
            if not expire_during_request:
                assert xray.disable_calls == 1, "expired access must close before network retry"
                assert speed.disable_calls == 1
            current = NOW + timedelta(seconds=61)
            raise RetryExhausted("control plane unavailable")

    agent = make_agent(tmp_path, xray=xray, speed=speed, api=UnavailableApi(), now=lambda: current)
    agent.apply_policy(policy(valid_for=60))
    if not expire_during_request:
        current = NOW + timedelta(seconds=61)
    with pytest.raises(RetryExhausted):
        agent.fetch_policy()
    assert xray.disable_calls == 1
    assert speed.disable_calls == 1


def test_startup_closes_persisted_access_before_policy_network_request(tmp_path: Path) -> None:
    xray = FakeXray()
    speed = FakeSpeed()

    class UnavailableApi:
        def fetch_policy(self, known_revision: int) -> Policy | None:
            assert known_revision == 0
            assert xray.disable_calls == 1
            assert speed.disable_calls == 1
            raise RetryExhausted("control plane unavailable")

    agent = make_agent(tmp_path, xray=xray, speed=speed, api=UnavailableApi())
    with pytest.raises(RetryExhausted):
        agent.fetch_policy()
    assert xray.disable_calls == 1
    assert speed.disable_calls == 1
