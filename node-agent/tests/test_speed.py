from __future__ import annotations

import json
import os
import socket
import stat
import threading
from dataclasses import dataclass
from pathlib import Path

import pytest

from madar_agent.models import ManagedClient
from madar_agent.speed import (
    MAX_SPEED_KBPS,
    SpeedEnforcerAdapter,
    SpeedEnforcerError,
    derive_speed_identity,
    ensure_speed_identity_secret,
    password_verifier,
    speed_kbps_to_limits,
)


CLIENT_ID = "123e4567-e89b-12d3-a456-426614174000"
VECTOR_SECRET = bytes(range(32))
VECTOR_ALIAS = "e_D52OPzyZXSkpVpYQyw5Q"
VECTOR_PASSWORD = "xTIFjl6n47uW_jgBsyAWpUVJYRJsBcSRPmPOzC5Qz1g"
VECTOR_VERIFIER = "33120f6601a037cea1aec7588bd0d7beff756f0b84de8d717e8250d0a8ea6cb5"


@dataclass
class Result:
    returncode: int = 0
    stdout: str = ""
    stderr: str = ""


def test_identity_matches_exact_vectors_and_is_domain_separated() -> None:
    credential = derive_speed_identity(VECTOR_SECRET, CLIENT_ID)
    assert credential.client_id == CLIENT_ID
    assert credential.alias == VECTOR_ALIAS
    assert credential.password == VECTOR_PASSWORD
    assert password_verifier(credential.alias, credential.password) == VECTOR_VERIFIER
    assert len(credential.alias) == 22
    assert len(credential.password) == 43
    assert "=" not in credential.alias + credential.password
    assert credential.alias != credential.password
    assert CLIENT_ID not in credential.alias
    assert CLIENT_ID not in credential.password
    assert CLIENT_ID not in VECTOR_VERIFIER

    other = derive_speed_identity(bytes(reversed(range(32))), CLIENT_ID)
    assert other.alias != credential.alias
    assert other.password != credential.password


@pytest.mark.parametrize("secret", [b"", b"x" * 31, b"x" * 33])
def test_identity_rejects_non_32_byte_secret(secret: bytes) -> None:
    with pytest.raises(ValueError):
        derive_speed_identity(secret, CLIENT_ID)


def test_speed_conversion_is_exact_and_pins_int64_safe_bound() -> None:
    assert MAX_SPEED_KBPS == 73_786_976_294_838_206
    assert speed_kbps_to_limits(5000) == (625_000, 312_500)
    assert speed_kbps_to_limits(1) == (125, 62)
    assert speed_kbps_to_limits(MAX_SPEED_KBPS) == (
        9_223_372_036_854_775_750,
        4_611_686_018_427_387_875,
    )
    for invalid in (0, -1, MAX_SPEED_KBPS + 1, True, 1.0, "5000"):
        with pytest.raises(ValueError):
            speed_kbps_to_limits(invalid)  # type: ignore[arg-type]


def test_secret_creation_is_stable_private_regular_file(tmp_path: Path) -> None:
    path = tmp_path / "state" / "speed-identity.key"
    first = ensure_speed_identity_secret(path)
    second = ensure_speed_identity_secret(path)
    assert len(first) == 32
    assert first == second
    parent = path.parent.stat()
    secret = path.stat()
    assert stat.S_IMODE(parent.st_mode) == 0o700
    assert stat.S_ISREG(secret.st_mode)
    assert stat.S_IMODE(secret.st_mode) == 0o600
    assert secret.st_uid == os.geteuid()


def test_secret_rejects_symlink_nonregular_wrong_length_and_weak_modes(tmp_path: Path) -> None:
    state = tmp_path / "state"
    state.mkdir(mode=0o700)

    target = tmp_path / "target"
    target.write_bytes(b"x" * 32)
    target.chmod(0o600)
    symlink = state / "symlink.key"
    symlink.symlink_to(target)
    with pytest.raises(SpeedEnforcerError):
        ensure_speed_identity_secret(symlink)

    directory = state / "directory.key"
    directory.mkdir(mode=0o700)
    with pytest.raises(SpeedEnforcerError):
        ensure_speed_identity_secret(directory)

    wrong = state / "wrong.key"
    wrong.write_bytes(b"x" * 31)
    wrong.chmod(0o600)
    with pytest.raises(SpeedEnforcerError):
        ensure_speed_identity_secret(wrong)

    weak = state / "weak.key"
    weak.write_bytes(b"x" * 32)
    weak.chmod(0o644)
    with pytest.raises(SpeedEnforcerError):
        ensure_speed_identity_secret(weak)


def test_secret_rejects_overpermissive_or_symlink_state_root(tmp_path: Path) -> None:
    weak_state = tmp_path / "weak-state"
    weak_state.mkdir(mode=0o755)
    with pytest.raises(SpeedEnforcerError):
        ensure_speed_identity_secret(weak_state / "speed-identity.key")

    real_state = tmp_path / "real-state"
    real_state.mkdir(mode=0o700)
    linked_state = tmp_path / "linked-state"
    linked_state.symlink_to(real_state, target_is_directory=True)
    with pytest.raises(SpeedEnforcerError):
        ensure_speed_identity_secret(linked_state / "speed-identity.key")


def _serve_health_once(path: Path, body: bytes, *, status: bytes = b"200 OK") -> threading.Thread:
    ready = threading.Event()

    def worker() -> None:
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            server.bind(str(path))
            os.chmod(path, 0o600)
            server.listen(1)
            ready.set()
            conn, _ = server.accept()
            with conn:
                conn.recv(4096)
                response = (
                    b"HTTP/1.1 " + status + b"\r\n"
                    b"Content-Type: application/json\r\n"
                    b"Connection: close\r\n"
                    b"Content-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body
                )
                conn.sendall(response)
        finally:
            server.close()
            path.unlink(missing_ok=True)

    thread = threading.Thread(target=worker, daemon=True)
    thread.start()
    assert ready.wait(1)
    return thread


def _adapter(
    tmp_path: Path,
    *,
    run=None,
    events: list[str] | None = None,
    health_probe=None,
) -> SpeedEnforcerAdapter:
    events = events if events is not None else []
    return SpeedEnforcerAdapter(
        state_root=tmp_path / "state",
        binary=tmp_path / "madar-speed-enforcer",
        health_socket=tmp_path / "health.sock",
        run=run or (lambda _args: Result()),
        authorize_runtime=lambda: events.append("authorize"),
        revoke_runtime_authorization=lambda: events.append("revoke"),
        reload=lambda: events.append("reload"),
        is_active=lambda: True,
        disable_runtime=lambda: events.append("disable"),
        health_probe=health_probe,
    )


def test_apply_free_renders_private_verifier_only_config_and_orders_activation(tmp_path: Path) -> None:
    events: list[str] = []
    seen: dict[str, object] = {}

    def run(args: list[str]) -> Result:
        events.append("validate")
        candidate = Path(args[2])
        assert args == [str(tmp_path / "madar-speed-enforcer"), "--config", str(candidate), "--test"]
        assert candidate.name == "speed-enforcer.json.candidate"
        assert stat.S_IMODE(candidate.stat().st_mode) == 0o600
        seen["candidate"] = json.loads(candidate.read_text())
        assert not (tmp_path / "state" / "speed-enforcer.json").exists()
        return Result()

    adapter = _adapter(
        tmp_path,
        run=run,
        events=events,
        health_probe=lambda generation: events.append(f"health:{generation}") or True,
    )
    routes = adapter.apply_clients([ManagedClient(CLIENT_ID, "free", 5000)], generation=17)

    assert events == ["validate", "authorize", "reload", "health:17"]
    assert adapter.required is True
    assert set(routes) == {CLIENT_ID}
    credential = routes[CLIENT_ID]
    live = tmp_path / "state" / "speed-enforcer.json"
    assert stat.S_IMODE(live.stat().st_mode) == 0o600
    payload = json.loads(live.read_text())
    assert payload == seen["candidate"]
    assert payload["generation"] == 17
    assert payload["listener"] == "127.0.0.1:10808"
    assert payload["healthSocket"] == str(tmp_path / "health.sock")
    assert payload["clients"] == [
        {
            "alias": credential.alias,
            "passwordVerifier": password_verifier(credential.alias, credential.password),
            "uploadBytesPerSecond": 625_000,
            "uploadBurstBytes": 312_500,
            "downloadBytesPerSecond": 625_000,
            "downloadBurstBytes": 312_500,
        }
    ]
    rendered = live.read_text()
    assert CLIENT_ID not in rendered
    assert credential.password not in rendered


def test_apply_rejects_invalid_tier_speed_shapes_before_side_effects(tmp_path: Path) -> None:
    calls: list[list[str]] = []
    adapter = _adapter(tmp_path, run=lambda args: calls.append(args) or Result(), health_probe=lambda _: True)
    invalid = [
        ManagedClient(CLIENT_ID, "free", None),
        ManagedClient(CLIENT_ID, "free", 0),
        ManagedClient(CLIENT_ID, "free", MAX_SPEED_KBPS + 1),
        ManagedClient(CLIENT_ID, "free", True),  # type: ignore[arg-type]
        ManagedClient(CLIENT_ID, "premium", 5000),
    ]
    for client in invalid:
        with pytest.raises(SpeedEnforcerError):
            adapter.apply_clients([client], generation=1)
    assert calls == []
    assert not (tmp_path / "state" / "speed-enforcer.json").exists()


def test_premium_only_policy_disables_sidecar_and_requires_no_secret(tmp_path: Path) -> None:
    events: list[str] = []
    adapter = _adapter(tmp_path, events=events, health_probe=lambda _: True)
    routes = adapter.apply_clients([ManagedClient(CLIENT_ID, "premium", None)], generation=9)
    assert routes == {}
    assert adapter.required is False
    assert events == ["revoke", "disable"]
    assert not (tmp_path / "state" / "speed-identity.key").exists()


def test_validation_failure_closes_runtime_does_not_promote_and_does_not_leak(tmp_path: Path) -> None:
    events: list[str] = []
    logs: list[str] = []
    adapter = SpeedEnforcerAdapter(
        state_root=tmp_path / "state",
        binary=tmp_path / "madar-speed-enforcer",
        health_socket=tmp_path / "health.sock",
        run=lambda _args: Result(returncode=1, stderr=f"bad {CLIENT_ID}"),
        authorize_runtime=lambda: events.append("authorize"),
        revoke_runtime_authorization=lambda: events.append("revoke"),
        reload=lambda: events.append("reload"),
        is_active=lambda: True,
        disable_runtime=lambda: events.append("disable"),
        log=logs.append,
        health_probe=lambda _: True,
    )
    with pytest.raises(SpeedEnforcerError):
        adapter.apply_clients([ManagedClient(CLIENT_ID, "free", 5000)], generation=3)
    assert events == ["revoke", "disable"]
    assert adapter.required is False
    assert not (tmp_path / "state" / "speed-enforcer.json").exists()
    assert not (tmp_path / "state" / "speed-enforcer.json.candidate").exists()
    assert all(CLIENT_ID not in line for line in logs)


def test_activation_health_failure_closes_runtime_after_promotion(tmp_path: Path) -> None:
    events: list[str] = []
    adapter = _adapter(
        tmp_path,
        events=events,
        health_probe=lambda generation: events.append(f"health:{generation}") or False,
    )
    with pytest.raises(SpeedEnforcerError):
        adapter.apply_clients([ManagedClient(CLIENT_ID, "free", 5000)], generation=4)
    assert events == ["authorize", "reload", "health:4", "revoke", "disable"]
    assert adapter.required is False
    assert (tmp_path / "state" / "speed-enforcer.json").is_file()


def test_health_requires_active_runtime_exact_generation_and_strict_shape(tmp_path: Path) -> None:
    adapter = _adapter(tmp_path)
    adapter._required = True

    thread = _serve_health_once(tmp_path / "health.sock", b'{"generation":12,"ready":true}')
    assert adapter.health(12) is True
    thread.join(1)

    for body in (
        b'{"generation":11,"ready":true}',
        b'{"generation":12,"ready":false}',
        b'{"generation":12,"ready":true,"alias":"leak"}',
        b'{"generation":true,"ready":true}',
        b'not-json',
    ):
        thread = _serve_health_once(tmp_path / "health.sock", body)
        assert adapter.health(12) is False
        thread.join(1)

    thread = _serve_health_once(tmp_path / "health.sock", b'{"generation":12,"ready":true}', status=b"503 Service Unavailable")
    assert adapter.health(12) is False
    thread.join(1)


def test_health_is_false_when_systemd_runtime_is_inactive(tmp_path: Path) -> None:
    adapter = SpeedEnforcerAdapter(
        state_root=tmp_path / "state",
        binary=tmp_path / "binary",
        health_socket=tmp_path / "health.sock",
        run=lambda _args: Result(),
        authorize_runtime=lambda: None,
        revoke_runtime_authorization=lambda: None,
        reload=lambda: None,
        is_active=lambda: False,
        disable_runtime=lambda: None,
    )
    adapter._required = True
    assert adapter.health(1) is False
