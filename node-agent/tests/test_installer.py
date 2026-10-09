from __future__ import annotations

import json
import stat
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from madar_agent.api import HttpResponse
from madar_agent.installer import EnrollmentFailed, HttpEnrollmentClient, InstallPaths, NodeInstaller


class FakeEnrollment:
    def __init__(self, *, credential: str = "node-issued-credential", fail: bool = False) -> None:
        self.credential = credential
        self.fail = fail
        self.tokens: list[str] = []

    def enroll(self, token: str) -> str:
        self.tokens.append(token)
        if self.fail:
            raise EnrollmentFailed("enrollment rejected")
        return self.credential


class FakeTransport:
    def __init__(self, response: HttpResponse) -> None:
        self.response = response
        self.requests = []

    def request(self, method, url, *, headers, body, timeout):
        self.requests.append((method, url, dict(headers), body, timeout))
        return self.response


class FakeSystem:
    def __init__(self) -> None:
        self.actions: list[tuple[str, tuple[str, ...]]] = []
        self.service_active = False

    def install_files(self, source: Path, destination: Path) -> None:
        self.actions.append(("install_files", (str(source), str(destination))))

    def install_service(self, source: Path, destination: Path) -> None:
        self.actions.append(("install_service", (str(source), str(destination))))

    def daemon_reload(self) -> None:
        self.actions.append(("daemon_reload", ()))

    def enable_and_start(self, service: str) -> None:
        self.actions.append(("enable_and_start", (service,)))
        self.service_active = True

    def restart(self, service: str) -> None:
        self.actions.append(("restart", (service,)))

    def stop_and_disable(self, service: str) -> None:
        self.actions.append(("stop_and_disable", (service,)))
        self.service_active = False

    def remove_path(self, path: Path) -> None:
        self.actions.append(("remove_path", (str(path),)))

    def service_status(self, service: str) -> str:
        self.actions.append(("service_status", (service,)))
        return "active" if self.service_active else "inactive"


def paths(tmp_path: Path) -> InstallPaths:
    return InstallPaths(
        source_root=tmp_path / "source",
        install_root=tmp_path / "opt" / "madar-node-agent",
        state_root=tmp_path / "etc" / "madar-node-agent",
        credential_path=tmp_path / "etc" / "madar-node-agent" / "node.credential",
        service_source=tmp_path / "source" / "systemd" / "madar-node-agent.service",
        service_path=tmp_path / "etc" / "systemd" / "system" / "madar-node-agent.service",
    )


def test_http_enrollment_sends_token_only_as_bearer_and_returns_issued_credential() -> None:
    token = "one-time-enrollment-secret"
    transport = FakeTransport(HttpResponse(
        status=201,
        body=b'{"rawCredential":"issued-node-credential","node":{"id":"node-1"}}',
    ))
    client = HttpEnrollmentClient(
        api_base_url="https://control.example.test",
        capabilities={"agent": "0.1.0", "xray": "unavailable"},
        public_config={
            "address": "203.0.113.10",
            "port": 443,
            "serverName": "edge.example.test",
            "realityPublicKey": "public-key",
            "realityShortId": "a1b2c3d4",
        },
        transport=transport,
    )

    assert client.enroll(token) == "issued-node-credential"
    method, url, headers, body, _ = transport.requests[0]
    assert method == "POST"
    assert url == "https://control.example.test/api/node/enroll"
    assert headers["Authorization"] == f"Bearer {token}"
    decoded = json.loads(body)
    assert decoded["capabilities"]["xray"] == "unavailable"
    assert token not in json.dumps(decoded)


def test_http_enrollment_prepares_xray_public_config_lazily_and_drops_secret_fields() -> None:
    prepared: list[bool] = []
    transport = FakeTransport(HttpResponse(
        status=201,
        body=b'{"rawCredential":"issued-node-credential","node":{"id":"node-1"}}',
    ))

    def public_config() -> dict[str, object]:
        prepared.append(True)
        return {
            "address": "203.0.113.10",
            "port": 443,
            "serverName": "edge.example.test",
            "realityPublicKey": "generated-public-key",
            "realityShortId": "0123456789abcdef",
            "realityPrivateKey": "must-never-leave-vps",
            "rawCredential": "must-never-be-sent",
        }

    client = HttpEnrollmentClient(
        api_base_url="https://control.example.test",
        capabilities={"agent": "0.1.0", "xray": "26.3.27"},
        public_config=public_config,
        transport=transport,
    )

    assert prepared == []
    assert client.enroll("one-time-enrollment-secret") == "issued-node-credential"
    assert prepared == [True]

    decoded = json.loads(transport.requests[0][3])
    assert decoded["publicConfig"] == {
        "address": "203.0.113.10",
        "port": 443,
        "serverName": "edge.example.test",
        "realityPublicKey": "generated-public-key",
        "realityShortId": "0123456789abcdef",
    }
    serialized = json.dumps(decoded)
    assert "must-never-leave-vps" not in serialized
    assert "must-never-be-sent" not in serialized


def test_http_enrollment_error_does_not_echo_one_time_token() -> None:
    token = "one-time-enrollment-secret"
    transport = FakeTransport(HttpResponse(status=401, body=b'{"error":"NODE_ENROLLMENT_TOKEN_INVALID"}'))
    client = HttpEnrollmentClient(
        api_base_url="https://control.example.test",
        capabilities={},
        public_config={
            "address": "203.0.113.10",
            "port": 443,
            "serverName": "edge.example.test",
            "realityPublicKey": "public-key",
            "realityShortId": "a1b2c3d4",
        },
        transport=transport,
    )

    with pytest.raises(EnrollmentFailed) as raised:
        client.enroll(token)
    assert token not in str(raised.value)


def test_install_explains_sensitive_changes_and_never_echoes_enrollment_token(tmp_path: Path) -> None:
    output: list[str] = []
    enrollment = FakeEnrollment()
    system = FakeSystem()
    installer = NodeInstaller(paths(tmp_path), enrollment=enrollment, system=system, output=output.append)
    token = "one-time-enrollment-secret"

    installer.install(token)

    joined = "\n".join(output)
    assert "credential" in joined.lower()
    assert "systemd" in joined.lower()
    assert "ssh" in joined.lower()
    assert "firewall" in joined.lower()
    assert "will not modify" in joined.lower()
    assert token not in joined
    assert enrollment.tokens == [token]
    assert system.actions[-1] == ("enable_and_start", ("madar-node-agent.service",))


def test_install_writes_credential_with_owner_only_permissions_before_service_start(tmp_path: Path) -> None:
    enrollment = FakeEnrollment(credential="credential-from-control-plane")
    system = FakeSystem()
    install_paths = paths(tmp_path)
    installer = NodeInstaller(install_paths, enrollment=enrollment, system=system, output=lambda _: None)

    installer.install("one-time-token")

    assert install_paths.credential_path.read_text(encoding="utf-8") == "credential-from-control-plane\n"
    assert stat.S_IMODE(install_paths.credential_path.stat().st_mode) == 0o600
    start_index = system.actions.index(("enable_and_start", ("madar-node-agent.service",)))
    assert start_index > system.actions.index(("daemon_reload", ()))


def test_failed_enrollment_never_enables_or_starts_service_and_leaves_no_credential(tmp_path: Path) -> None:
    enrollment = FakeEnrollment(fail=True)
    system = FakeSystem()
    install_paths = paths(tmp_path)
    installer = NodeInstaller(install_paths, enrollment=enrollment, system=system, output=lambda _: None)

    with pytest.raises(EnrollmentFailed):
        installer.install("bad-token")

    assert not any(action == "enable_and_start" for action, _ in system.actions)
    assert system.service_active is False
    assert not install_paths.credential_path.exists()


def test_status_update_and_remove_have_explicit_lifecycle_behavior(tmp_path: Path) -> None:
    enrollment = FakeEnrollment()
    system = FakeSystem()
    install_paths = paths(tmp_path)
    installer = NodeInstaller(install_paths, enrollment=enrollment, system=system, output=lambda _: None)

    assert installer.status() == "inactive"
    installer.update()
    assert ("restart", ("madar-node-agent.service",)) in system.actions

    install_paths.credential_path.parent.mkdir(parents=True, exist_ok=True)
    install_paths.credential_path.write_text("secret\n", encoding="utf-8")
    installer.remove()
    assert ("stop_and_disable", ("madar-node-agent.service",)) in system.actions
    assert ("remove_path", (str(install_paths.credential_path),)) in system.actions
    assert ("remove_path", (str(install_paths.install_root),)) in system.actions
    assert ("remove_path", (str(install_paths.service_path),)) in system.actions


def test_xray_service_is_staged_but_not_enabled_before_policy_and_remove_cleans_runtime(tmp_path: Path) -> None:
    enrollment = FakeEnrollment()
    system = FakeSystem()
    install_paths = paths(tmp_path)
    installer = NodeInstaller(install_paths, enrollment=enrollment, system=system, output=lambda _: None)
    xray_service_source = install_paths.service_source.parent / "madar-xray.service"
    xray_service_path = install_paths.service_path.parent / "madar-xray.service"
    xray_install_root = install_paths.install_root.parent / "madar-xray"

    installer.install("one-time-token")

    assert ("install_service", (str(xray_service_source), str(xray_service_path))) in system.actions
    assert ("enable_and_start", ("madar-xray.service",)) not in system.actions

    installer.remove()

    assert ("stop_and_disable", ("madar-xray.service",)) in system.actions
    assert ("remove_path", (str(xray_service_path),)) in system.actions
    assert ("remove_path", (str(xray_install_root),)) in system.actions
