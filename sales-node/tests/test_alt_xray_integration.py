"""Real Xray 26.3.27 dynamic API smoke test on isolated GitHub CI runner.

No production interaction, no route to an actual VPN backend, public listeners
are rewritten to loopback for this test. Opt in by MADAR_XRAY_BIN env variable.
"""
import base64
import json
import os
import pathlib
import socket
import subprocess
import time

import pytest

from reality_alt import API_PORT, render_reality_alt

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
