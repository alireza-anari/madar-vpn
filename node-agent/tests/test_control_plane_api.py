from __future__ import annotations

import json
import stat
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from madar_agent.api import ControlPlaneClient, HttpResponse, PermanentApiError
from madar_agent.models import AgentConfig, UsageReport
from madar_agent.retry import RetryPolicy


UTC = timezone.utc


@dataclass
class CapturedRequest:
    method: str
    url: str
    headers: dict[str, str]
    body: bytes | None
    timeout: float


class FakeTransport:
    def __init__(self, *responses: HttpResponse) -> None:
        self.responses = list(responses)
        self.requests: list[CapturedRequest] = []

    def request(self, method, url, *, headers, body, timeout):
        self.requests.append(CapturedRequest(method, url, dict(headers), body, timeout))
        if not self.responses:
            raise AssertionError("unexpected HTTP request")
        return self.responses.pop(0)


def config(tmp_path: Path, credential: str = "node-super-secret") -> AgentConfig:
    path = tmp_path / "node.credential"
    path.write_text(credential, encoding="utf-8")
    path.chmod(stat.S_IRUSR | stat.S_IWUSR)
    return AgentConfig(api_base_url="https://control.example.test", credential_path=path)


def usage_report(*, sequence: int = 3) -> UsageReport:
    return UsageReport(
        client_id="client-free",
        window_id="window-1",
        sequence=sequence,
        seconds=12,
        timestamp=datetime(2026, 10, 8, 13, 0, 12, tzinfo=UTC),
        session_id="session-1",
    )


def test_fetch_policy_uses_bearer_auth_and_parses_control_plane_shape(tmp_path: Path) -> None:
    transport = FakeTransport(HttpResponse(
        status=200,
        body=json.dumps({
            "revision": 4,
            "validUntil": "2026-10-08T13:05:00.000Z",
            "clients": [
                {
                    "userId": "user-free",
                    "policyRevision": 7,
                    "clientId": "client-free",
                    "tier": "free",
                    "speedKbps": 256,
                },
                {
                    "userId": "user-premium",
                    "policyRevision": 3,
                    "clientId": "client-premium",
                    "tier": "premium",
                    "speedKbps": None,
                },
            ],
        }).encode(),
    ))
    client = ControlPlaneClient(config(tmp_path), transport=transport)

    policy = client.fetch_policy(2)

    assert policy is not None
    assert policy.revision == 4
    assert policy.valid_until == datetime(2026, 10, 8, 13, 5, tzinfo=UTC)
    assert policy.clients[0].speed_kbps == 256
    assert policy.clients[1].tier == "premium"
    request = transport.requests[0]
    assert request.method == "GET"
    assert request.url == "https://control.example.test/api/node/policy?knownRevision=2"
    assert request.headers["Authorization"] == "Bearer node-super-secret"
    assert request.body is None


def test_fetch_policy_returns_none_on_204_and_retries_only_transient_server_errors(tmp_path: Path) -> None:
    sleeps: list[float] = []
    transport = FakeTransport(
        HttpResponse(status=503, body=b'{"error":"temporary"}'),
        HttpResponse(status=204, body=b""),
    )
    client = ControlPlaneClient(
        config(tmp_path),
        transport=transport,
        retry_policy=RetryPolicy(max_attempts=3, base_delay_seconds=0.1, max_delay_seconds=0.2),
        sleep=sleeps.append,
    )

    assert client.fetch_policy(4) is None
    assert len(transport.requests) == 2
    assert sleeps == [0.1]


def test_permanent_errors_never_expose_node_credential(tmp_path: Path) -> None:
    secret = "credential-that-must-not-leak"
    transport = FakeTransport(HttpResponse(status=401, body=b'{"error":"NODE_CREDENTIAL_INVALID"}'))
    client = ControlPlaneClient(config(tmp_path, secret), transport=transport)

    with pytest.raises(PermanentApiError) as raised:
        client.fetch_policy(0)

    assert secret not in str(raised.value)
    assert len(transport.requests) == 1


def test_ack_heartbeat_and_telemetry_use_expected_server_contract_without_extra_fields(tmp_path: Path) -> None:
    transport = FakeTransport(
        HttpResponse(status=200, body=b'{"acknowledged":true,"revision":4}'),
        HttpResponse(status=200, body=b'{"id":"node-1","status":"ready"}'),
        HttpResponse(status=200, body=b'{"accepted":1,"duplicates":0}'),
    )
    client = ControlPlaneClient(config(tmp_path), transport=transport)

    assert client.ack_policy(4) == {"acknowledged": True, "revision": 4}
    heartbeat = client.heartbeat(
        health={"healthy": True, "ready": True},
        versions={"agent": "1.0.0", "xray": "test-double"},
        capacity={"accepting": True, "activeClients": 2, "maxClients": 100},
    )
    assert heartbeat["status"] == "ready"
    result = client.post_telemetry([usage_report()])
    assert result == {"accepted": 1, "duplicates": 0}

    ack_body = json.loads(transport.requests[0].body or b"{}")
    heartbeat_body = json.loads(transport.requests[1].body or b"{}")
    telemetry_body = json.loads(transport.requests[2].body or b"{}")
    assert ack_body == {"revision": 4}
    assert heartbeat_body == {
        "health": {"healthy": True, "ready": True},
        "versions": {"agent": "1.0.0", "xray": "test-double"},
        "capacity": {"accepting": True, "activeClients": 2, "maxClients": 100},
    }
    assert telemetry_body == {
        "reports": [{
            "clientId": "client-free",
            "windowId": "window-1",
            "sequence": 3,
            "seconds": 12,
            "timestamp": "2026-10-08T13:00:12Z",
            "sessionId": "session-1",
        }]
    }


def test_telemetry_duplicate_response_counts_as_complete_acceptance(tmp_path: Path) -> None:
    transport = FakeTransport(HttpResponse(status=200, body=b'{"accepted":0,"duplicates":1}'))
    client = ControlPlaneClient(config(tmp_path), transport=transport)

    assert client.post_telemetry([usage_report()]) == {"accepted": 0, "duplicates": 1}


@pytest.mark.parametrize(
    "body",
    [
        b'{"accepted":1}',
        b'{"accepted":0,"duplicates":0}',
        b'{"accepted":2,"duplicates":0}',
        b'{"accepted":-1,"duplicates":2}',
        b'{"accepted":true,"duplicates":0}',
        b'{"accepted":1,"duplicates":"0"}',
    ],
)
def test_telemetry_response_must_account_for_every_report_before_outbox_can_ack(
    tmp_path: Path,
    body: bytes,
) -> None:
    transport = FakeTransport(HttpResponse(status=200, body=body))
    client = ControlPlaneClient(config(tmp_path), transport=transport)

    with pytest.raises(PermanentApiError) as raised:
        client.post_telemetry([usage_report()])

    assert raised.value.status == 200
    assert "RESPONSE_INVALID" in str(raised.value)
