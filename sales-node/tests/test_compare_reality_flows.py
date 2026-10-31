import importlib.util
import json
import pathlib
from types import SimpleNamespace

import pytest


SCRIPT = pathlib.Path(__file__).resolve().parents[2] / "scripts" / "compare_reality_flows.py"


def module():
    spec = importlib.util.spec_from_file_location("compare_reality_flows", SCRIPT)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def fixture_config(tmp_path, monkeypatch, m):
    config = tmp_path / "config.json"
    manifest = tmp_path / "manifest.json"
    frontend = tmp_path / "xray.json"
    binary = tmp_path / "xray"
    binary.touch()
    config.write_text(json.dumps({
        "nodeId": m.NODE, "protocolVersion": 2, "shared443": True,
        "frontendManaged": True, "frontendService": m.SERVICE,
        "sni": "www.cloudflare.com", "publicKey": "A" * 43,
        "shortId": "a1b2c3d4", "port": 443,
    }))
    manifest.write_text(json.dumps({"nodeId": m.NODE}))
    frontend.write_text(json.dumps({
        "inbounds": [
            {"tag": "madar-shared-vless", "port": 443, "protocol": "vless",
             "settings": {"clients": []}, "streamSettings": {"security": "reality"}},
        ],
        "api": {"tag": "madar-shared-api", "services": ["HandlerService"]},
        "outbounds": [{"tag": "direct", "protocol": "freedom"}],
        "routing": {"rules": [
            {"type": "field", "inboundTag": ["madar-shared-vless"],
             "user": ["madar-20000"], "outboundTag": "madar-20000"},
        ]},
    }))
    monkeypatch.setattr(m, "CONFIG", config)
    monkeypatch.setattr(m, "MANIFEST", manifest)
    monkeypatch.setattr(m, "FRONTEND", frontend)
    monkeypatch.setattr(m, "XRAY", str(binary))
    monkeypatch.setattr(m, "ROOT", tmp_path / "probes")
    monkeypatch.setattr(m.os, "geteuid", lambda: 0)
    monkeypatch.setattr(m.shutil, "which", lambda name: "/usr/bin/systemd-run")
    monkeypatch.setattr(m, "systemctl", lambda *args: "31415" if "show" in args else "")
    class Socket:
        def __enter__(self):
            return self
        def __exit__(self, *args):
            pass
    monkeypatch.setattr(m.socket, "create_connection", lambda *a, **k: Socket())
    return config, frontend


def test_preflight_refuses_different_node_and_unowned_frontend(tmp_path, monkeypatch):
    m = module()
    config, frontend = fixture_config(tmp_path, monkeypatch, m)
    assert m.preflight()[1:] == ("madar-shared-vless", 31415)
    c = json.loads(config.read_text())
    c["nodeId"] = "another-node"
    config.write_text(json.dumps(c))
    with pytest.raises(ValueError, match="WRONG_NODE"):
        m.preflight()
    c["nodeId"] = m.NODE
    c["frontendManaged"] = False
    config.write_text(json.dumps(c))
    with pytest.raises(ValueError, match="UNSUPPORTED_ARCHITECTURE"):
        m.preflight()


def test_preflight_rejects_global_public_redirect_and_existing_test(tmp_path, monkeypatch):
    m = module()
    _, frontend = fixture_config(tmp_path, monkeypatch, m)
    c = json.loads(frontend.read_text())
    c["routing"]["rules"].insert(0, {
        "type": "field", "inboundTag": ["madar-shared-vless"],
        "outboundTag": "blocked",
    })
    frontend.write_text(json.dumps(c))
    with pytest.raises(ValueError, match="AMBIGUOUS_PUBLIC_ROUTING"):
        m.preflight()
    c["routing"]["rules"].pop(0)
    frontend.write_text(json.dumps(c))
    active = m.ROOT / "deadbeefcafe"
    active.mkdir(parents=True)
    (active / "state.json").write_text("{}")
    with pytest.raises(ValueError, match="ANOTHER_PROBE_IS_ACTIVE"):
        m.preflight()


def test_runtime_add_matches_existing_xray_api_shape(tmp_path, monkeypatch):
    m = module()
    fixture_config(tmp_path, monkeypatch, m)
    calls = []
    def fake_run(args, **kwargs):
        if args[0] == m.XRAY:
            cfg = json.loads(pathlib.Path(args[-1]).read_text())
            calls.append((args, cfg))
            return SimpleNamespace(stdout="Added 1 user(s) in total.")
        raise AssertionError(args)
    monkeypatch.setattr(m.subprocess, "run", fake_run)
    m.api_add("madar-shared-vless", "2de28958-3b0e-4e82-84cb-c8e1d3bc51fd",
              "flowprobe-aabbccddeeff-vision", "xtls-rprx-vision", tmp_path)
    assert calls[0][1]["inbounds"][0]["settings"]["clients"][0]["flow"] == "xtls-rprx-vision"
    assert calls[0][0][0] == m.XRAY
    assert not list(tmp_path.glob("flowprobe-*.json"))


def test_timer_armed_before_any_unmetered_user_created(tmp_path, monkeypatch):
    m = module()
    fixture_config(tmp_path, monkeypatch, m)
    events = []
    def run(args, **kwargs):
        events.append(("timer", args))
        assert args[0] == "systemd-run"
        assert "--on-active=720s" in args
        return SimpleNamespace(stdout="")
    monkeypatch.setattr(m.subprocess, "run", run)
    def add(tag, ident, email, flow, directory):
        events.append(("add", flow))
    monkeypatch.setattr(m, "api_add", add)
    m.apply()
    assert events[0][0] == "timer"
    assert [e[1] for e in events[1:]] == ["xtls-rprx-vision", ""]
    assert len(list(m.ROOT.glob("*/state.json"))) == 1


def test_cleanup_removes_both_users_and_state(tmp_path, monkeypatch):
    m = module()
    fixture_config(tmp_path, monkeypatch, m)
    identifier = "112233445566"
    directory = m.ROOT / identifier
    directory.mkdir(parents=True)
    state = directory / "state.json"
    state.write_text(json.dumps({
        "nodeId": m.NODE, "frontendPid": 31415,
        "frontendTag": "madar-shared-vless",
        "emails": ["flowprobe-112233445566-vision", "flowprobe-112233445566-plain"],
    }))
    (directory / "cleanup.py").touch()
    removed = []
    monkeypatch.setattr(m, "api_remove", lambda tag, name: removed.append(name))
    m.cleanup(state)
    assert len(removed) == 2
    assert not directory.exists()


def test_cleanup_refuses_wrong_node_and_keeps_state(tmp_path, monkeypatch):
    m = module()
    fixture_config(tmp_path, monkeypatch, m)
    directory = m.ROOT / "112233445566"
    directory.mkdir(parents=True)
    state = directory / "state.json"
    state.write_text(json.dumps({
        "nodeId": "other-node", "frontendPid": 31415,
        "frontendTag": "madar-shared-vless", "emails": []
    }))
    with pytest.raises(ValueError, match="INVALID_PROBE_STATE"):
        m.cleanup(state)
    assert state.exists()
