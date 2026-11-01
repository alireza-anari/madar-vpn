#!/usr/bin/env python3
"""Temporary same-node REALITY A/B field probe. No service restart or D1/quota DB writes."""
import argparse
import json
import os
import pathlib
import re
import shutil
import signal
import socket
import subprocess
import sys
import time
import uuid
from urllib.parse import urlencode
from urllib.request import Request, urlopen

ROOT = pathlib.Path("/opt/madar-sales-node")
CONFIG = pathlib.Path("/etc/madar-sales-node/config.json")
FRONTEND = pathlib.Path("/run/madar-sales-node/xray.json")
PROBE_ROOT = pathlib.Path("/run/madar-sales-node")
XRAY = str(ROOT / "xray")
SERVICE = "madar-sales-xray.service"
AGENT = "madar-sales-node.service"
WATCHDOG = "madar-sales-watchdog.timer"
EXPECTED_PUBLIC_IP = "13.51.138.193"
EXPECTED_REGION = "eu-north-1"
OTHER_NODE_ID = "edde0ebd-5fef-48bf-a9e5-91726324c058"
PORTS = (20998, 20999)
DURATION_SECONDS = 12 * 60
CLEANUP_SECONDS = 15 * 60
MAX_BYTES_PER_ACCOUNT = 200 * 1024 * 1024
FLOWS = (("Plain", ""), ("Vision", "xtls-rprx-vision"))


def run(args, *, timeout=8, check=True):
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=check)


def read_json(path):
    path = pathlib.Path(path)
    if path.is_symlink() or not path.is_file():
        raise ValueError("UNSAFE_OR_MISSING_FILE:" + str(path))
    return json.loads(path.read_text())


def metadata(path):
    token_req = Request(
        "http://169.254.169.254/latest/api/token",
        method="PUT",
        headers={"X-aws-ec2-metadata-token-ttl-seconds": "60"},
    )
    with urlopen(token_req, timeout=2) as response:
        token = response.read().decode()
    req = Request(
        "http://169.254.169.254/latest/meta-data/" + path,
        headers={"X-aws-ec2-metadata-token": token},
    )
    with urlopen(req, timeout=2) as response:
        return response.read().decode().strip()


def frontend_pid():
    value = run([
        "systemctl", "show", SERVICE, "--property=MainPID", "--value"
    ]).stdout.strip()
    pid = int(value)
    if pid <= 1:
        raise ValueError("FRONTEND_NOT_RUNNING")
    return pid


def preflight():
    if os.geteuid() != 0:
        raise ValueError("ROOT_REQUIRED")
    config = read_json(CONFIG)
    frontend = read_json(FRONTEND)
    if config.get("nodeId") == OTHER_NODE_ID:
        raise ValueError("WRONG_NODE_STOCKHOLM2")
    if metadata("public-ipv4") != EXPECTED_PUBLIC_IP:
        raise ValueError("WRONG_PUBLIC_IP")
    if metadata("placement/region") != EXPECTED_REGION:
        raise ValueError("WRONG_AWS_REGION")
    if not (
        config.get("protocolVersion") == 2
        and config.get("shared443") is True
        and config.get("frontendManaged") is True
        and config.get("frontendService") == SERVICE
        and config.get("port") == 443
    ):
        raise ValueError("UNSUPPORTED_NODE_ARCHITECTURE")
    for service in (AGENT, SERVICE, WATCHDOG):
        run(["systemctl", "is-active", "--quiet", service])
    if not re.fullmatch(r"[0-9a-f]{64}", str(config.get("bridgeKey", ""))):
        raise ValueError("INVALID_BRIDGE_KEY")
    for field in ("privateKey", "publicKey", "shortId", "sni", "nodeId"):
        if not isinstance(config.get(field), str) or not config[field]:
            raise ValueError("MISSING_NODE_SETTING:" + field)
    if not re.fullmatch(r"[A-Za-z0-9_-]{32,64}", config["publicKey"]):
        raise ValueError("INVALID_PUBLIC_KEY")
    if not re.fullmatch(r"[a-f0-9]{2,16}", config["shortId"]):
        raise ValueError("INVALID_SHORT_ID")
    if not re.fullmatch(r"[A-Za-z0-9.-]+", config["sni"]):
        raise ValueError("INVALID_SNI")
    public = [
        item for item in frontend.get("inbounds", [])
        if item.get("port") == 443
        and item.get("protocol") == "vless"
        and item.get("streamSettings", {}).get("security") == "reality"
    ]
    if len(public) != 1:
        raise ValueError("PUBLIC_REALITY_INBOUND_AMBIGUOUS")
    inbound = public[0]
    tag = inbound.get("tag")
    if tag != "madar-shared-vless":
        raise ValueError("UNEXPECTED_PUBLIC_INBOUND_TAG")
    api = frontend.get("api", {})
    if api.get("tag") != "madar-shared-api" or "HandlerService" not in api.get("services", []):
        raise ValueError("HANDLER_API_NOT_CONFIGURED")
    api_inbounds = [
        item for item in frontend.get("inbounds", [])
        if item.get("tag") == "madar-shared-api"
    ]
    if len(api_inbounds) != 1 or api_inbounds[0].get("listen") != "127.0.0.1" or api_inbounds[0].get("port") != 19999:
        raise ValueError("HANDLER_API_NOT_LOOPBACK")
    for port in PORTS:
        name = f"madar-{port}"
        outbound = next((x for x in frontend.get("outbounds", []) if x.get("tag") == name), None)
        if not outbound:
            raise ValueError("BRIDGE_ROUTE_MISSING")
        vnext = outbound.get("settings", {}).get("vnext", [])
        if len(vnext) != 1 or vnext[0].get("address") != "127.0.0.1" or vnext[0].get("port") != port:
            raise ValueError("BRIDGE_ROUTE_UNSAFE")
        if not any(r.get("user") == [name] and r.get("outboundTag") == name for r in frontend.get("routing", {}).get("rules", [])):
            raise ValueError("BRIDGE_ROUTING_MISSING")
    listeners = run(["ss", "-H", "-lnt"]).stdout
    for port in (*PORTS, *(p + 1000 for p in PORTS)):
        if re.search(rf":{port}(?:\\s|$)", listeners):
            raise ValueError("PROBE_PORT_BUSY:" + str(port))
    if not pathlib.Path(XRAY).is_file():
        raise ValueError("XRAY_BINARY_MISSING")
    version = run([XRAY, "version"]).stdout.splitlines()[0]
    if "Xray 26.3.27" not in version:
        raise ValueError("UNEXPECTED_XRAY_VERSION")
    with socket.create_connection(("127.0.0.1", 19999), timeout=2):
        pass
    if list(PROBE_ROOT.glob("vision-ab-field-*")):
        raise ValueError("ANOTHER_FIELD_PROBE_EXISTS")
    return config, tag, frontend_pid()


def save_state(path, state):
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(state))
    temp.chmod(0o600)
    temp.replace(path)


def terminate_owned(pid, config_path):
    if not isinstance(pid, int) or pid <= 1:
        return
    proc = pathlib.Path(f"/proc/{pid}/cmdline")
    try:
        cmdline = proc.read_bytes().replace(b"\x00", b" ").decode(errors="replace")
    except FileNotFoundError:
        return
    if XRAY not in cmdline or str(config_path) not in cmdline:
        return
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        if not pathlib.Path(f"/proc/{pid}").exists():
            return
        time.sleep(.05)
    try:
        current = proc.read_bytes().replace(b"\x00", b" ").decode(errors="replace")
        if XRAY in current and str(config_path) in current:
            os.kill(pid, signal.SIGKILL)
    except (FileNotFoundError, ProcessLookupError):
        pass


def cleanup(state_path):
    state_path = pathlib.Path(state_path)
    if state_path.name != "state.json" or state_path.parent.parent != PROBE_ROOT or not state_path.parent.name.startswith("vision-ab-field-"):
        raise ValueError("INVALID_CLEANUP_PATH")
    if not state_path.exists():
        print("FIELD_PROBE_ALREADY_CLEAN")
        return
    state = read_json(state_path)
    current = read_json(CONFIG)
    if state.get("nodeId") != current.get("nodeId"):
        raise ValueError("CLEANUP_NODE_MISMATCH")
    timer = state.get("timerUnit")
    if isinstance(timer, str) and re.fullmatch(r"madar-vision-ab-[0-9a-f]{12}", timer):
        subprocess.run(["systemctl", "stop", timer + ".timer"], capture_output=True, timeout=5)
    for pid, config_path in zip(state.get("workerPids", []), state.get("workerConfigs", [])):
        terminate_owned(pid, config_path)
    # Only remove dynamic users from the exact frontend process that received them.
    # If the frontend restarted, its in-memory users vanished; do not touch a new
    # process that may since have reused one of these email/port labels.
    try:
        same_frontend = frontend_pid() == state.get("frontendPid")
    except Exception:
        same_frontend = False
    if same_frontend:
        for email in state.get("emails", []):
            if not isinstance(email, str) or not email.startswith("madar-"):
                continue
            subprocess.run(
                [XRAY, "api", "rmu", "--server=127.0.0.1:19999",
                 "-timeout", "1", "-tag=" + state["frontendTag"], email],
                capture_output=True, timeout=5,
            )
    else:
        print("FRONTEND_CHANGED; old dynamic users are gone, skipped API removal")
    shutil.rmtree(state_path.parent, ignore_errors=False)
    print("TEMPORARY_PLAIN_AND_VISION_ACCOUNTS_REMOVED")


def add_frontend_user(tag, api, port, ident, flow, directory):
    email = f"madar-{port}"
    path = directory / f"{port}.frontend.json"
    payload = {"inbounds": [{
        "tag": tag, "port": 443, "protocol": "vless",
        "settings": {"decryption": "none", "clients": [{
            "id": ident, "email": email, "flow": flow, "level": 0
        }]}
    }]}
    path.write_text(json.dumps(payload))
    path.chmod(0o600)
    try:
        result = run([
            XRAY, "api", "adu", "--server=" + api,
            "-timeout", "1", str(path)
        ], timeout=4)
        if "Added 1 user(s) in total." not in result.stdout:
            raise ValueError("FRONTEND_USER_NOT_ADDED")
    finally:
        path.unlink(missing_ok=True)
    return email


def link(config, ident, flow, label):
    params = [
        ("encryption", "none"), ("security", "reality"),
        ("sni", config["sni"]), ("fp", "chrome"),
        ("pbk", config["publicKey"]), ("sid", config["shortId"]),
        ("type", "tcp"), ("spx", "/"),
    ]
    if flow:
        params.insert(1, ("flow", flow))
    return f"vless://{ident}@{EXPECTED_PUBLIC_IP}:443?{urlencode(params)}#Madar-{label}"


def start_probe():
    config, frontend_tag, original_pid = preflight()
    from shared443 import backend_config
    from stats import read_counters

    probe_id = uuid.uuid4().hex[:12]
    directory = PROBE_ROOT / ("vision-ab-field-" + probe_id)
    directory.mkdir(mode=0o700)
    state_path = directory / "state.json"
    timer = "madar-vision-ab-" + probe_id
    state = {
        "nodeId": config["nodeId"], "frontendTag": frontend_tag,
        "frontendPid": original_pid, "timerUnit": timer,
        "emails": [f"madar-{p}" for p in PORTS],
        "workerPids": [], "workerConfigs": [],
    }
    save_state(state_path, state)
    script = ROOT / "vision_ab_field_probe.py"
    try:
        subprocess.run([
            "systemd-run", "--quiet", "--unit=" + timer,
            "--on-active=" + str(CLEANUP_SECONDS) + "s",
            "/usr/bin/python3", str(script), "--cleanup", str(state_path)
        ], check=True, capture_output=True, timeout=12)
    except Exception:
        shutil.rmtree(directory, ignore_errors=True)
        raise

    settings = dict(config)
    settings.update({
        "port": 443, "shared443": True, "frontendManaged": True,
        "frontendService": SERVICE,
    })
    api = "127.0.0.1:19999"
    processes = []
    try:
        for (label, flow), port in zip(FLOWS, PORTS):
            account = f"vision-field-{probe_id}-{label.lower()}"
            ident = str(uuid.uuid4())
            client = {
                "accountId": account, "uuid": ident, "listenPort": port,
                "validUntil": int(time.time()) + DURATION_SECONDS,
            }
            worker = backend_config(settings, client, int(time.time()))
            path = directory / f"worker-{port}.json"
            path.write_text(json.dumps(worker))
            path.chmod(0o600)
            run([XRAY, "run", "-test", "-c", str(path)], timeout=10)
            process = subprocess.Popen(
                [XRAY, "run", "-c", str(path)],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, start_new_session=True,
            )
            processes.append(process)
            state["workerPids"].append(process.pid)
            state["workerConfigs"].append(str(path))
            save_state(state_path, state)
            deadline = time.monotonic() + 5
            stats_port = port + 1000
            while True:
                try:
                    with socket.create_connection(("127.0.0.1", stats_port), timeout=.2):
                        break
                except OSError:
                    if process.poll() is not None or time.monotonic() > deadline:
                        raise ValueError("METER_WORKER_NOT_READY")
                    time.sleep(.05)
            email = add_frontend_user(frontend_tag, api, port, ident, flow, directory)
            if email != state["emails"][len(state["workerPids"]) - 1]:
                raise ValueError("EMAIL_MISMATCH")
            state.setdefault("added", []).append(email)
            save_state(state_path, state)
            print(f"{label.upper()}_LINK:")
            print(link(config, ident, flow, label + "-Field-Test"))

        print("\nA_B_FIELD_TEST_READY")
        print("Same AWS node, same IP:443, same SNI/REALITY key/short-id; only public VLESS flow differs.")
        print("Test each link on IranCell and Hamrah Aval in the same location, one connection at a time.")
        print("The per-account loopback metering workers stay plain VLESS. No D1/quota DB or customer account is changed.")
        print(f"Each test account is capped at {MAX_BYTES_PER_ACCOUNT // (1024*1024)} MiB by this temporary sampler.")
        print(f"Automatic cleanup is armed for {CLEANUP_SECONDS // 60} minutes. Press Ctrl+C when finished.")
        deadline = time.monotonic() + DURATION_SECONDS
        last_print = 0
        capped = set()
        while time.monotonic() < deadline and len(capped) < len(PORTS):
            if frontend_pid() != original_pid:
                raise ValueError("FRONTEND_RESTARTED_DURING_TEST")
            now = time.monotonic()
            totals = {}
            for (label, _flow), port in zip(FLOWS, PORTS):
                if label in capped:
                    totals[label] = "CAPPED"
                    continue
                account = f"vision-field-{probe_id}-{label.lower()}"
                try:
                    values = read_counters(f"127.0.0.1:{port+1000}", [account], XRAY, allow_unregistered=True)
                    total = 0 if values is None else values[account]
                    totals[label] = total
                    if total >= MAX_BYTES_PER_ACCOUNT:
                        capped.add(label)
                except Exception:
                    totals[label] = "METER_RETRY"
            if now - last_print >= 5:
                def fmt(value):
                    return value if isinstance(value, str) else f"{value/(1024*1024):.1f} MiB"
                print("METER:", " | ".join(f"{k}={fmt(v)}" for k,v in totals.items()), flush=True)
                last_print = now
            if len(capped) == len(PORTS):
                print("BOTH_TEST_ACCOUNTS_REACHED_TEMPORARY_CAP")
                break
            for process in processes:
                if process.poll() is not None:
                    raise ValueError("METER_WORKER_EXITED")
            time.sleep(1)
    finally:
        cleanup(state_path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--preflight", action="store_true")
    parser.add_argument("--start", action="store_true")
    parser.add_argument("--cleanup", type=pathlib.Path)
    args = parser.parse_args()
    try:
        if args.cleanup:
            cleanup(args.cleanup)
        elif args.preflight:
            config, _tag, pid = preflight()
            print("FIELD_PREFLIGHT_OK")
            print("NODE_ID:", config["nodeId"])
            print("PUBLIC_IP:", EXPECTED_PUBLIC_IP)
            print("REGION:", EXPECTED_REGION)
            print("FRONTEND_PID:", pid)
            print("TEST_PORTS:", ",".join(str(p) for p in PORTS))
            print("NO_SERVICES_RESTARTED; NO_USERS_ADDED")
        elif args.start:
            start_probe()
        else:
            parser.error("use --preflight, --start or --cleanup")
    except KeyboardInterrupt:
        print("\nFIELD_TEST_INTERRUPTED; cleanup requested")
        raise
    except Exception as error:
        print("FIELD_PROBE_FAILED:" + type(error).__name__ +
              (":" + str(error) if isinstance(error, ValueError) else ""))
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
