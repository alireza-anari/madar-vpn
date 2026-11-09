"""Real Xray 26.3.27 dynamic API smoke test on isolated GitHub CI runner.

No production interaction, no route to an actual VPN backend, public listeners
are rewritten to loopback for this test. Opt in by MADAR_XRAY_BIN env variable.
"""
import base64
import json
import os
import pathlib
import socket
import ssl
import subprocess
import time

import pytest

from reality_alt import API_PORT, render_reality_alt
from ws_fallback import API_PORT as WS_API_PORT, WS_PORT, render_ws_frontend

XRAY = os.environ.get("MADAR_XRAY_BIN")
pytestmark = pytest.mark.skipif(not XRAY, reason="real Xray smoke is CI opt-in")
UUID = "11111111-1111-4111-8111-111111111111"


def wait_port(port, process, timeout=8):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise AssertionError(f"xray exited: {process.returncode}")
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=.2):
                return
        except OSError:
            time.sleep(.1)
    raise AssertionError(f"xray did not bind {port}")


def run_api(*args):
    return subprocess.run(
        [XRAY, "api", *args], timeout=10, check=True, capture_output=True,
        text=True,
    ).stdout


def test_real_xray_accepts_two_approved_ports_same_account_and_revokes_each(tmp_path):
    settings = {
        "bridgeKey": "a" * 64,
        "shared443": True,
        "frontendManaged": True,
        "sni": "www.cloudflare.com",
        "privateKey": base64.urlsafe_b64encode(bytes(range(1, 33))).decode().rstrip("="),
        "shortId": "1234567890abcdef",
    }
    config = render_reality_alt(settings, [2053, 8443], account_ports=[20000])
    # CI sandbox is isolated. Never bind public listeners even in tests.
    for inbound in config["inbounds"]:
        inbound["listen"] = "127.0.0.1"
    path = tmp_path / "xray-alt.json"
    path.write_text(json.dumps(config))
    subprocess.run(
        [XRAY, "run", "-test", "-c", str(path)],
        timeout=15, check=True, capture_output=True, text=True,
    )
    proc = subprocess.Popen(
        [XRAY, "run", "-c", str(path)],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        for port in [API_PORT, 2053, 8443]:
            wait_port(port, proc)
        client = tmp_path / "client.json"
        client.write_text(json.dumps({
            "inbounds": [{
                "tag": f"madar-reality-{port}",
                "port": port,
                "protocol": "vless",
                "settings": {
                    "decryption": "none",
                    "clients": [{
                        "id": UUID, "email": "madar-20000",
                        "flow": "", "level": 0,
                    }],
                },
            } for port in [2053, 8443]],
        }))
        result = run_api("adu", f"--server=127.0.0.1:{API_PORT}",
                         "-timeout", "3", str(client))
        assert "Added 2 user(s) in total." in result, result
        for port in [2053, 8443]:
            result = run_api(
                "rmu", f"--server=127.0.0.1:{API_PORT}",
                "-timeout", "3", "-tag=" + f"madar-reality-{port}",
                "madar-20000",
            )
            assert "Removed 1 user(s)" in result, result
    finally:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=5)


def test_real_xray_accepts_metered_vmess_ws_user_and_revokes_it(tmp_path):
    endpoint = {
        "type": "vmess-ws-aead",
        "hostname": "vpn.example.com",
        "path": "/madar-" + "a" * 24,
    }
    settings = {
        "bridgeKey": "b" * 64,
        "shared443": True,
        "frontendManaged": True,
    }
    config = render_ws_frontend(settings, endpoint, ports=[20000])
    # Xray only accepts clients on 127.0.0.1; no public ingress exists here.
    assert all(i["listen"] == "127.0.0.1" for i in config["inbounds"])
    assert config["outbounds"][0]["protocol"] == "blackhole"
    path = tmp_path / "xray-ws.json"
    path.write_text(json.dumps(config))
    subprocess.run(
        [XRAY, "run", "-test", "-c", str(path)],
        timeout=15, check=True, capture_output=True, text=True,
    )
    proc = subprocess.Popen(
        [XRAY, "run", "-c", str(path)],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        wait_port(WS_API_PORT, proc)
        wait_port(WS_PORT, proc)
        client = tmp_path / "vmess-client.json"
        client.write_text(json.dumps({
            "inbounds": [{
                "tag": "madar-secondary-ws", "port": WS_PORT,
                "protocol": "vmess",
                "settings": {
                    "clients": [{
                        "id": UUID, "alterId": 0,
                        "email": "madar-20000", "level": 0,
                    }],
                },
            }],
        }))
        result = run_api(
            "adu", f"--server=127.0.0.1:{WS_API_PORT}",
            "-timeout", "3", str(client),
        )
        assert "Added 1 user(s) in total." in result, result
        result = run_api(
            "rmu", f"--server=127.0.0.1:{WS_API_PORT}",
            "-timeout", "3", "-tag=madar-secondary-ws", "madar-20000",
        )
        assert "Removed 1 user(s)" in result, result
    finally:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=5)


def test_real_xray_public_ip_san_2087_wss_config_and_tls_socket(tmp_path, monkeypatch):
    """Validate actual pinned Xray core with real TLS 2087 and IP SAN."""
    import ws_fallback
    ip = "8.8.8.8"
    path_cert = tmp_path / "fullchain.pem"
    path_key = tmp_path / "privkey.pem"
    subprocess.run([
        "openssl", "req", "-x509", "-nodes", "-newkey", "rsa:2048",
        "-days", "2", "-subj", "/CN=8.8.8.8",
        "-addext", "subjectAltName=IP:8.8.8.8",
        "-keyout", str(path_key), "-out", str(path_cert),
    ], check=True, timeout=20, capture_output=True)
    settings = {
        "bridgeKey": "c" * 64,
        "shared443": True, "frontendManaged": True,
        "wssIpAddress": ip,
        "wssTlsCert": "/etc/letsencrypt/live/" + ip + "/fullchain.pem",
        "wssTlsKey": "/etc/letsencrypt/live/" + ip + "/privkey.pem",
    }
    endpoint = {
        "type": "vmess-ws-aead", "hostname": ip,
        "path": "/madar-" + "b" * 24, "port": 2087,
    }
    original = pathlib.Path.is_file
    def mock_is_file(self):
        if str(self) in (settings["wssTlsCert"], settings["wssTlsKey"]):
            return True
        return original(self)
    monkeypatch.setattr(pathlib.Path, "is_file", mock_is_file)
    conf = ws_fallback.render_ws_frontend(settings, endpoint, ports=[20000])
    inbound = conf["inbounds"][0]
    assert inbound["listen"] == "0.0.0.0"
    assert inbound["port"] == 2087
    assert conf["outbounds"][0]["protocol"] == "blackhole"
    inbound["listen"] = "127.0.0.1"
    inbound["streamSettings"]["tlsSettings"]["certificates"] = [{
        "certificateFile": str(path_cert),
        "keyFile": str(path_key),
    }]
    config = tmp_path / "wss-ip-tls.json"
    config.write_text(json.dumps(conf))
    subprocess.run([XRAY, "run", "-test", "-c", str(config)],
                   check=True, timeout=20, capture_output=True, text=True)
    proc = subprocess.Popen([XRAY,"run","-c",str(config)],
                            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL)
    try:
        wait_port(2087,proc)
        ctx = ssl.create_default_context(cafile=str(path_cert))
        with socket.create_connection(("127.0.0.1",2087), timeout=3) as conn:
            with ctx.wrap_socket(conn,server_hostname=ip) as sock:
                assert sock.version() in ("TLSv1.2","TLSv1.3")
    finally:
        if proc.poll() is None:
            proc.terminate()
            proc.wait(timeout=5)
