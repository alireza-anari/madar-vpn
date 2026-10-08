from __future__ import annotations

import hashlib
import io
import zipfile
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from .models import ManagedClient, ObservedActivity


class XrayAdapter(Protocol):
    def apply_clients(self, clients: list[ManagedClient]) -> None: ...

    def disable_managed_access(self) -> None: ...

    def collect_observed_activity(self) -> list[ObservedActivity]: ...


@dataclass(frozen=True)
class XrayRuntimeConfig:
    version: str
    download_url: str
    sha256: str


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
    ) -> None:
        self.install_root = Path(install_root)
        self.state_root = Path(state_root)
        self._download = download

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
