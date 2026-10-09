from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Protocol

from .api import HttpTransport, TransientTransportError, UrlLibTransport


SERVICE_NAME = "madar-node-agent.service"
XRAY_SERVICE_NAME = "madar-xray.service"
PUBLIC_NODE_CONFIG_FIELDS = frozenset(
    {
        "address",
        "port",
        "serverName",
        "realityPublicKey",
        "realityShortId",
    }
)


class EnrollmentFailed(RuntimeError):
    pass


class EnrollmentClient(Protocol):
    def enroll(self, token: str) -> str: ...


class InstallerSystem(Protocol):
    def install_files(self, source: Path, destination: Path) -> None: ...

    def install_service(self, source: Path, destination: Path) -> None: ...

    def daemon_reload(self) -> None: ...

    def enable_and_start(self, service: str) -> None: ...

    def restart(self, service: str) -> None: ...

    def stop_and_disable(self, service: str) -> None: ...

    def remove_path(self, path: Path) -> None: ...

    def service_status(self, service: str) -> str: ...


@dataclass(frozen=True, slots=True)
class InstallPaths:
    source_root: Path
    install_root: Path
    state_root: Path
    credential_path: Path
    service_source: Path
    service_path: Path


class HttpEnrollmentClient:
    def __init__(
        self,
        *,
        api_base_url: str,
        capabilities: dict[str, object],
        public_config: dict[str, object] | Callable[[], dict[str, object]],
        transport: HttpTransport | None = None,
        timeout_seconds: float = 10.0,
    ) -> None:
        base = api_base_url.rstrip("/")
        if not base.startswith("https://"):
            raise ValueError("api_base_url must use HTTPS")
        if timeout_seconds <= 0 or timeout_seconds > 60:
            raise ValueError("timeout_seconds is out of range")
        self.api_base_url = base
        self.capabilities = dict(capabilities)
        if callable(public_config):
            self._public_config_provider = public_config
        else:
            snapshot = dict(public_config)
            self._public_config_provider = lambda: dict(snapshot)
        self.transport = transport or UrlLibTransport()
        self.timeout_seconds = timeout_seconds

    def _public_config(self) -> dict[str, object]:
        try:
            raw = self._public_config_provider()
        except Exception as error:
            raise EnrollmentFailed("node public configuration preparation failed") from error
        if not isinstance(raw, dict):
            raise EnrollmentFailed("node public configuration preparation failed")
        return {key: raw[key] for key in PUBLIC_NODE_CONFIG_FIELDS if key in raw}

    def enroll(self, token: str) -> str:
        if len(token) < 8 or len(token) > 4096:
            raise EnrollmentFailed("enrollment token is invalid")
        body = json.dumps(
            {"capabilities": self.capabilities, "publicConfig": self._public_config()},
            separators=(",", ":"),
        ).encode("utf-8")
        try:
            response = self.transport.request(
                "POST",
                f"{self.api_base_url}/api/node/enroll",
                headers={
                    "Authorization": f"Bearer {token}",
                    "Accept": "application/json",
                    "Content-Type": "application/json",
                },
                body=body,
                timeout=self.timeout_seconds,
            )
        except TransientTransportError as error:
            raise EnrollmentFailed("enrollment transport failed; issue a new one-time token before retrying") from error
        except Exception as error:
            raise EnrollmentFailed("enrollment request failed") from error

        if response.status != 201:
            raise EnrollmentFailed(f"enrollment rejected with HTTP {response.status}")
        try:
            payload = json.loads(response.body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise EnrollmentFailed("enrollment response was invalid") from error
        if not isinstance(payload, dict):
            raise EnrollmentFailed("enrollment response was invalid")
        credential = payload.get("rawCredential")
        if not isinstance(credential, str) or len(credential) < 8 or len(credential) > 4096:
            raise EnrollmentFailed("enrollment response did not include a valid node credential")
        return credential


class LocalSystem:
    def _run(self, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            list(args),
            check=check,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

    def install_files(self, source: Path, destination: Path) -> None:
        destination.mkdir(parents=True, exist_ok=True)
        shutil.copytree(
            source,
            destination,
            dirs_exist_ok=True,
            ignore=shutil.ignore_patterns("venv", "__pycache__", ".pytest_cache", "tests"),
        )
        venv_python = destination / "venv" / "bin" / "python"
        if not venv_python.exists():
            self._run(sys.executable, "-m", "venv", str(destination / "venv"))

    def install_service(self, source: Path, destination: Path) -> None:
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        destination.chmod(0o644)

    def daemon_reload(self) -> None:
        self._run("systemctl", "daemon-reload")

    def enable_and_start(self, service: str) -> None:
        self._run("systemctl", "enable", "--now", service)

    def restart(self, service: str) -> None:
        self._run("systemctl", "restart", service)

    def stop_and_disable(self, service: str) -> None:
        self._run("systemctl", "disable", "--now", service, check=False)

    def remove_path(self, path: Path) -> None:
        if path.is_dir() and not path.is_symlink():
            shutil.rmtree(path, ignore_errors=True)
            return
        try:
            path.unlink()
        except FileNotFoundError:
            pass

    def service_status(self, service: str) -> str:
        result = self._run("systemctl", "is-active", service, check=False)
        value = result.stdout.strip()
        return value or "inactive"


class NodeInstaller:
    def __init__(
        self,
        paths: InstallPaths,
        *,
        enrollment: EnrollmentClient,
        system: InstallerSystem | None = None,
        output: Callable[[str], None] = print,
    ) -> None:
        self.paths = paths
        self.enrollment = enrollment
        self.system = system or LocalSystem()
        self.output = output

    @property
    def _xray_service_source(self) -> Path:
        return self.paths.service_source.parent / XRAY_SERVICE_NAME

    @property
    def _xray_service_path(self) -> Path:
        return self.paths.service_path.parent / XRAY_SERVICE_NAME

    @property
    def _xray_install_root(self) -> Path:
        return self.paths.install_root.parent / "madar-xray"

    def _describe_install(self) -> None:
        self.output(f"Will copy the Madar node agent to {self.paths.install_root}.")
        self.output(f"Will request a node credential and store it at {self.paths.credential_path} with mode 0600.")
        self.output(f"Will install and enable the systemd unit {SERVICE_NAME} only after enrollment succeeds.")
        self.output(f"Will stage {XRAY_SERVICE_NAME}; it remains stopped until a validated managed configuration exists.")
        self.output("Will not modify SSH or firewall configuration.")

    def _write_credential(self, credential: str) -> None:
        self.paths.state_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.paths.state_root.chmod(0o700)
        flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        descriptor = os.open(self.paths.credential_path, flags, 0o600)
        try:
            os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8", closefd=False) as handle:
                handle.write(f"{credential}\n")
                handle.flush()
                os.fsync(handle.fileno())
        finally:
            os.close(descriptor)

    def install(self, enrollment_token: str) -> None:
        self._describe_install()
        self.system.install_files(self.paths.source_root, self.paths.install_root)
        credential = self.enrollment.enroll(enrollment_token)
        try:
            self._write_credential(credential)
            self.system.install_service(self.paths.service_source, self.paths.service_path)
            self.system.install_service(self._xray_service_source, self._xray_service_path)
            self.system.daemon_reload()
            self.system.enable_and_start(SERVICE_NAME)
        except Exception:
            self.system.stop_and_disable(SERVICE_NAME)
            self.system.stop_and_disable(XRAY_SERVICE_NAME)
            self.system.remove_path(self.paths.credential_path)
            raise
        self.output("Installation complete. The one-time enrollment token was not stored.")

    def status(self) -> str:
        return self.system.service_status(SERVICE_NAME)

    def update(self) -> None:
        self.output(f"Will update files under {self.paths.install_root} and restart {SERVICE_NAME}.")
        self.output(f"Will refresh the staged {XRAY_SERVICE_NAME} unit without starting it before managed config exists.")
        self.output("Will not modify SSH or firewall configuration.")
        self.system.install_files(self.paths.source_root, self.paths.install_root)
        self.system.install_service(self.paths.service_source, self.paths.service_path)
        self.system.install_service(self._xray_service_source, self._xray_service_path)
        self.system.daemon_reload()
        self.system.restart(SERVICE_NAME)

    def remove(self) -> None:
        self.output(f"Will stop {SERVICE_NAME} and remove Madar agent files and node credential from this host.")
        self.output(f"Will also stop {XRAY_SERVICE_NAME} and remove its staged unit and runtime files.")
        self.output("Will not modify SSH or firewall configuration.")
        self.system.stop_and_disable(SERVICE_NAME)
        self.system.stop_and_disable(XRAY_SERVICE_NAME)
        self.system.remove_path(self.paths.credential_path)
        self.system.remove_path(self.paths.install_root)
        self.system.remove_path(self._xray_install_root)
        self.system.remove_path(self.paths.service_path)
        self.system.remove_path(self._xray_service_path)
        self.system.remove_path(self.paths.state_root)
        self.system.daemon_reload()
