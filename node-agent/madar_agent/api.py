from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
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


class TransientTransportError(RuntimeError):
    pass


class TransientApiError(RuntimeError):
    def __init__(self, status: int) -> None:
        super().__init__(f"control-plane request temporarily failed with HTTP {status}")
        self.status = status


class PermanentApiError(RuntimeError):
    def __init__(self, status: int, code: str | None = None) -> None:
        message = f"control-plane request failed with HTTP {status}"
        if code:
            message += f" ({code})"
        super().__init__(message)
        self.status = status
        self.code = code


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
        request = urllib.request.Request(url, data=body, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return HttpResponse(status=response.status, body=response.read())
        except urllib.error.HTTPError as error:
            return HttpResponse(status=error.code, body=error.read())
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            raise TransientTransportError("control-plane transport failed") from error


def _decode_json(response: HttpResponse) -> object:
    if not response.body:
        return None
    try:
        return json.loads(response.body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise PermanentApiError(response.status, "RESPONSE_INVALID") from error


def _error_code(response: HttpResponse) -> str | None:
    try:
        decoded = _decode_json(response)
    except PermanentApiError:
        return None
    if isinstance(decoded, dict):
        code = decoded.get("error")
        return code if isinstance(code, str) else None
    return None


def _is_transient_status(status: int) -> bool:
    return status in {408, 425, 429} or 500 <= status <= 599


def _parse_iso(value: object) -> datetime:
    if not isinstance(value, str):
        raise PermanentApiError(200, "POLICY_INVALID")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise PermanentApiError(200, "POLICY_INVALID") from error
    if parsed.tzinfo is None:
        raise PermanentApiError(200, "POLICY_INVALID")
    return parsed.astimezone(timezone.utc)


def _parse_policy(payload: object) -> Policy:
    if not isinstance(payload, dict):
        raise PermanentApiError(200, "POLICY_INVALID")
    revision = payload.get("revision")
    clients = payload.get("clients")
    if not isinstance(revision, int) or revision < 1 or not isinstance(clients, list):
        raise PermanentApiError(200, "POLICY_INVALID")

    parsed_clients: list[PolicyClient] = []
    for raw in clients:
        if not isinstance(raw, dict):
            raise PermanentApiError(200, "POLICY_INVALID")
        user_id = raw.get("userId")
        policy_revision = raw.get("policyRevision")
        client_id = raw.get("clientId")
        tier = raw.get("tier")
        speed_kbps = raw.get("speedKbps")
        if (
            not isinstance(user_id, str)
            or not user_id
            or not isinstance(policy_revision, int)
            or policy_revision < 1
            or not isinstance(client_id, str)
            or not client_id
            or tier not in {"free", "premium"}
            or (speed_kbps is not None and (not isinstance(speed_kbps, int) or speed_kbps <= 0))
        ):
            raise PermanentApiError(200, "POLICY_INVALID")
        parsed_clients.append(
            PolicyClient(
                user_id=user_id,
                policy_revision=policy_revision,
                client_id=client_id,
                tier=tier,
                speed_kbps=speed_kbps,
            )
        )

    return Policy(
        revision=revision,
        valid_until=_parse_iso(payload.get("validUntil")),
        clients=tuple(parsed_clients),
    )


def _iso_z(value: datetime) -> str:
    if value.tzinfo is None:
        raise ValueError("datetime must be timezone-aware")
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _serialize_usage(report: UsageReport) -> dict[str, object]:
    payload: dict[str, object] = {
        "clientId": report.client_id,
        "windowId": report.window_id,
        "sequence": report.sequence,
        "seconds": report.seconds,
        "timestamp": _iso_z(report.timestamp),
    }
    if report.observed_from is not None:
        payload["observedFrom"] = _iso_z(report.observed_from)
    if report.observed_to is not None:
        payload["observedTo"] = _iso_z(report.observed_to)
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
        return decoded
