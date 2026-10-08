from __future__ import annotations

import hashlib
import io
import json
import stat
import sys
import zipfile
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from madar_agent import xray
from madar_agent.models import ManagedClient, ObservedActivity


VERSION = "26.3.27"
AMD64_URL = "https://github.com/XTLS/Xray-core/releases/download/v26.3.27/Xray-linux-64.zip"
AMD64_SHA256 = "23cd9af937744d97776ee35ecad4972cf4b2109d1e0fe6be9930467608f7c8ae"
ARM64_URL = "https://github.com/XTLS/Xray-core/releases/download/v26.3.27/Xray-linux-arm64-v8a.zip"
ARM64_SHA256 = "4d30283ae614e3057f730f67cd088a42be6fdf91f8639d82cb69e48cde80413c"
CLIENT_ID = "27848739-7e62-4138-9fd3-098a63964b6b"
SECOND_CLIENT_ID = "50848739-7e62-4138-9fd3-098a63964b6b"


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


def test_generate_reality_keypair_keeps_private_key_local_and_returns_only_public_data(tmp_path: Path) -> None:
    private_key = "fixture-private-key-never-log"
    public_key = "fixture-public-key"
    calls: list[list[str]] = []
    logs: list[str] = []

    def run(argv: list[str]):
        calls.append(argv)
        return SimpleNamespace(
            returncode=0,
            stdout=(
                f"PrivateKey: {private_key}\n"
                f"Password (PublicKey): {public_key}\n"
                "Hash32: fixture-hash\n"
            ),
            stderr="",
        )

    adapter = xray.PinnedXrayAdapter(
        install_root=tmp_path / "runtime",
        state_root=tmp_path / "state",
        download=lambda _url: b"",
        run=run,
        log=logs.append,
    )
    binary = tmp_path / "runtime" / VERSION / "xray"

    public = adapter.generate_reality_keypair(binary)

    assert calls == [[str(binary), "x25519"]]
    private_path = tmp_path / "state" / "reality.private"
    assert private_path.read_text(encoding="utf-8") == private_key
    assert stat.S_IMODE(private_path.stat().st_mode) == 0o600
    assert public.public_key == public_key
    assert private_key not in repr(public)
    assert all(private_key not in line for line in logs)


def test_generate_reality_keypair_redacts_private_key_when_xray_fails(tmp_path: Path) -> None:
    private_key = "fixture-private-key-from-failed-command"
    logs: list[str] = []

    def run(_argv: list[str]):
        return SimpleNamespace(
            returncode=1,
            stdout=f"PrivateKey: {private_key}\n",
            stderr="fixture failure",
        )

    adapter = xray.PinnedXrayAdapter(
        install_root=tmp_path / "runtime",
        state_root=tmp_path / "state",
        download=lambda _url: b"",
        run=run,
        log=logs.append,
    )

    with pytest.raises(xray.XrayRuntimeError) as exc_info:
        adapter.generate_reality_keypair(tmp_path / "runtime" / VERSION / "xray")

    assert private_key not in str(exc_info.value)
    assert all(private_key not in line for line in logs)
    assert not (tmp_path / "state" / "reality.private").exists()


def configured_adapter(tmp_path: Path, run, reload, logs: list[str]):
    server_config_cls = getattr(xray, "RealityServerConfig", None)
    assert server_config_cls is not None, "Task 26 must define server-side REALITY configuration"
    binary = tmp_path / "runtime" / VERSION / "xray"
    server = server_config_cls(
        port=443,
        target="www.example.com:443",
        server_names=("www.example.com",),
        short_ids=("0123456789abcdef",),
    )
    adapter = xray.PinnedXrayAdapter(
        install_root=tmp_path / "runtime",
        state_root=tmp_path / "state",
        download=lambda _url: b"",
        run=run,
        log=logs.append,
        binary=binary,
        server=server,
        reload=reload,
    )
    return adapter, binary


def write_private_key(tmp_path: Path, value: str = "fixture-private-key") -> None:
    state_root = tmp_path / "state"
    state_root.mkdir(exist_ok=True)
    private_path = state_root / "reality.private"
    private_path.write_text(value, encoding="utf-8")
    private_path.chmod(0o600)


def test_apply_clients_validates_candidate_before_atomic_promote_and_reload(tmp_path: Path) -> None:
    private_key = "fixture-private-key-config-only"
    write_private_key(tmp_path, private_key)
    state_root = tmp_path / "state"
    calls: list[list[str]] = []
    reloads: list[bool] = []
    logs: list[str] = []

    def run(argv: list[str]):
        calls.append(argv)
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    adapter, binary = configured_adapter(tmp_path, run, lambda: reloads.append(True), logs)
    adapter.apply_clients([ManagedClient(client_id=CLIENT_ID, tier="premium", speed_kbps=None)])

    live_path = state_root / "xray-config.json"
    candidate_path = state_root / "xray-config.candidate.json"
    assert calls == [[str(binary), "run", "-test", "-c", str(candidate_path)]]
    assert reloads == [True]
    assert live_path.exists()
    assert not candidate_path.exists()
    assert stat.S_IMODE(live_path.stat().st_mode) == 0o600

    config = json.loads(live_path.read_text(encoding="utf-8"))
    inbound = config["inbounds"][0]
    assert inbound["port"] == 443
    assert inbound["protocol"] == "vless"
    assert inbound["settings"]["decryption"] == "none"
    assert inbound["settings"]["clients"] == [
        {"id": CLIENT_ID, "flow": "xtls-rprx-vision", "email": f"madar:{CLIENT_ID}"}
    ]
    assert inbound["streamSettings"]["network"] == "raw"
    assert inbound["streamSettings"]["security"] == "reality"
    assert inbound["streamSettings"]["realitySettings"] == {
        "show": False,
        "target": "www.example.com:443",
        "serverNames": ["www.example.com"],
        "privateKey": private_key,
        "shortIds": ["0123456789abcdef"],
    }
    assert all(private_key not in line for line in logs)


def test_apply_clients_keeps_previous_config_when_validation_fails_and_redacts_output(tmp_path: Path) -> None:
    private_key = "fixture-private-key-do-not-echo"
    write_private_key(tmp_path, private_key)
    state_root = tmp_path / "state"
    live_path = state_root / "xray-config.json"
    live_path.write_text('{"sentinel":"previous"}', encoding="utf-8")
    live_path.chmod(0o600)
    reloads: list[bool] = []
    logs: list[str] = []

    def run(_argv: list[str]):
        return SimpleNamespace(
            returncode=1,
            stdout=f"invalid config includes {private_key}",
            stderr=f"private={private_key}",
        )

    adapter, _binary = configured_adapter(tmp_path, run, lambda: reloads.append(True), logs)

    with pytest.raises(xray.XrayRuntimeError) as exc_info:
        adapter.apply_clients([ManagedClient(client_id=CLIENT_ID, tier="free", speed_kbps=1024)])

    assert live_path.read_text(encoding="utf-8") == '{"sentinel":"previous"}'
    assert not (state_root / "xray-config.candidate.json").exists()
    assert reloads == []
    assert private_key not in str(exc_info.value)
    assert all(private_key not in line for line in logs)


def test_revoke_client_and_fail_closed_disable_reapply_the_managed_client_set(tmp_path: Path) -> None:
    write_private_key(tmp_path)
    reloads: list[bool] = []
    logs: list[str] = []

    def run(_argv: list[str]):
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    adapter, _binary = configured_adapter(tmp_path, run, lambda: reloads.append(True), logs)
    first = ManagedClient(client_id=CLIENT_ID, tier="free", speed_kbps=1024)
    second = ManagedClient(client_id=SECOND_CLIENT_ID, tier="premium", speed_kbps=None)

    adapter.apply_clients([first, second])
    adapter.revoke_client(CLIENT_ID)

    live_path = tmp_path / "state" / "xray-config.json"
    config = json.loads(live_path.read_text(encoding="utf-8"))
    assert [entry["id"] for entry in config["inbounds"][0]["settings"]["clients"]] == [SECOND_CLIENT_ID]

    adapter.disable_managed_access()
    config = json.loads(live_path.read_text(encoding="utf-8"))
    assert config["inbounds"][0]["settings"]["clients"] == []
    assert reloads == [True, True, True]


def test_health_requires_active_service_and_a_valid_live_config(tmp_path: Path) -> None:
    calls: list[list[str]] = []
    active = [False]
    logs: list[str] = []
    binary = tmp_path / "runtime" / VERSION / "xray"
    server = xray.RealityServerConfig(
        port=443,
        target="www.example.com:443",
        server_names=("www.example.com",),
        short_ids=("0123456789abcdef",),
    )

    def run(argv: list[str]):
        calls.append(argv)
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    adapter = xray.PinnedXrayAdapter(
        install_root=tmp_path / "runtime",
        state_root=tmp_path / "state",
        download=lambda _url: b"",
        run=run,
        log=logs.append,
        binary=binary,
        server=server,
        reload=lambda: None,
        is_active=lambda: active[0],
    )
    live_path = tmp_path / "state" / "xray-config.json"
    live_path.parent.mkdir(exist_ok=True)
    live_path.write_text("{}", encoding="utf-8")
    live_path.chmod(0o600)

    assert adapter.health() is False
    assert calls == []

    active[0] = True
    assert adapter.health() is True
    assert calls == [[str(binary), "run", "-test", "-c", str(live_path)]]


def test_collect_observed_activity_returns_only_the_injected_observation_source(tmp_path: Path) -> None:
    observed = ObservedActivity(
        client_id=CLIENT_ID,
        window_id="window-1",
        seconds=30,
        timestamp=datetime(2026, 10, 8, 18, 0, tzinfo=UTC),
    )
    adapter = xray.PinnedXrayAdapter(
        install_root=tmp_path / "runtime",
        state_root=tmp_path / "state",
        download=lambda _url: b"",
        activity_source=lambda: [observed],
    )

    assert adapter.collect_observed_activity() == [observed]
