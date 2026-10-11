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
from madar_agent.models import ManagedClient, ObservedActivity, SpeedRouteCredential


VERSION = "26.3.27"
AMD64_URL = "https://github.com/XTLS/Xray-core/releases/download/v26.3.27/Xray-linux-64.zip"
AMD64_SHA256 = "23cd9af937744d97776ee35ecad4972cf4b2109d1e0fe6be9930467608f7c8ae"
ARM64_URL = "https://github.com/XTLS/Xray-core/releases/download/v26.3.27/Xray-linux-arm64-v8a.zip"
ARM64_SHA256 = "4d30283ae614e3057f730f67cd088a42be6fdf91f8639d82cb69e48cde80413c"
CLIENT_ID = "27848739-7e62-4138-9fd3-098a63964b6b"
SECOND_CLIENT_ID = "50848739-7e62-4138-9fd3-098a63964b6b"


def speed_route(
    client_id: str,
    *,
    alias: str = "opaque-speed-alias",
    password: str = "test-only-speed-pass",
) -> SpeedRouteCredential:
    return SpeedRouteCredential(client_id=client_id, alias=alias, password=password)


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


def configured_adapter(
    tmp_path: Path,
    run,
    reload,
    logs: list[str],
    lifecycle_events: list[str] | None = None,
):
    server_config_cls = getattr(xray, "RealityServerConfig", None)
    assert server_config_cls is not None, "Task 26 must define server-side REALITY configuration"
    binary = tmp_path / "runtime" / VERSION / "xray"
    server = server_config_cls(
        port=443,
        target="www.example.com:443",
        server_names=("www.example.com",),
        short_ids=("0123456789abcdef",),
    )
    events = lifecycle_events if lifecycle_events is not None else []
    adapter = xray.PinnedXrayAdapter(
        install_root=tmp_path / "runtime",
        state_root=tmp_path / "state",
        download=lambda _url: b"",
        run=run,
        log=logs.append,
        binary=binary,
        server=server,
        authorize_runtime=lambda: events.append("authorize"),
        revoke_runtime_authorization=lambda: events.append("revoke"),
        reload=reload,
        is_active=lambda: True,
        disable_runtime=lambda: events.append("disable"),
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
    assert calls == [
        [str(binary), "run", "-test", "-c", str(candidate_path)],
        [str(binary), "run", "-test", "-c", str(live_path)],
    ]
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
    assert config["outbounds"] == [{"protocol": "freedom", "tag": "direct"}]
    assert "routing" not in config
    assert config["api"]["services"] == ["StatsService"]
    assert config["policy"]["levels"]["0"]["statsUserOnline"] is True
    assert config["policy"]["levels"]["0"]["statsUserUplink"] is True
    assert config["policy"]["levels"]["0"]["statsUserDownlink"] is True
    assert all(private_key not in line for line in logs)


def test_free_client_gets_authenticated_socks_route_while_premium_remains_direct(tmp_path: Path) -> None:
    write_private_key(tmp_path)
    calls: list[list[str]] = []
    logs: list[str] = []

    def run(argv: list[str]):
        calls.append(argv)
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    adapter, _binary = configured_adapter(tmp_path, run, lambda: None, logs)
    free = ManagedClient(client_id=CLIENT_ID, tier="free", speed_kbps=5000)
    premium = ManagedClient(client_id=SECOND_CLIENT_ID, tier="premium", speed_kbps=None)
    credential = speed_route(CLIENT_ID)
    adapter.apply_clients([premium, free], {CLIENT_ID: credential})

    config = json.loads((tmp_path / "state" / "xray-config.json").read_text(encoding="utf-8"))
    assert [outbound["tag"] for outbound in config["outbounds"]] == ["direct", "madar-speed-0001"]
    speed_outbound = config["outbounds"][1]
    assert speed_outbound == {
        "protocol": "socks",
        "tag": "madar-speed-0001",
        "settings": {
            "servers": [
                {
                    "address": "127.0.0.1",
                    "port": 10808,
                    "users": [{"user": credential.alias, "pass": credential.password}],
                }
            ]
        },
    }
    assert config["routing"]["rules"] == [
        {
            "type": "field",
            "user": [f"madar:{CLIENT_ID}"],
            "outboundTag": "madar-speed-0001",
        }
    ]
    assert "network" not in config["routing"]["rules"][0]
    tags = " ".join(outbound["tag"] for outbound in config["outbounds"])
    assert CLIENT_ID not in tags
    assert credential.alias not in tags
    assert credential.password not in tags
    assert config["api"]["services"] == ["StatsService"]
    assert config["policy"]["levels"]["0"] == {
        "statsUserOnline": True,
        "statsUserUplink": True,
        "statsUserDownlink": True,
    }


def test_free_speed_tags_are_stable_by_sorted_client_id(tmp_path: Path) -> None:
    write_private_key(tmp_path)
    logs: list[str] = []

    def run(_argv: list[str]):
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    adapter, _binary = configured_adapter(tmp_path, run, lambda: None, logs)
    first = ManagedClient(client_id=CLIENT_ID, tier="free", speed_kbps=5000)
    second = ManagedClient(client_id=SECOND_CLIENT_ID, tier="free", speed_kbps=5000)
    first_route = speed_route(CLIENT_ID, alias="opaque-one", password="test-only-one")
    second_route = speed_route(SECOND_CLIENT_ID, alias="opaque-two", password="test-only-two")
    adapter.apply_clients(
        [second, first],
        {SECOND_CLIENT_ID: second_route, CLIENT_ID: first_route},
    )

    config = json.loads((tmp_path / "state" / "xray-config.json").read_text(encoding="utf-8"))
    speed_outbounds = config["outbounds"][1:]
    assert [entry["tag"] for entry in speed_outbounds] == ["madar-speed-0001", "madar-speed-0002"]
    assert speed_outbounds[0]["settings"]["servers"][0]["users"] == [
        {"user": first_route.alias, "pass": first_route.password}
    ]
    assert speed_outbounds[1]["settings"]["servers"][0]["users"] == [
        {"user": second_route.alias, "pass": second_route.password}
    ]
    assert [rule["user"] for rule in config["routing"]["rules"]] == [
        [f"madar:{CLIENT_ID}"],
        [f"madar:{SECOND_CLIENT_ID}"],
    ]


def test_free_speed_route_mapping_must_be_exact_and_identity_matched(tmp_path: Path) -> None:
    write_private_key(tmp_path)
    calls: list[list[str]] = []
    logs: list[str] = []

    def run(argv: list[str]):
        calls.append(argv)
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    adapter, _binary = configured_adapter(tmp_path, run, lambda: None, logs)
    free = ManagedClient(client_id=CLIENT_ID, tier="free", speed_kbps=5000)
    cases = [
        {},
        {
            CLIENT_ID: speed_route(CLIENT_ID),
            SECOND_CLIENT_ID: speed_route(SECOND_CLIENT_ID),
        },
        {CLIENT_ID: speed_route(SECOND_CLIENT_ID)},
    ]
    for routes in cases:
        with pytest.raises(xray.XrayRuntimeError, match="speed route"):
            adapter.apply_clients([free], routes)
    assert calls == []
    assert not (tmp_path / "state" / "xray-config.candidate.json").exists()
    assert not (tmp_path / "state" / "xray-config.json").exists()


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
        adapter.apply_clients(
            [ManagedClient(client_id=CLIENT_ID, tier="free", speed_kbps=1024)],
            {CLIENT_ID: speed_route(CLIENT_ID)},
        )

    assert live_path.read_text(encoding="utf-8") == '{"sentinel":"previous"}'
    assert not (state_root / "xray-config.candidate.json").exists()
    assert reloads == []
    assert private_key not in str(exc_info.value)
    assert all(private_key not in line for line in logs)


def test_revoke_client_reapplies_remaining_set_and_fail_closed_disable_stops_without_empty_reapply(tmp_path: Path) -> None:
    write_private_key(tmp_path)
    reloads: list[bool] = []
    logs: list[str] = []
    lifecycle_events: list[str] = []

    def run(_argv: list[str]):
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    adapter, _binary = configured_adapter(
        tmp_path,
        run,
        lambda: reloads.append(True),
        logs,
        lifecycle_events=lifecycle_events,
    )
    first = ManagedClient(client_id=CLIENT_ID, tier="free", speed_kbps=1024)
    second = ManagedClient(client_id=SECOND_CLIENT_ID, tier="premium", speed_kbps=None)

    adapter.apply_clients([first, second], {CLIENT_ID: speed_route(CLIENT_ID)})
    adapter.revoke_client(CLIENT_ID)

    live_path = tmp_path / "state" / "xray-config.json"
    config = json.loads(live_path.read_text(encoding="utf-8"))
    assert [entry["id"] for entry in config["inbounds"][0]["settings"]["clients"]] == [SECOND_CLIENT_ID]
    assert config["outbounds"] == [{"protocol": "freedom", "tag": "direct"}]
    assert "routing" not in config
    assert adapter._speed_routes == {}
    before_disable = live_path.read_text(encoding="utf-8")

    adapter.disable_managed_access()

    assert live_path.read_text(encoding="utf-8") == before_disable
    assert adapter._managed_clients == []
    assert adapter._speed_routes == {}
    assert reloads == [True, True]
    assert lifecycle_events == ["authorize", "authorize", "revoke", "disable"]


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
