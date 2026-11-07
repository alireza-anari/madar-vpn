#!/usr/bin/env python3
"""Short-lived, loopback-only VMess/WebSocket canary for Ariant Madar.

This is deliberately NOT part of customer quota accounting, node agent or
production sales. Do not use it for paid subscribers.
"""
import argparse
import base64
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import uuid

NODE_ID = "c6683027-498d-40ef-ae97-e5a725f0a86f"
NODE_CONFIG = Path("/etc/madar-sales-node/config.json")
XRAY = Path("/opt/madar-sales-node/xray")
ETC = Path("/etc/madar-irancell-canary")
OPT = Path("/opt/madar-irancell-canary")
CONFIG = ETC / "xray.json"
STATE = ETC / "state.json"
INSTALLED_SCRIPT = OPT / "irancell_ws_canary.py"
PORT = 18080
STATS_PORT = 18081
LIFETIME = 15 * 60
CAP_BYTES = 200 * 1024 * 1024
UNIT_PREFIX = "madar-irancell-canary"
SERVICE = UNIT_PREFIX + ".service"
MONITOR = UNIT_PREFIX + "-monitor.service"
TIMER = UNIT_PREFIX + "-monitor.timer"
UNITS = Path("/etc/systemd/system")
MARKER = "# MADAR-ARIANT-IRANCELL-CANARY-v1"
IDENTITY = "madar-irancell-canary"

PRIVATE_RANGES = [
    "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8",
    "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16",
    "198.18.0.0/15", "224.0.0.0/4", "240.0.0.0/4",
    "::1/128", "fc00::/7", "fe80::/10", "ff00::/8",
]


def must_root():
    if os.geteuid() != 0:
        raise ValueError("ROOT_REQUIRED")


def run(*args, timeout=15):
    return subprocess.run(
        list(args), check=True, capture_output=True, text=True, timeout=timeout
    )


def node_identity():
    settings = json.loads(NODE_CONFIG.read_text())
    if (
        settings.get("nodeId") != NODE_ID
        or settings.get("port") != 443
        or settings.get("shared443") is not True
        or settings.get("frontendManaged") is not True
        or settings.get("frontendService") != "madar-sales-xray.service"
    ):
        raise ValueError("WRONG_NODE_OR_FRONTEND")
    for service in ("madar-sales-xray.service", "madar-sales-node.service"):
        run("systemctl", "is-active", "--quiet", service)
    if not XRAY.is_file() or not os.access(XRAY, os.X_OK):
        raise ValueError("XRAY_BINARY_NOT_FOUND")
    return settings


def port_is_free(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", port))


def safe_destination(path):
    if path.is_symlink() or path.exists():
        raise ValueError("CANARY_ALREADY_STAGED")


def private_write(path, content):
    descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write(content)
        handle.flush()
        os.fsync(handle.fileno())


def render_xray(identifier, path):
    if not isinstance(identifier, str):
        raise ValueError("INVALID_UUID")
    uuid.UUID(identifier)
    if not re.fullmatch(r"/madar-[a-f0-9]{24}", path):
        raise ValueError("INVALID_PATH")
    return {
        "log": {"loglevel": "warning"},
        "stats": {},
        "policy": {"levels": {"0": {
            "statsUserUplink": True, "statsUserDownlink": True
        }}},
        "api": {"tag": "irancell-stats-api", "services": ["StatsService"]},
        "inbounds": [
            {
                "tag": "irancell-vmess-ws",
                "listen": "127.0.0.1", "port": PORT,
                "protocol": "vmess",
                "settings": {
                    "clients": [{
                        "id": identifier, "email": IDENTITY, "level": 0
                    }],
                    "disableInsecureEncryption": True,
                },
                "streamSettings": {
                    "network": "ws", "security": "none",
                    "wsSettings": {"path": path},
                },
            },
            {
                "tag": "irancell-stats-api",
                "listen": "127.0.0.1", "port": STATS_PORT,
                "protocol": "dokodemo-door",
                "settings": {"address": "127.0.0.1"},
            },
        ],
        "outbounds": [
            {"tag": "direct", "protocol": "freedom"},
            {"tag": "block", "protocol": "blackhole"},
        ],
        "routing": {
            "domainStrategy": "IPIfNonMatch",
            "rules": [
                {"type": "field", "inboundTag": ["irancell-stats-api"],
                 "outboundTag": "irancell-stats-api"},
                {"type": "field", "ip": PRIVATE_RANGES, "outboundTag": "block"},
            ],
        },
    }


def render_units():
    service = f"""{MARKER}
[Unit]
Description=Madar isolated Irancell VMess WebSocket canary
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
ExecStart={XRAY} run -config {CONFIG}
Restart=no
RuntimeMaxSec={LIFETIME}
TimeoutStopSec=5
MemoryMax=320M
CPUQuota=50%
TasksMax=64
LimitNOFILE=4096
NoNewPrivileges=true
CapabilityBoundingSet=
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
PrivateDevices=true
UMask=0077
[Install]
WantedBy=multi-user.target
"""
    monitor = f"""{MARKER}
[Unit]
Description=Madar short-lived Irancell canary quota watchdog
[Service]
Type=oneshot
ExecStart=/usr/bin/python3 {INSTALLED_SCRIPT} --monitor
NoNewPrivileges=true
PrivateTmp=true
"""
    timer = f"""{MARKER}
[Unit]
Description=Madar Irancell canary watchdog every five seconds
[Timer]
OnActiveSec=5s
OnUnitActiveSec=5s
AccuracySec=1s
Unit={MONITOR}
[Install]
WantedBy=timers.target
"""
    return {SERVICE: service, MONITOR: monitor, TIMER: timer}


def preflight():
    must_root()
    node_identity()
    for path in (ETC, OPT, *(UNITS / name for name in render_units())):
        safe_destination(path)
    for port in (PORT, STATS_PORT):
        port_is_free(port)
    print("ARIANT_CANARY_PREFLIGHT_OK; NODE_ID=" + NODE_ID)
    print("NO_443_CHANGE; NO_SERVICES_RESTARTED; CANARY_NOT_INSTALLED")


def stage():
    preflight()
    identifier = str(uuid.uuid4())
    path = "/madar-" + secrets.token_hex(12)
    candidate = json.dumps(render_xray(identifier, path))
    # Validate before writing any persistent files or systemd units.
    with tempfile.TemporaryDirectory(prefix="madar-irancell-preflight-") as directory:
        test_config = Path(directory) / "xray.json"
        private_write(test_config, candidate)
        run(str(XRAY), "run", "-test", "-config", str(test_config))
    ETC.mkdir(mode=0o700)
    OPT.mkdir(mode=0o700)
    private_write(CONFIG, candidate)
    private_write(STATE, json.dumps({
        "nodeId": NODE_ID, "id": identifier, "path": path,
        "activatedAt": None, "expiresAt": None,
        "capBytes": CAP_BYTES, "version": 1,
    }))
    private_write(INSTALLED_SCRIPT, Path(__file__).read_text())
    os.chmod(INSTALLED_SCRIPT, 0o700)
    for name, contents in render_units().items():
        private_write(UNITS / name, contents)
        os.chmod(UNITS / name, 0o644)
    run("systemctl", "daemon-reload")
    print("ARIANT_CANARY_STAGED; LOOPBACK_ONLY=127.0.0.1:18080")
    print("NOT_RUNNING; NOT_PUBLISHED; NOT_CONNECTED_TO_CUSTOMER_QUOTA")


def state():
    record = json.loads(STATE.read_text())
    if record.get("nodeId") != NODE_ID or record.get("version") != 1:
        raise ValueError("CANARY_STATE_MISMATCH")
    return record


def activate():
    must_root()
    node_identity()
    record = state()
    if record.get("activatedAt") is not None:
        raise ValueError("CANARY_ALREADY_ACTIVATED")
    for port in (PORT, STATS_PORT):
        port_is_free(port)
    run(str(XRAY), "run", "-test", "-config", str(CONFIG))
    record["activatedAt"] = int(time.time())
    record["expiresAt"] = record["activatedAt"] + LIFETIME
    temporary = STATE.with_suffix(".tmp")
    private_write(temporary, json.dumps(record))
    os.replace(temporary, STATE)
    run("systemctl", "start", SERVICE)
    run("systemctl", "start", TIMER)
    print("ARIANT_CANARY_ACTIVE; MAX_SECONDS=900; METER_TARGET_MIB=200")
    print("THIS_IS_A_TEST_CANARY_NOT_A_COMMERCIAL_HARD_QUOTA")


def parse_counters(raw):
    result = json.loads(raw)
    items = result.get("stat", [])
    if not isinstance(items, list):
        raise ValueError("INVALID_STATS")
    names = {
        f"user>>>{IDENTITY}>>>traffic>>>uplink",
        f"user>>>{IDENTITY}>>>traffic>>>downlink",
    }
    seen = set()
    total = 0
    for item in items:
        name = item.get("name")
        value = item.get("value", 0)
        if name not in names or name in seen:
            raise ValueError("INVALID_STATS_NAME")
        if isinstance(value, str) and re.fullmatch(r"[0-9]{1,16}", value):
            value = int(value)
        if type(value) is not int or value < 0 or value > 9_007_199_254_740_991:
            raise ValueError("INVALID_STATS_VALUE")
        seen.add(name)
        total += value
    return total


def stop_canary():
    subprocess.run(["systemctl", "stop", SERVICE], check=False,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(["systemctl", "stop", TIMER], check=False,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def monitor():
    must_root()
    try:
        record = state()
        if not record.get("expiresAt"):
            return
        if time.time() >= record["expiresAt"]:
            stop_canary()
            return
        if run("systemctl", "is-active", SERVICE).stdout.strip() != "active":
            stop_canary()
            return
        result = run(
            str(XRAY), "api", "statsquery",
            "--server=127.0.0.1:" + str(STATS_PORT),
            "-timeout", "1", "-pattern=user>>>", timeout=3,
        )
        if parse_counters(result.stdout) >= record["capBytes"]:
            stop_canary()
    except Exception:
        # Unavailable metering revokes the whole canary, never the original VPN.
        stop_canary()
        raise SystemExit("CANARY_METER_FAILED_CLOSED") from None


def valid_hostname(host):
    if not isinstance(host, str) or not 4 <= len(host) <= 253:
        raise ValueError("INVALID_HOSTNAME")
    labels = host.split(".")
    if len(labels) < 2 or not re.fullmatch(r"[a-zA-Z]{2,63}", labels[-1]) or any(
        not re.fullmatch(r"[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?", x)
        for x in labels
    ):
        raise ValueError("INVALID_HOSTNAME")
    return host.lower()


def import_link(host):
    must_root()
    host = valid_hostname(host)
    record = state()
    config = {
        "v": "2", "ps": "Madar-Irancell-Canary",
        "add": host, "port": "443", "id": record["id"],
        "aid": "0", "scy": "aes-128-gcm",
        "net": "ws", "type": "none", "host": host,
        "path": record["path"], "tls": "tls", "sni": host,
    }
    value = base64.b64encode(
        json.dumps(config, separators=(",", ":")).encode()
    ).decode()
    print("vmess://" + value)


def remove():
    must_root()
    node_identity()
    record = state()
    for name, expected in render_units().items():
        path = UNITS / name
        if path.is_symlink() or path.read_text() != expected:
            raise ValueError("CANARY_UNIT_NOT_OWNED")
    if not record["nodeId"] == NODE_ID:
        raise ValueError("CANARY_NOT_OWNED")
    stop_canary()
    for name in render_units():
        (UNITS / name).unlink()
    run("systemctl", "daemon-reload")
    for p in (CONFIG, STATE, INSTALLED_SCRIPT):
        p.unlink()
    ETC.rmdir()
    OPT.rmdir()
    print("ARIANT_CANARY_REMOVED; MAIN_443_UNCHANGED")


def main():
    parser = argparse.ArgumentParser()
    action = parser.add_mutually_exclusive_group(required=True)
    for flag in ("preflight", "stage", "activate", "monitor", "remove"):
        action.add_argument("--" + flag, action="store_true")
    action.add_argument("--link", metavar="PUBLIC_HOSTNAME")
    args = parser.parse_args()
    if args.preflight:
        preflight()
    elif args.stage:
        stage()
    elif args.activate:
        activate()
    elif args.monitor:
        monitor()
    elif args.remove:
        remove()
    elif args.link:
        import_link(args.link)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        # Never print UUIDs, private link paths or credentials on failure.
        message = str(e)
        if message not in {
            "ROOT_REQUIRED", "WRONG_NODE_OR_FRONTEND", "XRAY_BINARY_NOT_FOUND",
            "CANARY_ALREADY_STAGED", "CANARY_ALREADY_ACTIVATED",
            "CANARY_STATE_MISMATCH", "CANARY_UNIT_NOT_OWNED",
            "CANARY_NOT_OWNED", "INVALID_HOSTNAME",
        }:
            message = "CANARY_OPERATION_FAILED"
        raise SystemExit(message) from None
