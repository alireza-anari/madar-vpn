from __future__ import annotations

from dataclasses import dataclass
import hashlib
import hmac
import platform
from urllib.parse import urlparse
from urllib.request import urlopen


_RELEASE_TAG = "speed-enforcer-v0.1.0"
_RELEASE_BASE_URL = (
    "https://github.com/alireza-anari/madar-vpn/releases/download/"
    f"{_RELEASE_TAG}/"
)
_RELEASE_SHA256 = {
    "amd64": "25e2c0aad88013abf1e600791dc6c6b45d3eb30f962137cc8596aca69d4a74a3",
    "arm64": "a61b4b47946968cb2b3a4ee3d3817b0c76c93554ea4a40147cff08ea27367a32",
}
_ALLOWED_FINAL_HOSTS = {
    "github.com",
    "release-assets.githubusercontent.com",
}
_READ_CHUNK_BYTES = 64 * 1024


class SpeedReleaseError(RuntimeError):
    """Raised when the pinned Speed Enforcer release cannot be trusted."""


@dataclass(frozen=True)
class SpeedEnforcerReleaseAsset:
    tag: str
    asset_name: str
    sha256: str
    url: str


def canonical_speed_arch(system: str, machine: str) -> str:
    if system.strip().lower() != "linux":
        raise SpeedReleaseError("unsupported platform")

    normalized_machine = machine.strip().lower()
    if normalized_machine in {"x86_64", "amd64"}:
        return "amd64"
    if normalized_machine in {"aarch64", "arm64"}:
        return "arm64"
    raise SpeedReleaseError("unsupported platform")


def pinned_speed_enforcer_asset(
    system: str | None = None,
    machine: str | None = None,
) -> SpeedEnforcerReleaseAsset:
    resolved_system = platform.system() if system is None else system
    resolved_machine = platform.machine() if machine is None else machine
    arch = canonical_speed_arch(resolved_system, resolved_machine)
    asset_name = f"madar-speed-enforcer-linux-{arch}"
    return SpeedEnforcerReleaseAsset(
        tag=_RELEASE_TAG,
        asset_name=asset_name,
        sha256=_RELEASE_SHA256[arch],
        url=f"{_RELEASE_BASE_URL}{asset_name}",
    )


def _approved_final_url(url: str) -> bool:
    parsed = urlparse(url)
    return (
        parsed.scheme.lower() == "https"
        and parsed.hostname is not None
        and parsed.hostname.lower() in _ALLOWED_FINAL_HOSTS
    )


def download_verified_speed_enforcer(
    asset: SpeedEnforcerReleaseAsset,
    *,
    opener=urlopen,
    max_bytes: int = 67_108_864,
) -> bytes:
    if max_bytes < 1:
        raise SpeedReleaseError("release size invalid")

    try:
        response = opener(asset.url)
        with response:
            if not _approved_final_url(response.geturl()):
                raise SpeedReleaseError("release origin rejected")

            remaining = max_bytes + 1
            chunks: list[bytes] = []
            while remaining > 0:
                chunk = response.read(min(_READ_CHUNK_BYTES, remaining))
                if not chunk:
                    break
                chunks.append(chunk)
                remaining -= len(chunk)
    except SpeedReleaseError:
        raise
    except Exception as exc:
        raise SpeedReleaseError("release download failed") from exc

    payload = b"".join(chunks)
    if not payload or len(payload) > max_bytes:
        raise SpeedReleaseError("release size invalid")

    digest = hashlib.sha256(payload).hexdigest()
    if not hmac.compare_digest(digest, asset.sha256):
        raise SpeedReleaseError("release digest mismatch")

    return payload
