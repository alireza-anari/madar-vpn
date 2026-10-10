from __future__ import annotations

import json
import socket
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime
from typing import Callable, Protocol
from urllib.parse import urlencode

from .models import AgentConfig, Policy, PolicyClient, UsageReport
from .retry import RetryPolicy, run_with_retry


@dataclass(frozen=True, slots=True)
class HttpResponse:
    status: int
    body: bytes


class HttpTransport(Protocol):
    def request(
        self,
        method: str,
        url: str,
        *,
        headers: dict[str, str],
        body: bytes | None,
        timeout: float,
    ) -> HttpResponse: ...


class TransientApiError(RuntimeError):
    def __init__(self, status: int) -> None:
        self.status = status
        super().__init__(f"transient control-plane HTTP {status}")


class TransientTransportError(RuntimeError):
    pass


class PermanentApiError(RuntimeError):
    def __init__(self, status: int, code: str) -> None:
        self.status = status
        self.code = code
        super().__init__(f"control-plane request rejected: HTTP {status} {code}")


class UrlLibTransport:
    def request(
        self,
        method: str,
        url: str,
        *,
        headers: dict[str, str],
        body: bytes | None,
        timeout: float,
    ) -> HttpResponse:
        request = urllib.request.Request(
            url,
            data=body,
            headers=headers,
            method=method,
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return HttpResponse(status=response.status, body=response.read())
        except urllib.error.HTTPError as error:
            try:
                payload = error.read()
            except OSError:
                payload = b""
            return HttpResponse(status=error.code, body=payload)
        except (urllib.error.URLError, TimeoutError, socket.timeout, OSError) as error:
            raise TransientTransportError("control-plane transport unavailable") from error


def _is_transient_status(status: int) -> bool:
    return status == 429 or 500 <= status <= 599


def _decode_json(response: HttpResponse) -> object:
    try:
        return json.loads(response.body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise PermanentApiError(response.status, "RESPONSE_INVALID") from error


def _error_code(response: HttpResponse) -> str:
    try:
        decoded = _decode_json(response)
    except PermanentApiError:
        return "REQUEST_REJECTED"
    if isinstance(decoded, dict):
        value = decoded.get("error")
        if isinstance(value, str) and value:
            return value[:128]
    return "REQUEST_REJECTED"


def _parse_timestamp(value: object) -> datetime:
    if not isinstance(value, str) or not value:
        raise ValueError("timestamp must be a non-empty string")
    normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
    parsed = datetime.fromisoformat(normalized)
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("timestamp must be timezone-aware")
    return parsed


def _parse_policy(payload: object) -> Policy:
    if not isinstance(payload, dict):
        raise PermanentApiError(200, "RESPONSE_INVALID")
    try:
        revision = payload["revision"]
        valid_until = _parse_timestamp(payload["validUntil"])
        raw_clients = payload["clients"]
        if not isinstance(revision, int) or revision < 0 or not isinstance(raw_clients, list):
            raise ValueError("invalid policy shape")
        clients: list[PolicyClient] = []
        for raw in raw_clients:
            if not isinstance(raw, dict):
                raise ValueError("invalid client shape")
            speed = raw.get("speedKbps")
            if speed is not None and (not isinstance(speed, int) or speed <= 0):
                raise ValueError("invalid speed")
            clients.append(
                PolicyClient(
                    user_id=str(raw["userId"]),
                    policy_revision=int(raw["policyRevision"]),
                    client_id=str(raw["clientId"]),
                    tier=str(raw["tier"]),
                    speed_kbps=speed,
                )
            )
        return Policy(
            revision=revision,
            valid_until=valid_until,
            clients=tuple(clients),
        )
    except (KeyError, TypeError, ValueError) as error:
        raise PermanentApiError(200, "RESPONSE_INVALID") from error


def _serialize_timestamp(value: datetime) -> str:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("timestamp must be timezone-aware")
    return value.isoformat().replace("+00:00", "Z")


def _serialize_usage(report: UsageReport) -> dict[str, object]:
    payload: dict[str, object] = {
        "clientId": report.client_id,
        "windowId": report.window_id,
        "sequence": report.sequence,
        "seconds": report.seconds,
        "timestamp": _serialize_timestamp(report.timestamp),
    }
    if report.observed_from is not None:
        payload["observedFrom"] = _serialize_timestamp(report.observed_from)
    if report.observed_to is not None:
        payload["observedTo"] = _serialize_timestamp(report.observed_to)
    if report.session_id is not None:
        payload["sessionId"] = report.session_id
    return payload


class ControlPlaneClient:
    def __init__(
        self,
        config: AgentConfig,
        *,
        transport: HttpTransport | None = None,
        retry_policy: RetryPolicy | None = None,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.config = config
        self.transport = transport or UrlLibTransport()
        self.retry_policy = retry_policy or RetryPolicy()
        self.sleep = sleep

    def _credential(self) -> str:
        try:
            value = self.config.credential_path.read_text(encoding="utf-8").strip()
        except OSError as error:
            raise PermanentApiError(0, "NODE_CREDENTIAL_UNREADABLE") from error
        if len(value) < 8 or len(value) > 4096:
            raise PermanentApiError(0, "NODE_CREDENTIAL_INVALID")
        return value

    def _request(
        self,
        method: str,
        path: str,
        *,
        payload: dict[str, object] | None = None,
        accepted_statuses: frozenset[int] = frozenset({200}),
    ) -> HttpResponse:
        body = None if payload is None else json.dumps(payload, separators=(",", ":")).encode("utf-8")

        def attempt() -> HttpResponse:
            response = self.transport.request(
                method,
                f"{self.config.api_base_url}{path}",
                headers={
                    "Authorization": f"Bearer {self._credential()}",
                    "Accept": "application/json",
                    **({"Content-Type": "application/json"} if body is not None else {}),
                },
                body=body,
                timeout=self.config.request_timeout_seconds,
            )
            if response.status in accepted_statuses:
                return response
            if _is_transient_status(response.status):
                raise TransientApiError(response.status)
            raise PermanentApiError(response.status, _error_code(response))

        return run_with_retry(
            attempt,
            policy=self.retry_policy,
            retryable=lambda error: isinstance(error, (TransientApiError, TransientTransportError)),
            sleep=self.sleep,
        )

    def fetch_policy(self, known_revision: int) -> Policy | None:
        if known_revision < 0:
            raise ValueError("known_revision must not be negative")
        query = urlencode({"knownRevision": known_revision})
        response = self._request(
            "GET",
            f"/api/node/policy?{query}",
            accepted_statuses=frozenset({200, 204}),
        )
        if response.status == 204:
            return None
        return _parse_policy(_decode_json(response))

    def ack_policy(self, revision: int) -> dict[str, object]:
        response = self._request("POST", "/api/node/policy/ack", payload={"revision": revision})
        decoded = _decode_json(response)
        if not isinstance(decoded, dict):
            raise PermanentApiError(response.status, "RESPONSE_INVALID")
        return decoded

    def heartbeat(
        self,
        *,
        health: dict[str, object],
        versions: dict[str, object],
        capacity: dict[str, object],
    ) -> dict[str, object]:
        response = self._request(
            "POST",
            "/api/node/heartbeat",
            payload={"health": health, "versions": versions, "capacity": capacity},
        )
        decoded = _decode_json(response)
        if not isinstance(decoded, dict):
            raise PermanentApiError(response.status, "RESPONSE_INVALID")
        return decoded

    def post_telemetry(self, reports: list[UsageReport]) -> dict[str, object]:
        response = self._request(
            "POST",
            "/api/node/telemetry",
            payload={"reports": [_serialize_usage(report) for report in reports]},
        )
        decoded = _decode_json(response)
        if not isinstance(decoded, dict):
            raise PermanentApiError(response.status, "RESPONSE_INVALID")

        accepted = decoded.get("accepted")
        duplicates = decoded.get("duplicates")
        if (
            type(accepted) is not int
            or type(duplicates) is not int
            or accepted < 0
            or duplicates < 0
            or accepted + duplicates != len(reports)
        ):
            raise PermanentApiError(response.status, "RESPONSE_INVALID")
        return decoded
