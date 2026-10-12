from __future__ import annotations

import json
import stat
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from madar_agent.api import HttpResponse
from madar_agent.installer import EnrollmentFailed, HttpEnrollmentClient, InstallPaths, NodeInstaller


SPEED_BINARY = b"verified-speed-enforcer-test-binary"


class FakeEnrollment:
    def __init__(self, *, credential: str = "test-issued-node-value", fail: bool = False) -> None:
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
    def __init__(self, *, fail_executable: bool = False) -> None:
        self.actions: list[tuple[str, tuple[str, ...]]] = []
        self.executable_installs: list[tuple[bytes, str]] = []
        self.service_active = False
        self.fail_executable = fail_executable

    def install_files(self, source: Path, destination: Path) -> None:
        self.actions.append(("install_files", (str(source), str(destination))))

    def install_service(self, source: Path, destination: Path) -> None:
        self.actions.append(("install_service", (str(source), str(destination))))

    def install_executable(self, payload: bytes, destination: Path) -> None:
        self.actions.append(("install_executable", (str(destination),)))
        self.executable_installs.append((payload, str(destination)))
        if self.fail_executable:
            raise RuntimeError("injected executable install failure")

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


def make_installer(
    tmp_path: Path,
    *,
    enrollment: FakeEnrollment | None = None,
    system: FakeSystem | None = None,
    output=lambda _message: None,
    speed_enforcer_binary: bytes | None = SPEED_BINARY,
) -> NodeInstaller:
    return NodeInstaller(
        paths(tmp_path),
        enrollment=enrollment or FakeEnrollment(),
        system=system or FakeSystem(),
        output=output,
        speed_enforcer_binary=speed_enforcer_binary,
    )


def test_http_enrollment_sends_token_only_as_bearer_and_returns_issued_credential() -> None:
    token = "test-enrollment-input-value"
    transport = FakeTransport(HttpResponse(
        status=201,
        body=b'{"rawCredential":"issued-test-node-value","node":{"id":"node-1"}}',
    ))
    client = HttpEnrollmentClient(
        api_base_url="https://control.example.test",
        capabilities={"agent": "0.1.0", "xray": "unavailable"},
        public_config={
            "address": "203.0.113.10",
            "port": 443,
            "serverName": "edge.example.test",
            "realityPublicKey": "public-test-value",
            "realityShortId": "a1b2c3d4",
        },
        transport=transport,
    )

    assert client.enroll(token) == "issued-test-node-value"
    method, url, headers, body, _ = transport.requests[0]
    assert method == "POST"
    assert url == "https://control.example.test/api/node/enroll"
    assert headers["Authorization"] == f"Bearer {token}"
    decoded = json.loads(body)
    assert decoded["capabilities"]["xray"] == "unavailable"
    assert token not in json.dumps(decoded)


def test_http_enrollment_prepares_xray_public_config_lazily_and_drops_non_public_fields() -> None:
    prepared: list[bool] = []
    transport = FakeTransport(HttpResponse(
        status=201,
        body=b'{"rawCredential":"issued-test-node-value","node":{"id":"node-1"}}',
    ))

    def public_config() -> dict[str, object]:
        prepared.append(True)
        return {
            "address": "203.0.113.10",
            "port": 443,
            "serverName": "edge.example.test",
            "realityPublicKey": "generated-public-test-value",
            "realityShortId": "0123456789abcdef",
            "internalOnlyValue": "must-stay-local",
            "extraIssuedValue": "must-not-be-sent",
        }

    client = HttpEnrollmentClient(
        api_base_url="https://control.example.test",
        capabilities={"agent": "0.1.0", "xray": "26.3.27"},
        public_config=public_config,
        transport=transport,
    )

    assert prepared == []
    assert client.enroll("test-enrollment-input-value") == "issued-test-node-value"
    assert prepared == [True]

    decoded = json.loads(transport.requests[0][3])
    assert decoded["publicConfig"] == {
        "address": "203.0.113.10",
        "port": 443,
        "serverName": "edge.example.test",
        "realityPublicKey": "generated-public-test-value",
        "realityShortId": "0123456789abcdef",
    }
    serialized = json.dumps(decoded)
    assert "must-stay-local" not in serialized
    assert "must-not-be-sent" not in serialized


def test_http_enrollment_error_does_not_echo_input_value() -> None:
    token = "test-enrollment-input-value"
    transport = FakeTransport(HttpResponse(status=401, body=b'{"error":"NODE_ENROLLMENT_TOKEN_INVALID"}'))
    client = HttpEnrollmentClient(
        api_base_url="https://control.example.test",
        capabilities={},
        public_config={
            "address": "203.0.113.10",
            "port": 443,
            "serverName": "edge.example.test",
            "realityPublicKey": "public-test-value",
            "realityShortId": "a1b2c3d4",
        },
        transport=transport,
    )

    with pytest.raises(EnrollmentFailed) as raised:
        client.enroll(token)
    assert token not in str(raised.value)


def test_install_explains_sensitive_changes_and_stages_speed_without_starting_subordinates(tmp_path: Path) -> None:
    output: list[str] = []
    enrollment = FakeEnrollment()
    system = FakeSystem()
    installer = make_installer(tmp_path, enrollment=enrollment, system=system, output=output.append)
    token = "test-enrollment-input-value"

    installer.install(token)

    joined = "\n".join(output)
    assert "credential" in joined.lower()
    assert "systemd" in joined.lower()
    assert "speed enforcer" in joined.lower()
    assert "ssh" in joined.lower()
    assert "firewall" in joined.lower()
    assert "will not modify" in joined.lower()
    assert token not in joined
    assert enrollment.tokens == [token]
    assert ("enable_and_start", ("madar-node-agent.service",)) in system.actions
    assert ("enable_and_start", ("madar-xray.service",)) not in system.actions
    assert ("enable_and_start", ("madar-speed-enforcer.service",)) not in system.actions


def test_install_places_speed_binary_and_stages_all_three_units(tmp_path: Path) -> None:
    system = FakeSystem()
    install_paths = paths(tmp_path)
    installer = NodeInstaller(
        install_paths,
        enrollment=FakeEnrollment(),
        system=system,
        output=lambda _message: None,
        speed_enforcer_binary=SPEED_BINARY,
    )

    installer.install("test-enrollment-input-value")

    speed_root = install_paths.install_root.parent / "madar-speed-enforcer"
    speed_binary = speed_root / "madar-speed-enforcer"
    assert system.executable_installs == [(SPEED_BINARY, str(speed_binary))]
    for service_name in (
        "madar-node-agent.service",
        "madar-xray.service",
        "madar-speed-enforcer.service",
    ):
        source = install_paths.service_source.parent / service_name
        destination = install_paths.service_path.parent / service_name
        assert ("install_service", (str(source), str(destination))) in system.actions


def test_install_writes_credential_with_owner_only_permissions_before_service_start(tmp_path: Path) -> None:
    enrollment = FakeEnrollment(credential="credential-test-value-from-control-plane")
    system = FakeSystem()
    install_paths = paths(tmp_path)
    installer = NodeInstaller(
        install_paths,
        enrollment=enrollment,
        system=system,
        output=lambda _message: None,
        speed_enforcer_binary=SPEED_BINARY,
    )

    installer.install("test-one-time-input")

    assert install_paths.credential_path.read_text(encoding="utf-8") == "credential-test-value-from-control-plane\n"
    assert stat.S_IMODE(install_paths.credential_path.stat().st_mode) == 0o600
    start_index = system.actions.index(("enable_and_start", ("madar-node-agent.service",)))
    assert start_index > system.actions.index(("daemon_reload", ()))


def test_failed_enrollment_never_installs_speed_or_starts_service_and_leaves_no_credential(tmp_path: Path) -> None:
    enrollment = FakeEnrollment(fail=True)
    system = FakeSystem()
    install_paths = paths(tmp_path)
    installer = NodeInstaller(
        install_paths,
        enrollment=enrollment,
        system=system,
        output=lambda _message: None,
        speed_enforcer_binary=SPEED_BINARY,
    )

    with pytest.raises(EnrollmentFailed):
        installer.install("bad-test-input")

    assert not any(action == "install_executable" for action, _ in system.actions)
    assert not any(action == "enable_and_start" for action, _ in system.actions)
    assert system.service_active is False
    assert not install_paths.credential_path.exists()


def test_post_enrollment_speed_install_failure_cleans_all_managed_runtime_state(tmp_path: Path) -> None:
    output: list[str] = []
    system = FakeSystem(fail_executable=True)
    install_paths = paths(tmp_path)
    enrollment = FakeEnrollment(credential="credential-test-value-after-enroll")
    installer = NodeInstaller(
        install_paths,
        enrollment=enrollment,
        system=system,
        output=output.append,
        speed_enforcer_binary=SPEED_BINARY,
    )
    token = "test-enrollment-input-value"

    with pytest.raises(RuntimeError, match="injected executable install failure"):
        installer.install(token)

    for service_name in (
        "madar-node-agent.service",
        "madar-xray.service",
        "madar-speed-enforcer.service",
    ):
        assert ("stop_and_disable", (service_name,)) in system.actions
    speed_root = install_paths.install_root.parent / "madar-speed-enforcer"
    assert ("remove_path", (str(install_paths.credential_path),)) in system.actions
    assert ("remove_path", (str(speed_root),)) in system.actions
    assert system.service_active is False
    joined = "\n".join(output)
    assert token not in joined
    assert "credential-test-value-after-enroll" not in joined


def test_install_and_update_require_verified_speed_binary_before_system_mutation(tmp_path: Path) -> None:
    for operation in ("install", "update"):
        system = FakeSystem()
        installer = make_installer(tmp_path, system=system, speed_enforcer_binary=None)

        with pytest.raises(RuntimeError, match="verified Speed Enforcer binary is required"):
            getattr(installer, operation)("test-enrollment-input-value") if operation == "install" else installer.update()

        assert system.actions == []


def test_status_update_and_remove_have_explicit_three_service_lifecycle_behavior(tmp_path: Path) -> None:
    enrollment = FakeEnrollment()
    system = FakeSystem()
    install_paths = paths(tmp_path)
    installer = NodeInstaller(
        install_paths,
        enrollment=enrollment,
        system=system,
        output=lambda _message: None,
        speed_enforcer_binary=SPEED_BINARY,
    )

    assert installer.status() == "inactive"
    installer.update()
    assert ("restart", ("madar-node-agent.service",)) in system.actions
    assert ("restart", ("madar-xray.service",)) not in system.actions
    assert ("restart", ("madar-speed-enforcer.service",)) not in system.actions

    install_paths.credential_path.parent.mkdir(parents=True, exist_ok=True)
    install_paths.credential_path.write_text("test-value\n", encoding="utf-8")
    installer.remove()

    for service_name in (
        "madar-node-agent.service",
        "madar-xray.service",
        "madar-speed-enforcer.service",
    ):
        assert ("stop_and_disable", (service_name,)) in system.actions

    expected_removed = (
        install_paths.credential_path,
        install_paths.install_root,
        install_paths.install_root.parent / "madar-xray",
        install_paths.install_root.parent / "madar-speed-enforcer",
        install_paths.service_path,
        install_paths.service_path.parent / "madar-xray.service",
        install_paths.service_path.parent / "madar-speed-enforcer.service",
        install_paths.state_root,
    )
    for path in expected_removed:
        assert ("remove_path", (str(path),)) in system.actions
    assert system.actions[-1] == ("daemon_reload", ())


def test_xray_and_speed_services_are_staged_but_not_enabled_before_policy(tmp_path: Path) -> None:
    system = FakeSystem()
    install_paths = paths(tmp_path)
    installer = NodeInstaller(
        install_paths,
        enrollment=FakeEnrollment(),
        system=system,
        output=lambda _message: None,
        speed_enforcer_binary=SPEED_BINARY,
    )

    installer.install("test-enrollment-input-value")

    for service_name in ("madar-xray.service", "madar-speed-enforcer.service"):
        service_source = install_paths.service_source.parent / service_name
        service_path = install_paths.service_path.parent / service_name
        assert ("install_service", (str(service_source), str(service_path))) in system.actions
        assert ("enable_and_start", (service_name,)) not in system.actions
