import json
import os
import subprocess
import time
from types import SimpleNamespace

import pytest

from field_wss_canary import (
    API_PORT, DOMAIN, EMAIL, LIMIT, SECONDS, build_config,
    eligible, read_total,
)


def original_config(path="/madar-" + "a" * 24):
    return {
        "inbounds": [{
            "tag": "madar-wss-canary", "listen": "127.0.0.1",
            "port": 18080, "protocol": "vmess",
            "settings": {"clients": [], "disableInsecureEncryption": True},
            "streamSettings": {
                "network": "ws", "security": "none",
                "wsSettings": {"path": path},
            },
        }],
        "outbounds": [{"tag": "blocked", "protocol": "blackhole"}],
        "routing": {"rules": [{
            "type": "field", "inboundTag": ["madar-wss-canary"],
            "outboundTag": "blocked",
        }]},
    }


def test_real_xray_starts_without_clients_and_test_user_can_only_egress_via_explicit_match():
    before = original_config()
    ident = "11111111-1111-4111-8111-111111111111"
    conf = build_config(before, ident)
    assert before["inbounds"][0]["settings"]["clients"] == []
    assert conf["inbounds"][0]["listen"] == "127.0.0.1"
    assert conf["inbounds"][0]["port"] == 18080
    assert conf["inbounds"][0]["settings"]["clients"] == [{
        "id": ident, "alterId": 0, "email": EMAIL, "level": 0,
    }]
    assert conf["inbounds"][1]["listen"] == "127.0.0.1"
    assert conf["inbounds"][1]["port"] == API_PORT
    assert conf["api"]["services"] == ["StatsService"]
    assert conf["policy"]["levels"]["0"]["statsUserDownlink"] is True
    assert conf["policy"]["system"]["statsInboundDownlink"] is True
    assert conf["outbounds"][0] == {"tag": "blocked", "protocol": "blackhole"}
    assert conf["outbounds"][1] == {"tag": "field-direct", "protocol": "freedom"}
    rules = conf["routing"]["rules"]
    assert rules[0]["outboundTag"] == "field-stats-api"
    assert rules[1]["outboundTag"] == "blocked"
    assert "127.0.0.0/8" in rules[1]["ip"]
    assert rules[2]["user"] == [EMAIL]
    assert rules[2]["outboundTag"] == "field-direct"
    assert rules[-1]["outboundTag"] == "blocked"
    assert LIMIT <= 50_000_000
    assert SECONDS <= 3600


def test_adoption_rejects_existing_clients_and_outbound_changes(monkeypatch, tmp_path):
    import field_wss_canary as mod
    binary = tmp_path / "xray"
    unit = tmp_path / "canary.service"
    binary.write_bytes(b"test")
    unit.write_text("test")
    monkeypatch.setattr(mod, "BIN", binary)
    monkeypatch.setattr(mod, "UNIT", unit)
    path = "/madar-" + "a" * 24
    caddy = f"""madar-test.loomera.ir {{
    @madarxray path {path}
    reverse_proxy @madarxray 127.0.0.1:18080
}}"""
    assert eligible(original_config(), path, caddy)
    bad = original_config()
    bad["inbounds"][0]["settings"]["clients"] = [{"id": "pre-existing"}]
    with pytest.raises(SystemExit, match="UNEXPECTED_XRAY_CONFIG"):
        eligible(bad, path, caddy)
    bad = original_config()
    bad["outbounds"] = [{"tag": "direct", "protocol": "freedom"}]
    with pytest.raises(SystemExit, match="UNSAFE_EXISTING_OUTBOUNDS"):
        eligible(bad, path, caddy)
    with pytest.raises(SystemExit, match="CADDY_ROUTE_MISMATCH"):
        eligible(original_config(), path, "unrelated.example.com")


def test_stats_counts_both_directions_and_rejects_invalid_data(monkeypatch):
    import field_wss_canary as mod

    def result(data):
        return subprocess.CompletedProcess([], 0, stdout=json.dumps(data))

    sample = {"stat": [
        {"name": f"user>>>{EMAIL}>>>traffic>>>uplink", "value": "123"},
        {"name": f"user>>>{EMAIL}>>>traffic>>>downlink", "value": "456"},
        {"name": "unrelated", "value": "1000000"},
        {"name": "inbound>>>madar-wss-canary>>>traffic>>>downlink", "value": "700"},
    ]}
    monkeypatch.setattr(mod.subprocess, "run", lambda *args, **kw: result(sample))
    assert read_total() == 700
    monkeypatch.setattr(mod.subprocess, "run",
                        lambda *args, **kw: result({"stat": [
                            {"name": f"user>>>{EMAIL}>>>traffic>>>uplink", "value": "-1"},
                        ]}))
    with pytest.raises(ValueError, match="STATS_NEGATIVE"):
        read_total()

    # Actual Xray zero traffic response omits protobuf's default "value".
    monkeypatch.setattr(mod.subprocess, "run",
                        lambda *args, **kw: result({"stat": [
                            {"name": f"user>>>{EMAIL}>>>traffic>>>uplink"},
                            {"name": "inbound>>>madar-wss-canary>>>traffic>>>downlink"},
                        ]}))
    assert read_total() == 0

    monkeypatch.setattr(mod.subprocess, "run",
                        lambda *args, **kw: result({}))
    with pytest.raises(ValueError, match="STATS_UNAVAILABLE"):
        read_total()


def test_generated_config_parses_on_real_pinned_xray(tmp_path):
    binary = os.getenv("MADAR_XRAY_BIN")
    if not binary:
        pytest.skip("Pinned real Xray binary only in integrated CI")
    conf = build_config(original_config(), "11111111-1111-4111-8111-111111111111")
    path = tmp_path / "field.json"
    path.write_text(json.dumps(conf))
    subprocess.run([binary, "run", "-test", "-c", str(path)],
                   check=True, capture_output=True, timeout=20)

def test_retry_refuses_rearming_active_service_or_consumed_quota(
        monkeypatch, tmp_path):
    import field_wss_canary as mod
    data = tmp_path / "data"
    data.mkdir()
    state = data / "state.json"
    state.write_text(json.dumps({
        "status": "stopped", "uuid": "11111111-1111-4111-8111-111111111111",
        "usedBytes": 1,
    }))
    backup_conf = tmp_path / "config.before-field-test.json"
    backup_unit = tmp_path / "unit.before-field-test.service"
    backup_conf.write_text("{}")
    backup_unit.write_text("x")
    monkeypatch.setattr(mod, "ROOT", tmp_path)
    monkeypatch.setattr(mod, "DATA", data)
    monkeypatch.setattr(mod, "STATE", state)
    monkeypatch.setattr(mod, "BACKUP_CONFIG", backup_conf)
    monkeypatch.setattr(mod, "BACKUP_UNIT", backup_unit)
    monkeypatch.setattr(mod.os, "geteuid", lambda: 0)

    with pytest.raises(SystemExit, match="NOT_ZERO_USAGE_FAILURE"):
        mod.retry_failed_zero_usage()

    state.write_text(json.dumps({
        "status": "stopped", "uuid": "11111111-1111-4111-8111-111111111111",
        "usedBytes": 0,
    }))
    monkeypatch.setattr(mod.subprocess, "run",
                        lambda *args, **kw: subprocess.CompletedProcess([], 0))
    with pytest.raises(SystemExit, match="FIELD_SERVICE_STILL_ACTIVE"):
        mod.retry_failed_zero_usage()


@pytest.mark.parametrize("mode,field_status,bytes_used,marker_name", [
    ("zero", "stopped", 0, "field-retry-issued"),
    ("expired", "expired", 9716451, "field-expiry-retry-issued"),
])
def test_retry_resets_only_exact_owned_canary(
        monkeypatch, tmp_path, mode, field_status, bytes_used, marker_name):
    import field_wss_canary as mod
    old_uuid = "11111111-1111-4111-8111-111111111111"
    backup = original_config()
    data = tmp_path / "data"
    data.mkdir()
    state = data / "state.json"
    state.write_text(json.dumps({
        "status": field_status, "uuid": old_uuid,
        "usedBytes": bytes_used, "quotaBytes": LIMIT,
        "expiresAt": int(time.time()) - 20, "meterReady": True,
    }))
    backup_conf = tmp_path / "config.before-field-test.json"
    backup_unit = tmp_path / "unit.before-field-test.service"
    config = tmp_path / "config.json"
    unit = tmp_path / "canary.service"
    path_file = tmp_path / "ws-path"
    caddy = tmp_path / "Caddyfile"
    binary = tmp_path / "xray"
    path = "/madar-" + "a" * 24
    path_file.write_text(path)
    caddy.write_text(f"""madar-test.loomera.ir {{
    @madarxray path {path}
    reverse_proxy @madarxray 127.0.0.1:18080
}}""")
    backup_conf.write_text(json.dumps(backup))
    backup_unit.write_text(
        "[Service]\\nExecStart=/opt/madar-wss-test/xray run -c /etc/madar-wss-canary/config.json\\n"
    )
    config.write_text(json.dumps(build_config(backup, old_uuid)))
    unit.write_text(mod.unit_text())
    binary.write_bytes(b"binary")
    for key, val in (
        ("ROOT", tmp_path), ("DATA", data), ("STATE", state),
        ("BACKUP_CONFIG", backup_conf), ("BACKUP_UNIT", backup_unit),
        ("CONFIG", config), ("UNIT", unit), ("PATH_FILE", path_file),
        ("CADDY", caddy), ("BIN", binary),
    ):
        monkeypatch.setattr(mod, key, val)
    monkeypatch.setattr(mod.os, "geteuid", lambda: 0)
    monkeypatch.setattr(mod.subprocess, "run", lambda *args, **kw:
                        subprocess.CompletedProcess(args, 1 if args and "is-active" in args[0] else 0))
    called = []
    monkeypatch.setattr(mod, "prepare", lambda: called.append(True))
    mod.retry_failed_zero_usage(mode)
    assert called == [True]
    assert (tmp_path / marker_name).exists()
    assert json.loads(config.read_text()) == backup
    assert "ExecStart=/opt/madar-wss-test/xray run -c /etc/madar-wss-canary/config.json" in unit.read_text()
    assert not state.exists()
    assert not backup_conf.exists()
    with pytest.raises(SystemExit, match="FIELD_RETRY_ALREADY_USED"):
        mod.retry_failed_zero_usage(mode)


def test_expired_rearm_disallows_live_or_unmetered_field(monkeypatch, tmp_path):
    import field_wss_canary as mod
    state = tmp_path / "state.json"
    backup_config = tmp_path / "backup.json"
    backup_unit = tmp_path / "backup.service"
    backup_config.write_text("{}")
    backup_unit.write_text("unit")
    monkeypatch.setattr(mod, "ROOT", tmp_path)
    monkeypatch.setattr(mod, "STATE", state)
    monkeypatch.setattr(mod, "BACKUP_CONFIG", backup_config)
    monkeypatch.setattr(mod, "BACKUP_UNIT", backup_unit)
    monkeypatch.setattr(mod.os, "geteuid", lambda: 0)
    baseline = {
        "uuid": "11111111-1111-4111-8111-111111111111",
        "status": "expired", "meterReady": True,
        "expiresAt": int(time.time()) - 1,
        "usedBytes": 9716451, "quotaBytes": LIMIT,
    }
    for bad in [
        {**baseline, "status": "stopped"},
        {**baseline, "meterReady": False},
        {**baseline, "expiresAt": int(time.time()) + 60},
        {**baseline, "usedBytes": LIMIT},
        {**baseline, "usedBytes": -1},
    ]:
        state.write_text(json.dumps(bad))
        with pytest.raises(SystemExit, match="NOT_EXPIRED_METERED_FIELD|INVALID_FIELD_STATE"):
            mod.retry_failed_zero_usage("expired")
