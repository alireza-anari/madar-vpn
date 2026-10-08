from __future__ import annotations

import hashlib
import io
import stat
import sys
import zipfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from madar_agent import xray


VERSION = "26.3.27"
AMD64_URL = "https://github.com/XTLS/Xray-core/releases/download/v26.3.27/Xray-linux-64.zip"
AMD64_SHA256 = "23cd9af937744d97776ee35ecad4972cf4b2109d1e0fe6be9930467608f7c8ae"
ARM64_URL = "https://github.com/XTLS/Xray-core/releases/download/v26.3.27/Xray-linux-arm64-v8a.zip"
ARM64_SHA256 = "4d30283ae614e3057f730f67cd088a42be6fdf91f8639d82cb69e48cde80413c"


def xray_archive(binary_payload: bytes) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("xray", binary_payload)
        archive.writestr("geoip.dat", b"fixture-geoip")
    return buffer.getvalue()


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
        download_url=AMD64_URL,
        sha256=sha256 or hashlib.sha256(payload).hexdigest(),
    )
    return adapter, config, downloads, error_cls


def test_stable_runtime_config_pins_official_release_assets_and_digests() -> None:
    config_for = getattr(xray, "stable_runtime_config", None)
    assert config_for is not None, "Task 26 must expose the reviewed stable Xray release pin"

    amd64 = config_for("x86_64")
    arm64 = config_for("aarch64")

    assert (amd64.version, amd64.download_url, amd64.sha256) == (
        VERSION,
        AMD64_URL,
        AMD64_SHA256,
    )
    assert (arm64.version, arm64.download_url, arm64.sha256) == (
        VERSION,
        ARM64_URL,
        ARM64_SHA256,
    )


def test_ensure_runtime_extracts_xray_from_verified_release_archive(tmp_path: Path) -> None:
    binary_payload = b"fixture-xray-binary"
    payload = xray_archive(binary_payload)
    adapter, config, downloads, _ = runtime_contract(tmp_path, payload)

    binary = adapter.ensure_runtime(config)

    assert downloads == [AMD64_URL]
    assert binary == tmp_path / "runtime" / VERSION / "xray"
    assert binary.read_bytes() == binary_payload
    assert stat.S_IMODE(binary.stat().st_mode) == 0o755


def test_ensure_runtime_rejects_checksum_mismatch_without_installing_binary(tmp_path: Path) -> None:
    payload = xray_archive(b"tampered-xray-binary")
    adapter, config, downloads, error_cls = runtime_contract(tmp_path, payload, sha256="0" * 64)

    with pytest.raises(error_cls, match="checksum"):
        adapter.ensure_runtime(config)

    assert downloads == [AMD64_URL]
    assert not (tmp_path / "runtime" / VERSION / "xray").exists()
