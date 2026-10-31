"""Ephemeral same-IP REALITY A/B test on Madar AWS Stockholm 2.

Adds exactly two temporary users through the already-running Xray Handler API:
XTLS Vision and plain VLESS. No service restart, config-file mutation, D1
sale, cloud resource or security-group change. NOT for regular customer use.
"""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import time
import uuid
from urllib.parse import urlencode

NODE = "edde0ebd-5fef-48bf-a9e5-91726324c058"
ROOT = Path("/run/madar-reality-flow-probes")
CONFIG = Path("/etc/madar-sales-node/config.json")
MANIFEST = Path("/opt/madar-sales-node/manifest.json")
FRONTEND = Path("/run/madar-sales-node/xray.json")
XRAY = "/opt/madar-sales-node/xray"
DURATION_SECONDS = 12 * 60
SERVICE = "madar-sales-xray.service"


def read_json(path):
    if path.is_symlink() or not path.is_file():
        raise ValueError("UNSAFE_OR_MISSING_FILE")
    return json.loads(path.read_text())


def systemctl(*arguments):
    return subprocess.run(["systemctl", *arguments], check=True,
                          capture_output=True, text=True, timeout=5).stdout.strip()


def preflight():
    if os.geteuid() != 0:
        raise ValueError("ROOT_REQUIRED")
    config = read_json(CONFIG)
    manifest = read_json(MANIFEST)
    if config.get("nodeId") != NODE or manifest.get("nodeId") != NODE:
        raise ValueError("WRONG_NODE")
    if not (config.get("protocolVersion") == 2
            and config.get("shared443") is True
            and config.get("frontendManaged") is True
            and config.get("frontendService") == SERVICE
            and config.get("port", 443) == 443):
        raise ValueError("UNSUPPORTED_ARCHITECTURE")
    for service in ("madar-sales-node.service", SERVICE,
                    "madar-sales-watchdog.timer"):
        systemctl("is-active", "--quiet", service)
    frontend = read_json(FRONTEND)
    public = [entry for entry in frontend.get("inbounds", [])
              if entry.get("port") == 443 and entry.get("protocol") == "vless"
              and entry.get("streamSettings", {}).get("security") == "reality"]
    if len(public) != 1:
        raise ValueError("PUBLIC_INBOUND_AMBIGUOUS")
    inbound = public[0]
    if inbound.get("settings", {}).get("clients") != []:
        raise ValueError("NOT_FRESH_FRONTEND")
    tag = inbound.get("tag")
    if tag != "madar-shared-vless":
        raise ValueError("UNEXPECTED_PUBLIC_TAG")
    if frontend.get("api", {}).get("tag") != "madar-shared-api" or (
        "HandlerService" not in frontend.get("api", {}).get("services", [])
    ):
        raise ValueError("HANDLER_NOT_AVAILABLE")
    outs = frontend.get("outbounds", [])
    if not outs or outs[0].get("protocol") != "freedom":
        raise ValueError("DEFAULT_ROUTE_NOT_DIRECT")
    # A broad rule involving the public inbound would invalidate our A/B test.
    for rule in frontend.get("routing", {}).get("rules", []):
        if tag in rule.get("inboundTag", []) and "user" not in rule:
            raise ValueError("AMBIGUOUS_PUBLIC_ROUTING")
    if not re.fullmatch(r"[A-Za-z0-9.-]+", str(config.get("sni", ""))):
        raise ValueError("INVALID_SNI")
    if not re.fullmatch(r"[A-Za-z0-9_-]{32,64}", str(config.get("publicKey", ""))):
        raise ValueError("INVALID_PUBLIC_KEY")
    if not re.fullmatch(r"[a-f0-9]{2,16}", str(config.get("shortId", ""))):
        raise ValueError("INVALID_SHORT_ID")
    if not Path(XRAY).is_file():
        raise ValueError("XRAY_BINARY_MISSING")
    if shutil.which("systemd-run") is None:
        raise ValueError("SYSTEMD_RUN_MISSING")
    with socket.create_connection(("127.0.0.1", 19999), timeout=2):
        pass
    if ROOT.exists() and (ROOT.is_symlink() or any(ROOT.glob("*/state.json"))):
        raise ValueError("ANOTHER_PROBE_IS_ACTIVE")
    pid = int(systemctl("show", SERVICE, "--property=MainPID", "--value"))
    if pid < 1:
        raise ValueError("FRONTEND_NOT_RUNNING")
    return config, tag, pid


def api_add(tag, ident, email, flow, directory):
    path = directory / (email + ".json")
    value = {"inbounds": [{
        "tag": tag, "port": 443, "protocol": "vless",
        "settings": {"decryption": "none", "clients": [{
            "id": ident, "email": email, "flow": flow, "level": 0
        }]}
    }]}
    path.write_text(json.dumps(value))
    path.chmod(0o600)
    try:
        result = subprocess.run(
            [XRAY, "api", "adu", "--server=127.0.0.1:19999",
             "-timeout", "2", str(path)],
            capture_output=True, text=True, timeout=6, check=True)
        if "Added 1 user(s) in total." not in result.stdout:
            raise ValueError("ACCOUNT_NOT_ADDED")
    finally:
        path.unlink(missing_ok=True)


def api_remove(tag, email):
    subprocess.run(
        [XRAY, "api", "rmu", "--server=127.0.0.1:19999",
         "-timeout", "2", "-tag=" + tag, email],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        timeout=6)


def cleanup(state_path):
    if not re.fullmatch(r"[0-9a-f]{12}", state_path.parent.name):
        raise ValueError("INVALID_PROBE_PATH")
    if state_path.parent.parent != ROOT or state_path.name != "state.json":
        raise ValueError("INVALID_PROBE_PATH")
    state = read_json(state_path)
    if state.get("nodeId") != NODE or state.get("frontendTag") != "madar-shared-vless":
        raise ValueError("INVALID_PROBE_STATE")
    # If the original frontend died/restarted, its dynamic users vanished too.
    current_pid = int(systemctl("show", SERVICE, "--property=MainPID", "--value"))
    failures = []
    if current_pid == state["frontendPid"]:
        for name in state["emails"]:
            try:
                api_remove(state["frontendTag"], name)
            except (OSError, ValueError, subprocess.SubprocessError):
                failures.append(name)
    if failures:
        raise ValueError("PROBE_CLEANUP_RETRY_REQUIRED")
    # No active credentials left on the original public frontend.
    for name in ("state.json", "cleanup.py"):
        (state_path.parent / name).unlink(missing_ok=True)
    state_path.parent.rmdir()
    print("TEMPORARY_PROBES_REMOVED")


def issue_link(config, ident, flow, label):
    query = urlencode({
        "encryption": "none", "flow": flow, "security": "reality",
        "sni": config["sni"], "fp": "chrome",
        "pbk": config["publicKey"], "sid": config["shortId"], "type": "tcp",
    })
    return f"vless://{ident}@13.62.181.33:443?{query}#Madar-{label}"


def apply():
    config, tag, pid = preflight()
    probe_id = uuid.uuid4().hex[:12]
    directory = ROOT / probe_id
    directory.mkdir(mode=0o700, parents=True, exist_ok=False)
    identities = [
        ("vision", str(uuid.uuid4()), "xtls-rprx-vision"),
        ("plain", str(uuid.uuid4()), ""),
    ]
    emails = ["flowprobe-" + probe_id + "-" + item[0] for item in identities]
    state_path = directory / "state.json"
    state_path.write_text(json.dumps({
        "nodeId": NODE, "frontendPid": pid,
        "frontendTag": tag, "emails": emails,
        "expiresAt": int(time.time()) + DURATION_SECONDS,
    }))
    state_path.chmod(0o600)
    # Independent cleanup copy survives deleting the downloaded launch script.
    local_script = directory / "cleanup.py"
    local_script.write_bytes(Path(__file__).read_bytes())
    local_script.chmod(0o700)
    timer = "madar-reality-probe-" + probe_id
    installed = []
    try:
        # Arm expiry BEFORE adding any live credentials.
        subprocess.run([
            "systemd-run", "--quiet", "--unit=" + timer,
            "--on-active=" + str(DURATION_SECONDS) + "s",
            "/usr/bin/python3", str(local_script),
            "--cleanup", str(state_path),
        ], capture_output=True, check=True, timeout=12)
        for index, (name, ident, flow) in enumerate(identities):
            if int(systemctl("show", SERVICE, "--property=MainPID", "--value")) != pid:
                raise ValueError("FRONTEND_RESTARTED")
            # Cleanup includes all two emails, even if an API call reports failure
            # after adding the user, so the timer can still remove it later.
            api_add(tag, ident, emails[index], flow, directory)
            installed.append(emails[index])
    except Exception:
        # Keep the armed timer and state if immediate cleanup fails.
        for email in emails:
            try:
                api_remove(tag, email)
            except Exception:
                pass
        raise
    print("TEMPORARY_TEST_USERS_READY")
    print("Expires in", DURATION_SECONDS // 60, "minutes")
    print("1) VISION:", issue_link(config, identities[0][1], identities[0][2], "Vision-Test"))
    print("2) PLAIN:", issue_link(config, identities[1][1], identities[1][2], "Plain-Test"))
    print("Do not share these URLs in chat. Disconnect the test VPNs after the experiment.")
    print("Automatic user removal is scheduled; already-open sessions may persist until disconnected.")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--cleanup", type=Path)
    args = parser.parse_args()
    try:
        if args.cleanup is not None:
            cleanup(args.cleanup)
        elif args.apply:
            apply()
        else:
            preflight()
            print("SAFE_PREFLIGHT_OK: node, routing, Xray API and cleanup scheduler verified.")
            print("No users added. Add --apply to start a 12-minute A/B test.")
    except Exception as error:
        print("FLOW_PROBE_FAILED:" + type(error).__name__ +
              (":" + str(error) if isinstance(error, ValueError) else ""))
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
