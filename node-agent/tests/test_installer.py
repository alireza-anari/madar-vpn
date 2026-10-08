from __future__ import annotations

import stat
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from madar_agent.installer import EnrollmentFailed, InstallPaths, NodeInstaller


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
