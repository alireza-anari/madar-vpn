from __future__ import annotations

import hashlib
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

        version_root = self.install_root / config.version
        version_root.mkdir(parents=True, exist_ok=True)
        binary = version_root / "xray"
        temporary = version_root / ".xray.tmp"
        temporary.write_bytes(payload)
        temporary.chmod(0o755)
        temporary.replace(binary)
        return binary
