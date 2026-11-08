import json
import os
import subprocess
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
    assert SECONDS <= 1200


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


def test_generated_config_parses_on_real_pinned_xray(tmp_path):
    binary = os.getenv("MADAR_XRAY_BIN")
    if not binary:
        pytest.skip("Pinned real Xray binary only in integrated CI")
    conf = build_config(original_config(), "11111111-1111-4111-8111-111111111111")
    path = tmp_path / "field.json"
    path.write_text(json.dumps(conf))
    subprocess.run([binary, "run", "-test", "-c", str(path)],
                   check=True, capture_output=True, timeout=20)
