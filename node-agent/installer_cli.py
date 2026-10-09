from __future__ import annotations

import json
import os
import platform
import subprocess
import sys
import urllib.request
from dataclasses import dataclass
from pathlib import Path

from madar_agent.installer import HttpEnrollmentClient, InstallPaths, NodeInstaller
from madar_agent.xray import PinnedXrayAdapter, XRAY_STABLE_VERSION, stable_runtime_config


ROOT = Path(__file__).resolve().parent
INSTALL_ROOT = Path("/opt/madar-node-agent")
XRAY_INSTALL_ROOT = Path("/opt/madar-xray")
STATE_ROOT = Path("/etc/madar-node-agent")
CREDENTIAL_PATH = STATE_ROOT / "node.credential"
SERVICE_PATH = Path("/etc/systemd/system/madar-node-agent.service")
XRAY_OBSERVATION_SERVER = "127.0.0.1:10085"


@dataclass(frozen=True, slots=True)
class XrayBootstrapResult:
    version: str
    public_key: str
    binary: Path


class UnusedEnrollment:
    def enroll(self, token: str) -> str:
        raise RuntimeError("enrollment is not available for this lifecycle command")


def required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise SystemExit(f"{name} is required for install")
    if any(character in value for character in ("\n", "\r", "\0")):
        raise SystemExit(f"{name} contains invalid characters")
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


def write_agent_environment(
    api_base_url: str,
    *,
    port: int,
    server_name: str,
    reality_target: str,
    short_id: str,
) -> None:
    STATE_ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    STATE_ROOT.chmod(0o700)
    env_path = STATE_ROOT / "agent.env"
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(env_path, flags, 0o600)
    try:
        os.fchmod(descriptor, 0o600)
        xray_binary = XRAY_INSTALL_ROOT / XRAY_STABLE_VERSION / "xray"
        lines = (
            f"MADAR_API_BASE_URL={api_base_url.rstrip('/')}\n",
            f"MADAR_NODE_CREDENTIAL_PATH={CREDENTIAL_PATH}\n",
            f"MADAR_XRAY_BINARY={xray_binary}\n",
            f"MADAR_XRAY_VERSION={XRAY_STABLE_VERSION}\n",
            f"MADAR_NODE_PORT={port}\n",
            f"MADAR_NODE_SERVER_NAME={server_name}\n",
            f"MADAR_REALITY_TARGET={reality_target}\n",
            f"MADAR_REALITY_SHORT_ID={short_id}\n",
        )
        with os.fdopen(descriptor, "w", encoding="utf-8", closefd=False) as handle:
            handle.writelines(lines)
            handle.flush()
            os.fsync(handle.fileno())
    finally:
        os.close(descriptor)


def _xray_architecture() -> str:
    machine = platform.machine().strip().lower()
    aliases = {
        "amd64": "x86_64",
        "x64": "x86_64",
        "arm64": "aarch64",
    }
    return aliases.get(machine, machine)


def _download_xray(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=30) as response:
        return response.read()


def _run_process(arguments: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        arguments,
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def observe_xray_online_users() -> int:
    binary = XRAY_INSTALL_ROOT / XRAY_STABLE_VERSION / "xray"
    result = _run_process(
        [
            str(binary),
            "api",
            "statsgetallonlineusers",
            f"--server={XRAY_OBSERVATION_SERVER}",
        ]
    )
    if result.returncode != 0:
        raise SystemExit("local Xray observation unavailable")

    try:
        payload = json.loads(result.stdout)
        if not isinstance(payload, dict):
            raise ValueError
        users = payload.get("users", [])
        if not isinstance(users, list) or not all(isinstance(user, str) for user in users):
            raise ValueError
    except (json.JSONDecodeError, TypeError, ValueError):
        raise SystemExit("local Xray observation unavailable") from None

    return sum(
        user.startswith("user>>>madar:") and user.endswith(">>>online")
        for user in users
    )


def bootstrap_xray() -> XrayBootstrapResult:
    runtime = stable_runtime_config(_xray_architecture())
    adapter = PinnedXrayAdapter(
        install_root=XRAY_INSTALL_ROOT,
        state_root=STATE_ROOT,
        download=_download_xray,
        run=_run_process,
    )
    binary = adapter.ensure_runtime(runtime)
    reality = adapter.generate_reality_keypair(binary)
    return XrayBootstrapResult(
        version=runtime.version,
        public_key=reality.public_key,
        binary=binary,
    )


def build_install_installer() -> NodeInstaller:
    api_base_url = required("MADAR_API_BASE_URL").rstrip("/")
    try:
        port = int(required("MADAR_NODE_PORT"))
    except ValueError as error:
        raise SystemExit("MADAR_NODE_PORT must be an integer") from error

    address = required("MADAR_NODE_ADDRESS")
    server_name = required("MADAR_NODE_SERVER_NAME")
    reality_target = required("MADAR_REALITY_TARGET")
    short_id = required("MADAR_REALITY_SHORT_ID")

    def public_config() -> dict[str, object]:
        xray = bootstrap_xray()
        return {
            "address": address,
            "port": port,
            "serverName": server_name,
            "realityPublicKey": xray.public_key,
            "realityShortId": short_id,
        }

    enrollment = HttpEnrollmentClient(
        api_base_url=api_base_url,
        capabilities={"agent": "0.1.0", "xray": XRAY_STABLE_VERSION},
        public_config=public_config,
    )
    write_agent_environment(
        api_base_url,
        port=port,
        server_name=server_name,
        reality_target=reality_target,
        short_id=short_id,
    )
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
    if command == "observe":
        print(json.dumps({"onlineUsers": observe_xray_online_users()}, separators=(",", ":")))
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
    raise SystemExit("usage: installer_cli.py {install|status|observe|update|remove}")


if __name__ == "__main__":
    raise SystemExit(main())
