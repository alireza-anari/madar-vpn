from __future__ import annotations

import hashlib
import io
import json
import os
import zipfile
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from .models import ManagedClient, ObservedActivity


class XrayAdapter(Protocol):
    def ensure_runtime(self, config: XrayRuntimeConfig) -> Path: ...

    def apply_clients(self, clients: list[ManagedClient]) -> None: ...

    def revoke_client(self, uuid: str) -> None: ...

    def disable_managed_access(self) -> None: ...

    def collect_observed_activity(self) -> list[ObservedActivity]: ...

    def health(self) -> bool: ...


class ProcessResult(Protocol):
    returncode: int
    stdout: str
    stderr: str


@dataclass(frozen=True)
class XrayRuntimeConfig:
    version: str
    download_url: str
    sha256: str


@dataclass(frozen=True, slots=True)
class RealityPublicParameters:
    public_key: str


@dataclass(frozen=True, slots=True)
class RealityServerConfig:
    port: int
    target: str
    server_names: tuple[str, ...]
    short_ids: tuple[str, ...]

    def __post_init__(self) -> None:
        if self.port < 1 or self.port > 65535:
            raise ValueError("port must be between 1 and 65535")
        if not self.target:
            raise ValueError("target is required")
        if not self.server_names:
            raise ValueError("at least one server name is required")
        if not self.short_ids:
            raise ValueError("at least one short id is required")


class XrayRuntimeError(RuntimeError):
    pass


XRAY_STABLE_VERSION = "26.3.27"
_XRAY_STABLE_RELEASES = {
    "x86_64": XrayRuntimeConfig(
        version=XRAY_STABLE_VERSION,
        download_url="https://github.com/XTLS/Xray-core/releases/download/v26.3.27/Xray-linux-64.zip",
        sha256="23cd9af937744d97776ee35ecad4972cf4b2109d1e0fe6be9930467608f7c8ae",
    ),
    "aarch64": XrayRuntimeConfig(
        version=XRAY_STABLE_VERSION,
        download_url="https://github.com/XTLS/Xray-core/releases/download/v26.3.27/Xray-linux-arm64-v8a.zip",
        sha256="4d30283ae614e3057f730f67cd088a42be6fdf91f8639d82cb69e48cde80413c",
    ),
}


def stable_runtime_config(architecture: str) -> XrayRuntimeConfig:
    try:
        return _XRAY_STABLE_RELEASES[architecture]
    except KeyError as exc:
        raise XrayRuntimeError(f"unsupported Xray architecture: {architecture}") from exc


class PinnedXrayAdapter:
    def __init__(
        self,
        *,
        install_root: Path,
        state_root: Path,
        download: Callable[[str], bytes],
        run: Callable[[list[str]], ProcessResult] | None = None,
        log: Callable[[str], None] | None = None,
        binary: Path | None = None,
        server: RealityServerConfig | None = None,
        reload: Callable[[], None] | None = None,
        is_active: Callable[[], bool] | None = None,
        activity_source: Callable[[], list[ObservedActivity]] | None = None,
    ) -> None:
        self.install_root = Path(install_root)
        self.state_root = Path(state_root)
        self._download = download
        self._run = run
        self._log = log or (lambda _message: None)
        self._binary = Path(binary) if binary is not None else None
        self._server = server
        self._reload = reload
        self._is_active = is_active
        self._activity_source = activity_source
        self._managed_clients: list[ManagedClient] = []

    def ensure_runtime(self, config: XrayRuntimeConfig) -> Path:
        payload = self._download(config.download_url)
        actual = hashlib.sha256(payload).hexdigest()
        if actual != config.sha256.lower():
            raise XrayRuntimeError("Xray release checksum verification failed")

        try:
            with zipfile.ZipFile(io.BytesIO(payload)) as archive:
                binary_payload = archive.read("xray")
        except (KeyError, zipfile.BadZipFile) as exc:
            raise XrayRuntimeError("Xray release archive does not contain a valid xray binary") from exc

        version_root = self.install_root / config.version
        version_root.mkdir(parents=True, exist_ok=True)
        binary = version_root / "xray"
        temporary = version_root / ".xray.tmp"
        temporary.write_bytes(binary_payload)
        temporary.chmod(0o755)
        temporary.replace(binary)
        return binary

    def generate_reality_keypair(self, binary: Path) -> RealityPublicParameters:
        if self._run is None:
            raise XrayRuntimeError("Xray process runner is not configured")

        result = self._run([str(binary), "x25519"])
        if result.returncode != 0:
            self._log("Xray REALITY key generation failed")
            raise XrayRuntimeError("Xray REALITY key generation failed")

        private_key = ""
        public_key = ""
        for line in result.stdout.splitlines():
            if line.startswith("PrivateKey: "):
                private_key = line.removeprefix("PrivateKey: ").strip()
            elif line.startswith("Password (PublicKey): "):
                public_key = line.removeprefix("Password (PublicKey): ").strip()

        if not private_key or not public_key:
            self._log("Xray REALITY key generation returned invalid output")
            raise XrayRuntimeError("Xray REALITY key generation returned invalid output")

        self.state_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.state_root.chmod(0o700)
        private_path = self.state_root / "reality.private"
        temporary = self.state_root / ".reality.private.tmp"
        self._write_secret_file(temporary, private_key)
        try:
            temporary.replace(private_path)
            private_path.chmod(0o600)
        except BaseException:
            temporary.unlink(missing_ok=True)
            raise

        return RealityPublicParameters(public_key=public_key)

    def apply_clients(self, clients: list[ManagedClient]) -> None:
        if self._run is None or self._binary is None or self._server is None or self._reload is None:
            raise XrayRuntimeError("Xray managed configuration is not fully configured")

        private_path = self.state_root / "reality.private"
        try:
            private_key = private_path.read_text(encoding="utf-8").strip()
        except OSError as exc:
            raise XrayRuntimeError("Xray REALITY private key is unavailable") from exc
        if not private_key:
            raise XrayRuntimeError("Xray REALITY private key is unavailable")

        config = self._render_config(clients, private_key)
        self.state_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.state_root.chmod(0o700)
        candidate = self.state_root / "xray-config.candidate.json"
        live = self.state_root / "xray-config.json"
        payload = json.dumps(config, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        self._write_secret_file(candidate, payload)

        try:
            result = self._run([str(self._binary), "run", "-test", "-c", str(candidate)])
            if result.returncode != 0:
                self._log("Xray candidate configuration validation failed")
                raise XrayRuntimeError("Xray candidate configuration validation failed")
            candidate.replace(live)
            live.chmod(0o600)
            self._reload()
            self._managed_clients = list(clients)
        except BaseException:
            candidate.unlink(missing_ok=True)
            raise

    def revoke_client(self, uuid: str) -> None:
        remaining = [client for client in self._managed_clients if client.client_id != uuid]
        if len(remaining) == len(self._managed_clients):
            return
        self.apply_clients(remaining)

    def disable_managed_access(self) -> None:
        self.apply_clients([])

    def collect_observed_activity(self) -> list[ObservedActivity]:
        if self._activity_source is None:
            return []
        return list(self._activity_source())

    def health(self) -> bool:
        if self._is_active is None or not self._is_active():
            return False
        if self._run is None or self._binary is None:
            return False
        live = self.state_root / "xray-config.json"
        if not live.is_file():
            return False
        result = self._run([str(self._binary), "run", "-test", "-c", str(live)])
        if result.returncode != 0:
            self._log("Xray live configuration health validation failed")
            return False
        return True

    def _render_config(self, clients: list[ManagedClient], private_key: str) -> dict[str, object]:
        assert self._server is not None
        client_entries = [
            {
                "id": client.client_id,
                "flow": "xtls-rprx-vision",
                "email": f"madar:{client.client_id}",
            }
            for client in clients
        ]
        return {
            "log": {"loglevel": "warning"},
            "api": {
                "tag": "madar-local-api",
                "listen": "127.0.0.1:10085",
                "services": ["StatsService"],
            },
            "stats": {},
            "policy": {
                "levels": {
                    "0": {"statsUserOnline": True},
                },
            },
            "inbounds": [
                {
                    "listen": "0.0.0.0",
                    "port": self._server.port,
                    "protocol": "vless",
                    "settings": {
                        "clients": client_entries,
                        "decryption": "none",
                    },
                    "streamSettings": {
                        "network": "raw",
                        "security": "reality",
                        "realitySettings": {
                            "show": False,
                            "target": self._server.target,
                            "serverNames": list(self._server.server_names),
                            "privateKey": private_key,
                            "shortIds": list(self._server.short_ids),
                        },
                    },
                }
            ],
            "outbounds": [{"protocol": "freedom", "tag": "direct"}],
        }

    @staticmethod
    def _write_secret_file(path: Path, content: str) -> None:
        flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        fd = os.open(path, flags, 0o600)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(content)
            path.chmod(0o600)
        except BaseException:
            path.unlink(missing_ok=True)
            raise
