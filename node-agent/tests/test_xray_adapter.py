from __future__ import annotations

import hashlib
import stat
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from madar_agent import xray


RELEASE_URL = "https://github.com/XTLS/Xray-core/releases/download/v26.9.9/Xray-linux-64"
VERSION = "26.9.9"


def runtime_contract(tmp_path: Path, payload: bytes, sha256: str | None = None):
    adapter_cls = getattr(xray, "PinnedXrayAdapter", None)
    config_cls = getattr(xray, "XrayRuntimeConfig", None)
    error_cls = getattr(xray, "XrayRuntimeError", RuntimeError)

    assert adapter_cls is not None, "PinnedXrayAdapter must implement the Task 26 runtime contract"
    assert config_cls is not None, "XrayRuntimeConfig must pin version, URL, and checksum"

    downloads: list[str] = []

    def download(url: str) -> bytes:
        downloads.append(url)
        return payload

    adapter = adapter_cls(
        install_root=tmp_path / "runtime",
        state_root=tmp_path / "state",
        download=download,
    )
    config = config_cls(
        version=VERSION,
        download_url=RELEASE_URL,
        sha256=sha256 or hashlib.sha256(payload).hexdigest(),
    )
    return adapter, config, downloads, error_cls


def test_ensure_runtime_installs_only_the_exact_checksum_pinned_xray_binary(tmp_path: Path) -> None:
    payload = b"fixture-xray-binary"
    adapter, config, downloads, _ = runtime_contract(tmp_path, payload)

    binary = adapter.ensure_runtime(config)

    assert downloads == [RELEASE_URL]
    assert binary == tmp_path / "runtime" / VERSION / "xray"
    assert binary.read_bytes() == payload
    assert stat.S_IMODE(binary.stat().st_mode) == 0o755


def test_ensure_runtime_rejects_checksum_mismatch_without_installing_binary(tmp_path: Path) -> None:
    payload = b"tampered-xray-binary"
    adapter, config, downloads, error_cls = runtime_contract(tmp_path, payload, sha256="0" * 64)

    with pytest.raises(error_cls, match="checksum"):
        adapter.ensure_runtime(config)

    assert downloads == [RELEASE_URL]
    assert not (tmp_path / "runtime" / VERSION / "xray").exists()
