from __future__ import annotations

import json
import stat
import sys
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from madar_agent.activity import XrayTrafficActivitySource
from madar_agent.api import ControlPlaneClient, HttpResponse
from madar_agent.models import AgentConfig, EnvironmentReport, UsageReport, UserTrafficCounters
from madar_agent.outbox import TelemetryOutbox
from madar_agent.service import AgentService


START = datetime(2026, 10, 10, 10, 0, 0, tzinfo=UTC)
CLIENT_ID = "27848739-7e62-4138-9fd3-098a63964b6b"
WINDOW_ID = "xray-traffic:2026-10-10T10:00Z"


@dataclass
class CapturedRequest:
    method: str
    url: str
    body: bytes | None


class FakeTransport:
    def __init__(self, *responses: HttpResponse) -> None:
        self.responses = list(responses)
        self.requests: list[CapturedRequest] = []

    def request(self, method, url, *, headers, body, timeout):
        self.requests.append(CapturedRequest(method=method, url=url, body=body))
        if not self.responses:
            raise AssertionError("unexpected HTTP request")
        return self.responses.pop(0)


def config(tmp_path: Path) -> AgentConfig:
    credential = tmp_path / "node.credential"
    credential.write_text("test-node-credential", encoding="utf-8")
    credential.chmod(stat.S_IRUSR | stat.S_IWUSR)
    return AgentConfig(api_base_url="https://control.example.test", credential_path=credential)


def masked_report() -> UsageReport:
    return UsageReport(
        client_id=CLIENT_ID,
        window_id=WINDOW_ID,
        sequence=7,
        seconds=2,
        timestamp=START + timedelta(seconds=3),
        observed_from=START,
        observed_to=START + timedelta(seconds=3),
        active_seconds_hex="0000000000000006",
    )


def test_control_plane_capability_probe_treats_authenticated_404_as_old_server(tmp_path: Path) -> None:
    transport = FakeTransport(HttpResponse(status=404, body=b'{"error":"NOT_FOUND"}'))
    client = ControlPlaneClient(config(tmp_path), transport=transport)

    assert client.supports_active_second_telemetry() is False
    assert transport.requests[0].method == "GET"
    assert transport.requests[0].url == "https://control.example.test/api/node/telemetry/capabilities"


def test_control_plane_capability_probe_requires_exact_true_capability(tmp_path: Path) -> None:
    transport = FakeTransport(HttpResponse(status=200, body=b'{"activeSecondsV1":true}'))
    client = ControlPlaneClient(config(tmp_path), transport=transport)

    assert client.supports_active_second_telemetry() is True


def test_masked_telemetry_serializes_exact_bitmap(tmp_path: Path) -> None:
    report = masked_report()
    transport = FakeTransport(HttpResponse(status=200, body=b'{"accepted":1,"duplicates":0}'))
    client = ControlPlaneClient(config(tmp_path), transport=transport)

    client.post_telemetry([report])

    body = json.loads(transport.requests[0].body or b"{}")
    assert body == {
        "reports": [{
            "clientId": CLIENT_ID,
            "windowId": WINDOW_ID,
            "sequence": 7,
            "seconds": 2,
            "timestamp": "2026-10-10T10:00:03Z",
            "observedFrom": "2026-10-10T10:00:00Z",
            "observedTo": "2026-10-10T10:00:03Z",
            "activeSecondsHex": "0000000000000006",
        }]
    }


class PendingAgent:
    def __init__(self, report: UsageReport) -> None:
        self.pending = [report]
        self.acknowledged: list[list[UsageReport]] = []

    def validate_environment(self) -> EnvironmentReport:
        return EnvironmentReport(valid=True, errors=())

    def fetch_policy(self):
        return None

    def collect_usage(self) -> list[UsageReport]:
        return list(self.pending)

    def acknowledge_usage(self, reports: list[UsageReport]) -> None:
        assert reports == self.pending
        self.acknowledged.append(list(reports))
        self.pending = []

    def is_authorization_fresh(self, now: datetime) -> bool:
        return True


class CapabilityControlPlane:
    def __init__(self, capabilities: list[bool]) -> None:
        self.capabilities = list(capabilities)
        self.probes = 0
        self.telemetry: list[list[UsageReport]] = []
        self.heartbeats = 0

    def supports_active_second_telemetry(self) -> bool:
        self.probes += 1
        if not self.capabilities:
            raise AssertionError("unexpected capability probe")
        return self.capabilities.pop(0)

    def post_telemetry(self, reports: list[UsageReport]):
        self.telemetry.append(list(reports))
        return {"accepted": len(reports), "duplicates": 0}

    def heartbeat(self, *, health, versions, capacity):
        self.heartbeats += 1
        return {"ok": True}


def service(agent: PendingAgent, control_plane) -> AgentService:
    return AgentService(
        agent=agent,
        control_plane=control_plane,
        runtime_health=lambda: True,
        disable_access=lambda: None,
        now=lambda: START,
        versions={"agent": "0.1.0", "xray": "26.3.27"},
        max_clients=128,
    )


def test_masked_pending_report_stays_intact_until_server_advertises_capability() -> None:
    report = masked_report()
    agent = PendingAgent(report)
    control = CapabilityControlPlane([False, True])
    runtime = service(agent, control)

    runtime.run_cycle()
    assert agent.pending == [report]
    assert agent.acknowledged == []
    assert control.telemetry == []

    runtime.run_cycle()
    assert control.telemetry == [[report]]
    assert agent.acknowledged == [[report]]
    assert agent.pending == []
    assert control.probes == 2


def test_legacy_pending_report_does_not_require_capability_probe() -> None:
    legacy = UsageReport(
        client_id=CLIENT_ID,
        window_id="legacy-window",
        sequence=1,
        seconds=3,
        timestamp=START,
    )
    agent = PendingAgent(legacy)
    control = CapabilityControlPlane([])

    service(agent, control).run_cycle()

    assert control.probes == 0
    assert control.telemetry == [[legacy]]
    assert agent.acknowledged == [[legacy]]


def test_scheduled_xray_activity_persists_exact_bucket_bitmap_in_outbox(tmp_path: Path) -> None:
    snapshots = iter([
        {CLIENT_ID: UserTrafficCounters(uplink_bytes=10, downlink_bytes=20)},
        {CLIENT_ID: UserTrafficCounters(uplink_bytes=11, downlink_bytes=20)},
    ])
    instants = iter([
        START + timedelta(seconds=1, milliseconds=50),
        START + timedelta(seconds=2, milliseconds=50),
    ])
    outbox = TelemetryOutbox(tmp_path / "state" / "telemetry-outbox.sqlite3")
    source = XrayTrafficActivitySource(
        read_counters=lambda: next(snapshots),
        now=lambda: next(instants),
        record_active_bucket=outbox.record_active_bucket,
    )

    source.sample(bucket_end=START + timedelta(seconds=1))
    source.sample(bucket_end=START + timedelta(seconds=2))

    reports = outbox.prepare_reports()
    assert len(reports) == 1
    assert reports[0].window_id == WINDOW_ID
    assert reports[0].seconds == 1
    assert reports[0].active_seconds_hex == "0000000000000002"
