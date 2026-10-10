from __future__ import annotations

import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from madar_agent.models import ApplyResult, EnvironmentReport, Policy, PolicyClient, UsageReport
from madar_agent.service import AgentService


NOW = datetime(2026, 10, 9, 15, 0, tzinfo=UTC)
CLIENT_ID = "27848739-7e62-4138-9fd3-098a63964b6b"


def policy(*, revision: int = 4) -> Policy:
    return Policy(
        revision=revision,
        valid_until=NOW + timedelta(minutes=5),
        clients=(
            PolicyClient(
                user_id="user-1",
                policy_revision=revision,
                client_id=CLIENT_ID,
                tier="free",
                speed_kbps=5000,
            ),
        ),
    )


class FakeAgent:
    def __init__(
        self,
        *,
        next_policy: Policy | None,
        environment_valid: bool = True,
        fresh: bool = True,
        apply_result: ApplyResult | None = None,
    ) -> None:
        self.next_policy = next_policy
        self.environment_valid = environment_valid
        self.fresh = fresh
        self.apply_result = apply_result
        self.applied: list[Policy] = []
        self.fetches = 0
        self.collects = 0
        self.usage = [
            UsageReport(
                client_id=CLIENT_ID,
                window_id="window-1",
                sequence=1,
                seconds=30,
                timestamp=NOW,
            )
        ]

    def validate_environment(self) -> EnvironmentReport:
        return EnvironmentReport(
            valid=self.environment_valid,
            errors=() if self.environment_valid else ("unsupported_ubuntu",),
        )

    def fetch_policy(self) -> Policy | None:
        self.fetches += 1
        return self.next_policy

    def apply_policy(self, value: Policy) -> ApplyResult:
        self.applied.append(value)
        if self.apply_result is not None:
            return self.apply_result
        return ApplyResult(applied=True, disabled=False, reason="applied", revision=value.revision)

    def collect_usage(self) -> list[UsageReport]:
        self.collects += 1
        return list(self.usage)

    def is_authorization_fresh(self, now: datetime) -> bool:
        assert now == NOW
        return self.fresh


class FakeControlPlane:
    def __init__(self) -> None:
        self.acks: list[int] = []
        self.telemetry: list[list[UsageReport]] = []
        self.heartbeats: list[dict[str, object]] = []

    def ack_policy(self, revision: int) -> dict[str, object]:
        self.acks.append(revision)
        return {"acked": revision}

    def post_telemetry(self, reports: list[UsageReport]) -> dict[str, object]:
        self.telemetry.append(list(reports))
        return {"accepted": len(reports)}

    def heartbeat(self, *, health, versions, capacity) -> dict[str, object]:
        self.heartbeats.append({"health": health, "versions": versions, "capacity": capacity})
        return {"ok": True}


def build_service(agent, control) -> AgentService:
    return AgentService(
        agent=agent,
        control_plane=control,
        runtime_health=lambda: True,
        disable_access=lambda: None,
        now=lambda: NOW,
        versions={"agent": "0.1.0", "xray": "26.3.27"},
        max_clients=128,
    )


def test_cycle_applies_policy_acks_posts_telemetry_and_reports_real_readiness() -> None:
    agent = FakeAgent(next_policy=policy())
    control = FakeControlPlane()
    disabled: list[bool] = []
    service = AgentService(
        agent=agent,
        control_plane=control,
        runtime_health=lambda: True,
        disable_access=lambda: disabled.append(True),
        now=lambda: NOW,
        versions={"agent": "0.1.0", "xray": "26.3.27"},
        max_clients=128,
    )

    service.run_cycle()

    assert agent.applied == [policy()]
    assert control.acks == [4]
    assert control.telemetry == [agent.usage]
    assert disabled == []
    assert control.heartbeats == [
        {
            "health": {"healthy": True, "ready": True},
            "versions": {"agent": "0.1.0", "xray": "26.3.27"},
            "capacity": {"accepting": True, "activeClients": 1, "maxClients": 128},
        }
    ]


def test_failed_telemetry_post_retries_the_same_batch_before_draining_new_usage() -> None:
    agent = FakeAgent(next_policy=None)
    original = list(agent.usage)
    attempts: list[list[UsageReport]] = []

    class FlakyControlPlane(FakeControlPlane):
        def post_telemetry(self, reports: list[UsageReport]) -> dict[str, object]:
            attempts.append(list(reports))
            if len(attempts) == 1:
                raise RuntimeError("fixture telemetry outage")
            return {"accepted": len(reports)}

    control = FlakyControlPlane()
    service = build_service(agent, control)

    with pytest.raises(RuntimeError, match="fixture telemetry outage"):
        service.run_cycle()

    agent.usage = [
        UsageReport(
            client_id=CLIENT_ID,
            window_id="window-1",
            sequence=2,
            seconds=15,
            timestamp=NOW + timedelta(seconds=30),
        )
    ]
    service.run_cycle()

    assert attempts == [original, original]
    assert agent.collects == 1

    service.run_cycle()
    assert attempts[-1] == agent.usage
    assert agent.collects == 2


def test_invalid_environment_fails_closed_without_fetching_or_acking_policy() -> None:
    agent = FakeAgent(next_policy=policy(), environment_valid=False)
    control = FakeControlPlane()
    disabled: list[bool] = []
    service = AgentService(
        agent=agent,
        control_plane=control,
        runtime_health=lambda: True,
        disable_access=lambda: disabled.append(True),
        now=lambda: NOW,
        versions={"agent": "0.1.0", "xray": "26.3.27"},
        max_clients=128,
    )

    service.run_cycle()

    assert disabled == [True]
    assert agent.fetches == 0
    assert control.acks == []
    assert control.telemetry == []
    assert control.heartbeats[0]["health"] == {"healthy": False, "ready": False}
    assert control.heartbeats[0]["capacity"] == {"accepting": False, "activeClients": 0, "maxClients": 128}


def test_stale_authorization_is_not_advertised_ready_even_when_runtime_is_healthy() -> None:
    agent = FakeAgent(next_policy=None, fresh=False)
    control = FakeControlPlane()
    service = AgentService(
        agent=agent,
        control_plane=control,
        runtime_health=lambda: True,
        disable_access=lambda: None,
        now=lambda: NOW,
        versions={"agent": "0.1.0", "xray": "26.3.27"},
        max_clients=128,
    )

    service.run_cycle()

    assert control.acks == []
    assert control.heartbeats[0]["health"] == {"healthy": True, "ready": False}
    assert control.heartbeats[0]["capacity"]["accepting"] is False


def test_failed_policy_application_is_not_acked_or_advertised_ready() -> None:
    agent = FakeAgent(
        next_policy=policy(),
        fresh=True,
        apply_result=ApplyResult(
            applied=False,
            disabled=True,
            reason="invalid_policy",
            revision=4,
        ),
    )
    control = FakeControlPlane()
    service = AgentService(
        agent=agent,
        control_plane=control,
        runtime_health=lambda: True,
        disable_access=lambda: None,
        now=lambda: NOW,
        versions={"agent": "0.1.0", "xray": "26.3.27"},
        max_clients=128,
    )

    service.run_cycle()

    assert control.acks == []
    assert control.heartbeats[0]["health"] == {"healthy": True, "ready": False}
    assert control.heartbeats[0]["capacity"] == {"accepting": False, "activeClients": 0, "maxClients": 128}
