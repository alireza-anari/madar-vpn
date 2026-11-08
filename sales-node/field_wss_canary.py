"""One-use, fail-closed, isolated VMess/WSS FIELD TEST behind an existing Caddy.

This is NOT a commercial Madar account. No bot issuance or cross-protocol
shared quota is implied. A 50 MB sampled cap can overshoot between checks.
Never use this for paying customers. Does not touch any other EC2 node.
"""
import argparse
import base64
import copy
import json
import os
import pathlib
import pwd
import re
import shutil
import signal
import socket
import subprocess
import time
import uuid

ROOT = pathlib.Path("/etc/madar-wss-canary")
CONFIG = ROOT / "config.json"
PATH_FILE = ROOT / "ws-path"
CADDY = pathlib.Path("/etc/caddy/Caddyfile")
UNIT = pathlib.Path("/etc/systemd/system/madar-xray-wss-canary.service")
BIN = pathlib.Path("/opt/madar-wss-test/xray")
DATA = pathlib.Path("/var/lib/madar-wss-field")
STATE = DATA / "state.json"
BACKUP_CONFIG = ROOT / "config.before-field-test.json"
BACKUP_UNIT = ROOT / "unit.before-field-test.service"
LIMIT = 50_000_000
SECONDS = 1200
EMAIL = "madar-wss-field"
API_PORT = 18081
DOMAIN = "madar-test.loomera.ir"

PRIVATE_IPS = [
    "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10",
    "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12",
    "192.0.0.0/24", "192.168.0.0/16", "198.18.0.0/15",
    "224.0.0.0/4", "240.0.0.0/4", "::1/128", "fc00::/7",
    "fe80::/10", "ff00::/8",
]


def fail(code):
    raise SystemExit(code)


def atomic_json(path, value):
    temp = path.with_name(path.name + ".new")
    with open(temp, "w") as stream:
        json.dump(value, stream, separators=(",", ":"))
        stream.flush()
        os.fsync(stream.fileno())
    os.chmod(temp, 0o600)
    os.replace(temp, path)


def eligible(original, path, caddy):
    """Never adopt an unrelated listener or existing metered account."""
    if not re.fullmatch(r"/madar-[a-f0-9]{24}", path):
        fail("INVALID_WS_PATH")
    if ("madar-test.loomera.ir {" not in caddy or
            f"@madarxray path {path}" not in caddy or
            "reverse_proxy @madarxray 127.0.0.1:18080" not in caddy):
        fail("CADDY_ROUTE_MISMATCH")
    inputs = original.get("inbounds", [])
    if len(inputs) != 1:
        fail("UNEXPECTED_INBOUNDS")
    inbound = inputs[0]
    if (inbound.get("listen") != "127.0.0.1" or
            inbound.get("port") != 18080 or
            inbound.get("protocol") != "vmess" or
            inbound.get("settings", {}).get("clients") != [] or
            inbound.get("settings", {}).get("disableInsecureEncryption") is not True or
            inbound.get("streamSettings", {}).get("wsSettings", {}).get("path") != path):
        fail("UNEXPECTED_XRAY_CONFIG")
    if original.get("outbounds") != [{"tag": "blocked", "protocol": "blackhole"}]:
        fail("UNSAFE_EXISTING_OUTBOUNDS")
    if not BIN.is_file() or not UNIT.is_file():
        fail("MISSING_OWNED_CANARY")
    return True


def build_config(original, ident):
    config = copy.deepcopy(original)
    config["inbounds"][0]["settings"]["clients"] = [{
        "id": ident, "alterId": 0, "email": EMAIL, "level": 0,
    }]
    config["inbounds"].append({
        "tag": "field-stats-api",
        "listen": "127.0.0.1", "port": API_PORT,
        "protocol": "dokodemo-door",
        "settings": {"address": "127.0.0.1"},
    })
    config["api"] = {"tag": "field-stats-api", "services": ["StatsService"]}
    config["stats"] = {}
    config["policy"] = {"levels": {"0": {
        "statsUserUplink": True, "statsUserDownlink": True,
    }}, "system": {
        "statsInboundUplink": True, "statsInboundDownlink": True,
    }}
    config["outbounds"].append({
        "tag": "field-direct", "protocol": "freedom",
    })
    config["routing"] = {
        "domainStrategy": "IPIfNonMatch",
        "rules": [
            {"type": "field", "inboundTag": ["field-stats-api"],
             "outboundTag": "field-stats-api"},
            {"type": "field", "inboundTag": ["madar-wss-canary"],
             "ip": PRIVATE_IPS, "outboundTag": "blocked"},
            {"type": "field", "inboundTag": ["madar-wss-canary"],
             "user": [EMAIL], "outboundTag": "field-direct"},
            {"type": "field", "inboundTag": ["madar-wss-canary"],
             "outboundTag": "blocked"},
        ]
    }
    return config


def unit_text():
    return """[Unit]
Description=Madar isolated one-use metered field test (NOT production)
After=network.target

[Service]
Type=simple
User=nobody
Group=nogroup
ExecStart=/usr/bin/python3 /opt/madar-wss-test/field_wss_canary.py serve
Restart=no
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/madar-wss-field
ProtectHome=true
PrivateTmp=true
MemoryMax=384M

[Install]
WantedBy=multi-user.target
"""


def prepare():
    if os.geteuid() != 0:
        fail("ROOT_REQUIRED")
    if DATA.exists() or BACKUP_CONFIG.exists() or BACKUP_UNIT.exists():
        fail("FIELD_ALREADY_PREPARED")
    path = PATH_FILE.read_text().strip()
    old = json.loads(CONFIG.read_text())
    eligible(old, path, CADDY.read_text())
    with socket.socket() as sock:
        try:
            sock.bind(("127.0.0.1", API_PORT))
        except OSError:
            fail("STATS_API_BUSY")
    ident = str(uuid.uuid4())
    candidate = build_config(old, ident)
    candidate_path = ROOT / "candidate.field.json"
    atomic_json(candidate_path, candidate)
    try:
        subprocess.run([str(BIN), "run", "-test", "-c", str(candidate_path)],
                       check=True, timeout=15)
    except Exception:
        candidate_path.unlink(missing_ok=True)
        raise

    nobody = pwd.getpwnam("nobody")
    DATA.mkdir(mode=0o700)
    os.chown(DATA, nobody.pw_uid, nobody.pw_gid)
    state = {
        "status": "armed", "uuid": ident,
        "expiresAt": int(time.time()) + SECONDS,
        "quotaBytes": LIMIT, "usedBytes": 0,
    }
    atomic_json(STATE, state)
    os.chown(STATE, nobody.pw_uid, nobody.pw_gid)
    shutil.copy2(CONFIG, BACKUP_CONFIG)
    shutil.copy2(UNIT, BACKUP_UNIT)
    try:
        subprocess.run(["systemctl", "stop", "madar-xray-wss-canary"],
                       check=True, timeout=20)
        # Xray and the one-use supervisor run as nobody, not root.
        # Keep the private test UUID unreadable to other local users.
        os.chown(candidate_path, nobody.pw_uid, nobody.pw_gid)
        os.replace(candidate_path, CONFIG)
        UNIT.write_text(unit_text())
        subprocess.run(["systemctl", "daemon-reload"], check=True)
        subprocess.run(["systemctl", "start", "madar-xray-wss-canary"],
                       check=True, timeout=20)
        time.sleep(1)
        if subprocess.run(["systemctl", "is-active", "--quiet",
                           "madar-xray-wss-canary"]).returncode:
            fail("FIELD_SERVICE_NOT_ACTIVE")
    except BaseException:
        shutil.copy2(BACKUP_CONFIG, CONFIG)
        shutil.copy2(BACKUP_UNIT, UNIT)
        subprocess.run(["systemctl", "daemon-reload"], check=False)
        subprocess.run(["systemctl", "restart", "madar-xray-wss-canary"],
                       check=False)
        raise
    # Do not hand out a credential until the metering API has returned a
    # valid initial sample. Previously the link was printed while the
    # supervisor was still retrying and about to crash on a missing value.
    deadline = time.monotonic() + 12
    while True:
        status = json.loads(STATE.read_text())
        alive = subprocess.run(["systemctl", "is-active", "--quiet",
                                "madar-xray-wss-canary"]).returncode == 0
        if not alive or status.get("status") != "running":
            fail("FIELD_METER_NOT_READY")
        if status.get("meterReady") is True:
            break
        if time.monotonic() >= deadline:
            fail("FIELD_METER_NOT_READY")
        time.sleep(.25)

    payload = {
        "v": "2", "ps": "Madar-WSS-Field-20min-50MB",
        "add": DOMAIN, "port": "443", "id": ident, "aid": "0",
        "scy": "auto", "net": "ws", "type": "none",
        "host": DOMAIN, "path": path, "tls": "tls", "sni": DOMAIN,
    }
    encoded = base64.b64encode(
        json.dumps(payload, separators=(",", ":")).encode()
    ).decode()
    print("FIELD_TEST_ONLY_20_MINUTES_50_MB_SAMPLED_CAP")
    print("KEEP_THIS_LINK_PRIVATE")
    print("vmess://" + encoded)


def read_total():
    query = subprocess.run([
        str(BIN), "api", "statsquery",
        f"--server=127.0.0.1:{API_PORT}",
        "-pattern=traffic>>>",
    ], capture_output=True, text=True, check=True, timeout=3)
    data = json.loads(query.stdout)
    stats = data.get("stat", [])
    if not isinstance(stats, list):
        raise ValueError("STATS_INVALID")
    user_total = 0
    inbound_total = 0
    recognized = 0
    for item in stats:
        name = item.get("name", "")
        if name in (f"user>>>{EMAIL}>>>traffic>>>uplink",
                    f"user>>>{EMAIL}>>>traffic>>>downlink",
                    "inbound>>>madar-wss-canary>>>traffic>>>uplink",
                    "inbound>>>madar-wss-canary>>>traffic>>>downlink"):
            # Xray uses protobuf JSON; zero-valued uint64 counters can
            # legitimately omit the "value" field entirely.
            raw = item.get("value", 0)
            if isinstance(raw, bool) or not isinstance(raw, (str, int)):
                raise ValueError("STATS_INVALID_VALUE")
            number = int(raw)
            recognized += 1
            if number < 0:
                raise ValueError("STATS_NEGATIVE")
            if name.startswith("user>>>"):
                user_total += number
            else:
                inbound_total += number
    if recognized == 0:
        raise ValueError("STATS_UNAVAILABLE")
    # Single-user inbound: additionally count everything crossing the
    # listener, even if user-level accounting is absent or delayed.
    return max(user_total, inbound_total)


def serve():
    if os.geteuid() == 0:
        fail("UNPRIVILEGED_RUNTIME_REQUIRED")
    state = json.loads(STATE.read_text())
    if state.get("status") != "armed":
        fail("ONE_USE_CANARY_LOCKED")
    if int(time.time()) >= state["expiresAt"]:
        fail("FIELD_EXPIRED")
    state["status"] = "running"
    atomic_json(STATE, state)
    process = subprocess.Popen([
        str(BIN), "run", "-c", str(CONFIG)
    ], stdin=subprocess.DEVNULL)
    def stop(*_):
        raise KeyboardInterrupt()
    signal.signal(signal.SIGTERM, stop)
    try:
        deadline = time.monotonic() + 7
        while True:
            if process.poll() is not None:
                raise RuntimeError("XRAY_EXITED")
            try:
                used = read_total()
                break
            except Exception:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(.3)
        state["meterReady"] = True
        atomic_json(STATE, state)
        while True:
            if time.time() >= state["expiresAt"]:
                state["status"] = "expired"
                break
            if process.poll() is not None:
                raise RuntimeError("XRAY_EXITED")
            used = read_total()
            if used < state["usedBytes"]:
                raise RuntimeError("STATS_DECREASED")
            state["usedBytes"] = used
            if used >= state["quotaBytes"]:
                state["status"] = "exhausted"
            atomic_json(STATE, state)
            if state["status"] == "exhausted":
                break
            time.sleep(.5)
    except BaseException:
        state["status"] = "stopped"
        raise
    finally:
        process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        atomic_json(STATE, state)


def retry_failed_zero_usage():
    """One isolated retry for the previously crashed, zero-traffic canary.

    No changes to Caddy, other nodes, or the production bot. The old UUID
    becomes invalid. A retry marker prevents unlimited restarts with fresh
    50 MB quotas. Never use this for commercial access.
    """
    if os.geteuid() != 0:
        fail("ROOT_REQUIRED")
    marker = ROOT / "field-retry-issued"
    if marker.exists():
        fail("FIELD_RETRY_ALREADY_USED")
    if not STATE.is_file() or not BACKUP_CONFIG.is_file() or not BACKUP_UNIT.is_file():
        fail("FIELD_BACKUPS_MISSING")
    state = json.loads(STATE.read_text())
    if (state.get("status") != "stopped" or
            type(state.get("usedBytes")) is not int or
            state["usedBytes"] != 0 or
            not isinstance(state.get("uuid"), str)):
        fail("NOT_ZERO_USAGE_FAILURE")
    if subprocess.run(["systemctl", "is-active", "--quiet",
                       "madar-xray-wss-canary"]).returncode == 0:
        fail("FIELD_SERVICE_STILL_ACTIVE")
    for port in (18080, API_PORT):
        with socket.socket() as sock:
            try:
                sock.bind(("127.0.0.1", port))
            except OSError:
                fail("FIELD_LISTENER_STILL_ACTIVE")
    path = PATH_FILE.read_text().strip()
    original = json.loads(BACKUP_CONFIG.read_text())
    eligible(original, path, CADDY.read_text())
    if UNIT.read_text() != unit_text():
        fail("FIELD_UNIT_CHANGED")
    if json.loads(CONFIG.read_text()) != build_config(original, state["uuid"]):
        fail("FIELD_CONFIG_CHANGED")
    backup_unit = BACKUP_UNIT.read_text()
    if ("field_wss_canary.py" in backup_unit or
            "ExecStart=/opt/madar-wss-test/xray run -c /etc/madar-wss-canary/config.json"
            not in backup_unit):
        fail("ORIGINAL_UNIT_INVALID")
    marker.write_text("zero-usage failure retry issued at " + str(int(time.time())) + "\\n")
    marker.chmod(0o600)
    # Restoring the original zero-client/blackhole-only canary invalidates
    # the old VMess UUID before any new credentials are generated.
    shutil.copy2(BACKUP_CONFIG, CONFIG)
    shutil.copy2(BACKUP_UNIT, UNIT)
    subprocess.run(["systemctl", "daemon-reload"], check=True)
    STATE.unlink()
    DATA.rmdir()
    BACKUP_CONFIG.unlink()
    BACKUP_UNIT.unlink()
    prepare()


def status():
    if not STATE.exists():
        print("not prepared")
        return
    state = json.loads(STATE.read_text())
    state.pop("uuid", None)
    print(json.dumps(state, indent=2))


def main():
    arg = argparse.ArgumentParser()
    arg.add_argument("action", choices=["prepare", "serve", "status", "retry-zero"])
    args = arg.parse_args()
    if args.action == "prepare":
        prepare()
    elif args.action == "serve":
        serve()
    elif args.action == "retry-zero":
        retry_failed_zero_usage()
    else:
        status()


if __name__ == "__main__":
    main()
