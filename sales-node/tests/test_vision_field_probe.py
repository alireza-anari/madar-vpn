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
    assert m.EXPECTED_NODE_ID == "c5e6a942-8d8c-4c20-8698-323d08490a2c"
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


def test_limit_and_meter_failure_cutoff_stops_worker_before_removing_user(monkeypatch):
    import subprocess
    m = module()
    trace = []
    class FakeWorker:
        running = True
        def poll(self):
            return None if self.running else 0
        def terminate(self):
            trace.append("terminate")
            self.running = False
        def wait(self, timeout):
            trace.append("wait")
            return 0
    worker = FakeWorker()
    monkeypatch.setattr(m, "frontend_pid", lambda: 501)
    def fake_run(args, **kwargs):
        assert worker.running is False
        trace.append("rmu")
        assert args[:3] == [m.XRAY, "api", "rmu"]
        assert args[-1] == "madar-20998"
        return subprocess.CompletedProcess(args, 0)
    monkeypatch.setattr(m, "run", fake_run)
    m.stop_test_account("Vision", 20998, worker, "madar-shared-vless",
                        501, "LIMIT_REACHED")
    assert trace == ["terminate", "wait", "rmu"]


def test_cutoff_refuses_to_touch_new_frontend(monkeypatch):
    m = module()
    class FakeWorker:
        def poll(self): return 0
    monkeypatch.setattr(m, "frontend_pid", lambda: 502)
    monkeypatch.setattr(m, "run", lambda *_args, **_kw: (_ for _ in ()).throw(AssertionError("Must not remove user from changed frontend")))
    import pytest
    with pytest.raises(ValueError, match="FRONTEND_CHANGED"):
        m.stop_test_account("Vision", 20998, FakeWorker(), "madar-shared-vless",
                            501, "METER_FAILED")


def test_meter_fail_closed_and_cap_stop_are_wired_in_main_loop():
    source = SCRIPT.read_text()
    assert "stop_test_account(label, port, process, frontend_tag," in source
    assert '"LIMIT_REACHED"' in source
    assert '"METER_FAILED"' in source
    assert 'stopped.add(label)' in source
    assert '"COUNTER_DECREASED"' in source
