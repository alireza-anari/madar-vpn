import ast
import importlib.util
import pathlib
from urllib.parse import parse_qs, urlsplit

SCRIPT = pathlib.Path(__file__).resolve().parents[2] / "scripts" / "vision_ab_field_probe.py"


def module():
    ast.parse(SCRIPT.read_text())
    spec = importlib.util.spec_from_file_location("vision_ab_field_probe", SCRIPT)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def test_field_probe_is_pinned_to_madar_node01_and_bounded():
    m = module()
    assert m.EXPECTED_PUBLIC_IP == "13.51.138.193"
    assert m.EXPECTED_REGION == "eu-north-1"
    assert m.OTHER_NODE_ID == "edde0ebd-5fef-48bf-a9e5-91726324c058"
    assert m.PORTS == (20998, 20999)
    assert m.DURATION_SECONDS <= 15 * 60
    assert m.CLEANUP_SECONDS > m.DURATION_SECONDS
    assert m.MAX_BYTES_PER_ACCOUNT == 200 * 1024 * 1024


def test_plain_and_vision_links_differ_only_by_flow():
    m = module()
    config = {
        "sni": "www.cloudflare.com",
        "publicKey": "A" * 43,
        "shortId": "1234567890abcdef",
    }
    plain = urlsplit(m.link(config, "11111111-1111-4111-8111-111111111111", "", "Plain"))
    vision = urlsplit(m.link(config, "22222222-2222-4222-8222-222222222222",
                             "xtls-rprx-vision", "Vision"))
    assert plain.hostname == vision.hostname == m.EXPECTED_PUBLIC_IP
    assert plain.port == vision.port == 443
    p = parse_qs(plain.query)
    v = parse_qs(vision.query)
    assert "flow" not in p
    assert v["flow"] == ["xtls-rprx-vision"]
    for key in ("encryption", "security", "sni", "fp", "pbk", "sid", "type", "spx"):
        assert p[key] == v[key]


def test_cleanup_kills_only_its_own_worker_command(tmp_path, monkeypatch):
    import os
    m = module()
    calls = []
    monkeypatch.setattr(
        pathlib.Path, "read_bytes",
        lambda self: b"/opt/other/xray\\x00run\\x00-c\\x00/tmp/other.json\\x00",
    )
    monkeypatch.setattr(os, "kill", lambda *args: calls.append(args))
    m.terminate_owned(4321, tmp_path / "worker.json")
    assert calls == []
