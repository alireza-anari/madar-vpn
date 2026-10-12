from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from madar_agent.installer import InstallPaths, NodeInstaller


SPEED_BINARY = b"verified-speed-enforcer-test-binary"


class FakeEnrollment:
    def enroll(self, _token: str) -> str:
        return "unused-test-credential"


class FakeSystem:
    def __init__(self) -> None:
        self.actions: list[tuple[str, tuple[str, ...]]] = []

    def install_files(self, source: Path, destination: Path) -> None:
        self.actions.append(("install_files", (str(source), str(destination))))

    def install_service(self, source: Path, destination: Path) -> None:
        self.actions.append(("install_service", (str(source), str(destination))))

    def install_executable(self, payload: bytes, destination: Path) -> None:
        self.actions.append(("install_executable", (str(destination), str(len(payload)))))

    def daemon_reload(self) -> None:
        self.actions.append(("daemon_reload", ()))

    def restart(self, service: str) -> None:
        self.actions.append(("restart", (service,)))

    def enable_and_start(self, service: str) -> None:
        self.actions.append(("enable_and_start", (service,)))

    def stop_and_disable(self, service: str) -> None:
        self.actions.append(("stop_and_disable", (service,)))

    def remove_path(self, path: Path) -> None:
        self.actions.append(("remove_path", (str(path),)))

    def service_status(self, service: str) -> str:
        self.actions.append(("service_status", (service,)))
        return "inactive"


def paths(tmp_path: Path) -> InstallPaths:
    return InstallPaths(
        source_root=tmp_path / "source",
        install_root=tmp_path / "opt" / "madar-node-agent",
        state_root=tmp_path / "etc" / "madar-node-agent",
        credential_path=tmp_path / "etc" / "madar-node-agent" / "node.credential",
        service_source=tmp_path / "source" / "systemd" / "madar-node-agent.service",
        service_path=tmp_path / "etc" / "systemd" / "system" / "madar-node-agent.service",
    )


def test_update_installs_speed_binary_and_three_units_before_reload_then_restarts_agent_only(tmp_path: Path) -> None:
    system = FakeSystem()
    install_paths = paths(tmp_path)
    installer = NodeInstaller(
        install_paths,
        enrollment=FakeEnrollment(),
        system=system,
        output=lambda _message: None,
        speed_enforcer_binary=SPEED_BINARY,
    )

    installer.update()

    install_files = (
        "install_files",
        (str(install_paths.source_root), str(install_paths.install_root)),
    )
    speed_binary_path = install_paths.install_root.parent / "madar-speed-enforcer" / "madar-speed-enforcer"
    speed_install = (
        "install_executable",
        (str(speed_binary_path), str(len(SPEED_BINARY))),
    )
    agent_unit_source = install_paths.service_source
    agent_unit_path = install_paths.service_path
    xray_unit_source = install_paths.service_source.parent / "madar-xray.service"
    xray_unit_path = install_paths.service_path.parent / "madar-xray.service"
    speed_unit_source = install_paths.service_source.parent / "madar-speed-enforcer.service"
    speed_unit_path = install_paths.service_path.parent / "madar-speed-enforcer.service"

    agent_stage = ("install_service", (str(agent_unit_source), str(agent_unit_path)))
    xray_stage = ("install_service", (str(xray_unit_source), str(xray_unit_path)))
    speed_stage = ("install_service", (str(speed_unit_source), str(speed_unit_path)))
    reload_action = ("daemon_reload", ())
    agent_restart = ("restart", ("madar-node-agent.service",))

    for action in (
        install_files,
        speed_install,
        agent_stage,
        xray_stage,
        speed_stage,
        reload_action,
        agent_restart,
    ):
        assert action in system.actions

    assert system.actions.index(install_files) < system.actions.index(speed_install)
    assert system.actions.index(speed_install) < system.actions.index(agent_stage)
    assert system.actions.index(speed_install) < system.actions.index(xray_stage)
    assert system.actions.index(speed_install) < system.actions.index(speed_stage)
    assert system.actions.index(agent_stage) < system.actions.index(reload_action)
    assert system.actions.index(xray_stage) < system.actions.index(reload_action)
    assert system.actions.index(speed_stage) < system.actions.index(reload_action)
    assert system.actions.index(reload_action) < system.actions.index(agent_restart)

    assert ("restart", ("madar-xray.service",)) not in system.actions
    assert ("restart", ("madar-speed-enforcer.service",)) not in system.actions
    assert ("enable_and_start", ("madar-xray.service",)) not in system.actions
    assert ("enable_and_start", ("madar-speed-enforcer.service",)) not in system.actions
