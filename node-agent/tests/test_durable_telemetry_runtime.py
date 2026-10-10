from __future__ import annotations

import stat
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import madar_agent.service as service_module
from madar_agent.agent import NodeAgent
from madar_agent.config import XrayRuntimeSettings
from madar_agent.models import AgentConfig, EnvironmentReport, UsageReport, UserTrafficCounters
from madar_agent.outbox import TelemetryOutbox
from madar_agent.service import AgentService


NOW = datetime(2026, 10, 10, 9, 0, tzinfo=UTC)
CLIENT_ID = "27848739-7e62-4138-9fd3-098a63964b6b"
WINDOW_ID = "xray-traffic:2026-10-10T09:00Z"


class FakeEnvironment:
    def operating_system(self) -> tuple[str, str]:
        return ("ubuntu", "24.04")

    def architecture(self) -> str:
        return "x86_64"


class FakeApi:
    def fetch_policy(self, known_revision: int):
        return None


class FakeXray:
    def apply_clients(self, clients) -> None:
        return None

    def disable_managed_access(self) -> None:
        return None

    def collect_observed_activity(self):
        return []


def build_node_agent(tmp_path: Path, outbox: TelemetryOutbox) -> NodeAgent:
    credential = tmp_path / "node.credential"
    credential.write_text("test-node-credential", encoding="utf-8")
    credential.chmod(stat.S_IRUSR | stat.S_IWUSR)
    return NodeAgent(
        AgentConfig(
            api_base_url="https://control.example.test",
            credential_path=credential,
        ),
        api=FakeApi(),
        xray=FakeXray(),
        environment=FakeEnvironment(),
        now=lambda: NOW,
        outbox=outbox,
    )


def record(outbox: TelemetryOutbox, *, seconds: int, at: datetime) -> None:
    outbox.record_activity(
        client_id=CLIENT_ID,
        window_id=WINDOW_ID,
        seconds=seconds,
        timestamp=at,
        observed_from=at - timedelta(seconds=seconds),
        observed_to=at,
        session_id=None,
    )


def test_node_agent_outbox_keeps_report_identity_across_restart_and_advances_after_ack(tmp_path: Path) -> None:
    path = tmp_path / "telemetry-outbox.sqlite3"
    first_outbox = TelemetryOutbox(path)
    record(first_outbox, seconds=4, at=NOW)
    first_agent = build_node_agent(tmp_path, first_outbox)

    first = first_agent.collect_usage()
    retry = first_agent.collect_usage()

    assert retry == first
    assert len(first) == 1
    assert first[0].window_id == WINDOW_ID
    assert first[0].sequence == 1
    assert first[0].seconds == 4

    restarted = build_node_agent(tmp_path, TelemetryOutbox(path))
    assert restarted.collect_usage() == first

    restarted.acknowledge_usage(first)
    record(TelemetryOutbox(path), seconds=2, at=NOW + timedelta(seconds=10))

    after_ack_restart = build_node_agent(tmp_path, TelemetryOutbox(path))
    next_reports = after_ack_restart.collect_usage()
    assert len(next_reports) == 1
    assert next_reports[0].window_id == WINDOW_ID
    assert next_reports[0].sequence == 2
    assert next_reports[0].seconds == 2


class DurableFakeAgent:
    def __init__(self, report: UsageReport) -> None:
        self.pending = [report]
        self.acknowledged: list[list[UsageReport]] = []
        self.collects = 0

    def validate_environment(self) -> EnvironmentReport:
        return EnvironmentReport(valid=True, errors=())

    def fetch_policy(self):
        return None

    def collect_usage(self) -> list[UsageReport]:
        self.collects += 1
        return list(self.pending)

    def acknowledge_usage(self, reports: list[UsageReport]) -> None:
        assert reports == self.pending
        self.acknowledged.append(list(reports))
        self.pending = []

    def is_authorization_fresh(self, now: datetime) -> bool:
        return True


class FakeControlPlane:
    def __init__(self) -> None:
        self.telemetry: list[list[UsageReport]] = []
        self.heartbeats: list[dict[str, object]] = []

    def post_telemetry(self, reports: list[UsageReport]) -> dict[str, object]:
        self.telemetry.append(list(reports))
        return {"accepted": len(reports)}

    def heartbeat(self, *, health, versions, capacity) -> dict[str, object]:
        self.heartbeats.append({"health": health, "versions": versions, "capacity": capacity})
        return {"ok": True}


def test_service_acknowledges_durable_report_only_after_successful_post() -> None:
    report = UsageReport(
        client_id=CLIENT_ID,
        window_id=WINDOW_ID,
        sequence=1,
        seconds=3,
        timestamp=NOW,
    )
    agent = DurableFakeAgent(report)
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
    service.run_cycle()

    assert control.telemetry == [[report]]
    assert agent.acknowledged == [[report]]
    assert agent.collects == 2


def test_build_agent_service_wires_single_outbox_to_sampler_and_agent(monkeypatch, tmp_path: Path) -> None:
    credential_path = tmp_path / "etc" / "madar-node-agent" / "node.credential"
    binary = tmp_path / "opt" / "madar-xray" / "26.3.27" / "xray"
    agent_config = AgentConfig(
        api_base_url="https://control.example.test",
        credential_path=credential_path,
        request_timeout_seconds=10.0,
    )
    runtime = XrayRuntimeSettings(
        binary=binary,
        version="26.3.27",
        port=443,
        server_name="edge.example.test",
        reality_target="origin.example.test:443",
        reality_short_id="0123456789abcdef",
        max_clients=128,
    )
    created: dict[str, object] = {}

    class FakeOutbox:
        def __init__(self, path: Path) -> None:
            self.path = path
            created["outbox"] = self

        def record_activity(self, **payload) -> None:
            return None

        def prepare_reports(self):
            return []

        def acknowledge(self, reports) -> None:
            return None

    class FakeClient:
        def __init__(self, config) -> None:
            created["client"] = self

    class FakeSource:
        def __init__(self, *, read_counters, now, max_gap_seconds=2.5, record_activity=None) -> None:
            self.read_counters = read_counters
            self.now = now
            self.record_activity = record_activity
            created["source"] = self

        def sample(self) -> None:
            return None

        def invalidate(self) -> None:
            return None

        def drain(self):
            return []

    class FakeXrayAdapter:
        def __init__(self, **kwargs) -> None:
            created["xray"] = self
            self.kwargs = kwargs

        def read_user_traffic_counters(self):
            return {CLIENT_ID: UserTrafficCounters(uplink_bytes=1, downlink_bytes=2)}

        def health(self) -> bool:
            return True

        def disable_managed_access(self) -> None:
            return None

    class FakeWorker:
        def __init__(self, *, source, interval_seconds) -> None:
            self.source = source
            self.interval_seconds = interval_seconds
            created["worker"] = self

        def start(self) -> None:
            return None

        def stop(self) -> None:
            return None

    class FakeNodeAgent:
        def __init__(self, config, *, api, xray, environment=None, now, outbox=None) -> None:
            self.outbox = outbox
            created["agent"] = self

    monkeypatch.setattr(service_module, "load_config", lambda: agent_config)
    monkeypatch.setattr(service_module, "load_runtime_config", lambda: runtime)
    monkeypatch.setattr(service_module, "TelemetryOutbox", FakeOutbox, raising=False)
    monkeypatch.setattr(service_module, "ControlPlaneClient", FakeClient)
    monkeypatch.setattr(service_module, "XrayTrafficActivitySource", FakeSource)
    monkeypatch.setattr(service_module, "PinnedXrayAdapter", FakeXrayAdapter)
    monkeypatch.setattr(service_module, "ActivitySamplerWorker", FakeWorker)
    monkeypatch.setattr(service_module, "NodeAgent", FakeNodeAgent)

    service_module.build_agent_service()

    outbox = created["outbox"]
    source = created["source"]
    agent = created["agent"]
    assert outbox.path == credential_path.parent / "telemetry-outbox.sqlite3"
    assert getattr(source.record_activity, "__self__", None) is outbox
    assert agent.outbox is outbox
