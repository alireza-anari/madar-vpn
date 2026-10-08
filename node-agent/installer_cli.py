from __future__ import annotations

import os
import sys
from pathlib import Path

from madar_agent.installer import HttpEnrollmentClient, InstallPaths, NodeInstaller


ROOT = Path(__file__).resolve().parent
INSTALL_ROOT = Path("/opt/madar-node-agent")
STATE_ROOT = Path("/etc/madar-node-agent")
CREDENTIAL_PATH = STATE_ROOT / "node.credential"
SERVICE_PATH = Path("/etc/systemd/system/madar-node-agent.service")


class UnusedEnrollment:
    def enroll(self, token: str) -> str:
        raise RuntimeError("enrollment is not available for this lifecycle command")


def required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise SystemExit(f"{name} is required for install")
    return value


def install_paths() -> InstallPaths:
    return InstallPaths(
        source_root=ROOT,
        install_root=INSTALL_ROOT,
        state_root=STATE_ROOT,
        credential_path=CREDENTIAL_PATH,
        service_source=ROOT / "systemd" / "madar-node-agent.service",
        service_path=SERVICE_PATH,
    )


def write_agent_environment(api_base_url: str) -> None:
    STATE_ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    STATE_ROOT.chmod(0o700)
    env_path = STATE_ROOT / "agent.env"
    descriptor = os.open(env_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8", closefd=False) as handle:
            handle.write(f"MADAR_API_BASE_URL={api_base_url.rstrip('/')}\n")
            handle.write(f"MADAR_NODE_CREDENTIAL_PATH={CREDENTIAL_PATH}\n")
            handle.flush()
            os.fsync(handle.fileno())
    finally:
        os.close(descriptor)


def build_install_installer() -> NodeInstaller:
    api_base_url = required("MADAR_API_BASE_URL").rstrip("/")
    try:
        port = int(required("MADAR_NODE_PORT"))
    except ValueError as error:
        raise SystemExit("MADAR_NODE_PORT must be an integer") from error
    enrollment = HttpEnrollmentClient(
        api_base_url=api_base_url,
        capabilities={"agent": "0.1.0", "xray": "unavailable"},
        public_config={
            "address": required("MADAR_NODE_ADDRESS"),
            "port": port,
            "serverName": required("MADAR_NODE_SERVER_NAME"),
            "realityPublicKey": required("MADAR_REALITY_PUBLIC_KEY"),
            "realityShortId": required("MADAR_REALITY_SHORT_ID"),
        },
    )
    write_agent_environment(api_base_url)
    return NodeInstaller(install_paths(), enrollment=enrollment)


def build_lifecycle_installer() -> NodeInstaller:
    return NodeInstaller(install_paths(), enrollment=UnusedEnrollment())


def read_enrollment_token() -> str:
    try:
        with os.fdopen(3, "r", encoding="utf-8", closefd=False) as handle:
            token = handle.read(4097).strip()
    except OSError as error:
        raise SystemExit("one-time enrollment token input is unavailable") from error
    if len(token) < 8 or len(token) > 4096:
        raise SystemExit("one-time enrollment token is invalid")
    return token


def main(argv: list[str] | None = None) -> int:
    arguments = sys.argv[1:] if argv is None else argv
    command = arguments[0] if arguments else "install"
    if command == "install":
        build_install_installer().install(read_enrollment_token())
        return 0

    installer = build_lifecycle_installer()
    if command == "status":
        print(installer.status())
        return 0
    if command == "update":
        installer.update()
        return 0
    if command == "remove":
        installer.remove()
        return 0
    raise SystemExit("usage: installer_cli.py {install|status|update|remove}")


if __name__ == "__main__":
    raise SystemExit(main())
