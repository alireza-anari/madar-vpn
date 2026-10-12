from __future__ import annotations

import hashlib
import re

import pytest

from madar_agent.speed_release import (
    SpeedEnforcerReleaseAsset,
    SpeedReleaseError,
    canonical_speed_arch,
    download_verified_speed_enforcer,
    pinned_speed_enforcer_asset,
)


TAG = "speed-enforcer-v0.1.0"
BASE_URL = f"https://github.com/alireza-anari/madar-vpn/releases/download/{TAG}/"
EXPECTED_DIGESTS = {
    "amd64": "25e2c0aad88013abf1e600791dc6c6b45d3eb30f962137cc8596aca69d4a74a3",
    "arm64": "a61b4b47946968cb2b3a4ee3d3817b0c76c93554ea4a40147cff08ea27367a32",
}


class FakeResponse:
    def __init__(self, payload: bytes, final_url: str) -> None:
        self.payload = payload
        self.final_url = final_url
        self.offset = 0
        self.bytes_returned = 0

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        return None

    def geturl(self) -> str:
        return self.final_url

    def read(self, size: int = -1) -> bytes:
        if size is None or size < 0:
            size = len(self.payload) - self.offset
        chunk = self.payload[self.offset : self.offset + size]
        self.offset += len(chunk)
        self.bytes_returned += len(chunk)
        return chunk


class FakeOpener:
    def __init__(self, response: FakeResponse) -> None:
        self.response = response
        self.calls: list[str] = []

    def __call__(self, url: str):
        self.calls.append(url)
        return self.response


def _asset(payload: bytes, *, sha256: str | None = None) -> SpeedEnforcerReleaseAsset:
    return SpeedEnforcerReleaseAsset(
        tag=TAG,
        asset_name="madar-speed-enforcer-linux-amd64",
        sha256=sha256 or hashlib.sha256(payload).hexdigest(),
        url=f"{BASE_URL}madar-speed-enforcer-linux-amd64",
    )


def test_canonical_speed_arch_accepts_only_supported_linux_aliases() -> None:
    assert canonical_speed_arch("Linux", "x86_64") == "amd64"
    assert canonical_speed_arch("linux", "amd64") == "amd64"
    assert canonical_speed_arch("Linux", "aarch64") == "arm64"
    assert canonical_speed_arch("linux", "arm64") == "arm64"

    with pytest.raises(SpeedReleaseError, match="unsupported platform"):
        canonical_speed_arch("Darwin", "arm64")
    with pytest.raises(SpeedReleaseError, match="unsupported platform"):
        canonical_speed_arch("Linux", "i686")


def test_pinned_speed_enforcer_manifest_is_exact_and_non_placeholder() -> None:
    for machine, arch in (("x86_64", "amd64"), ("amd64", "amd64"), ("aarch64", "arm64"), ("arm64", "arm64")):
        asset = pinned_speed_enforcer_asset("Linux", machine)
        expected_name = f"madar-speed-enforcer-linux-{arch}"

        assert asset.tag == TAG
        assert asset.asset_name == expected_name
        assert asset.url == f"{BASE_URL}{expected_name}"
        assert asset.sha256 == EXPECTED_DIGESTS[arch]
        assert re.fullmatch(r"[0-9a-f]{64}", asset.sha256)
        assert asset.sha256 != "0" * 64


def test_download_verified_speed_enforcer_accepts_correct_payload_and_allowed_redirect() -> None:
    payload = b"verified-speed-enforcer-payload"
    response = FakeResponse(
        payload,
        "https://release-assets.githubusercontent.com/github-production-release-asset/example/binary",
    )
    opener = FakeOpener(response)
    asset = _asset(payload)

    assert download_verified_speed_enforcer(asset, opener=opener) == payload
    assert opener.calls == [asset.url]


def test_download_verified_speed_enforcer_accepts_final_github_origin() -> None:
    payload = b"verified-direct-github-payload"
    asset = _asset(payload)
    response = FakeResponse(payload, asset.url)

    assert download_verified_speed_enforcer(asset, opener=FakeOpener(response)) == payload


def test_download_verified_speed_enforcer_rejects_digest_mismatch_without_payload_leak() -> None:
    payload = b"PAYLOAD-SENTINEL-MUST-NOT-LEAK"
    asset = _asset(payload, sha256="f" * 64)
    response = FakeResponse(payload, asset.url)

    with pytest.raises(SpeedReleaseError, match="release digest mismatch") as exc_info:
        download_verified_speed_enforcer(asset, opener=FakeOpener(response))

    assert "PAYLOAD-SENTINEL-MUST-NOT-LEAK" not in str(exc_info.value)


def test_download_verified_speed_enforcer_rejects_empty_body() -> None:
    payload = b""
    asset = _asset(payload)
    response = FakeResponse(payload, asset.url)

    with pytest.raises(SpeedReleaseError, match="release size invalid"):
        download_verified_speed_enforcer(asset, opener=FakeOpener(response))


def test_download_verified_speed_enforcer_rejects_oversize_after_at_most_bound_plus_one_bytes() -> None:
    max_bytes = 16
    payload = b"x" * 100
    asset = _asset(payload)
    response = FakeResponse(payload, asset.url)

    with pytest.raises(SpeedReleaseError, match="release size invalid"):
        download_verified_speed_enforcer(asset, opener=FakeOpener(response), max_bytes=max_bytes)

    assert response.bytes_returned <= max_bytes + 1


def test_download_verified_speed_enforcer_rejects_non_https_final_url() -> None:
    payload = b"verified-payload"
    asset = _asset(payload)
    response = FakeResponse(payload, "http://github.com/alireza-anari/madar-vpn/releases/download/file")

    with pytest.raises(SpeedReleaseError, match="release origin rejected"):
        download_verified_speed_enforcer(asset, opener=FakeOpener(response))


def test_download_verified_speed_enforcer_rejects_unapproved_final_host() -> None:
    payload = b"verified-payload"
    asset = _asset(payload)
    response = FakeResponse(payload, "https://example.invalid/release-asset")

    with pytest.raises(SpeedReleaseError, match="release origin rejected"):
        download_verified_speed_enforcer(asset, opener=FakeOpener(response))


def test_download_verified_speed_enforcer_wraps_transport_failure_secret_safely() -> None:
    payload = b"transport-secret-sentinel"
    asset = _asset(payload)

    def broken_opener(url: str):
        raise OSError(f"network failed while fetching {payload!r}")

    with pytest.raises(SpeedReleaseError, match="release download failed") as exc_info:
        download_verified_speed_enforcer(asset, opener=broken_opener)

    assert "transport-secret-sentinel" not in str(exc_info.value)
