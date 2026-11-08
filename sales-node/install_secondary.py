"""Opt-in one-shot secondary REALITY installer; never stops/modifies :443.

Requires root and exact SHA-256 pinned sources from one Git commit.
The administrator must execute this ON the owned Madar VPS, not on the runner.
"""
import argparse
import hashlib
import json
import os
import pathlib
import re
import socket
import subprocess
import tempfile
import urllib.request

REPO = "https://raw.githubusercontent.com/alireza-anari/madar-vpn/"
SOURCE_FILES = ("secondary_sidecar.py", "reality_alt.py", "policy.py", "shared443.py", "xray.py")
OWNED = pathlib.Path("/opt/madar-sales-node")
CONFIG = pathlib.Path("/etc/madar-sales-node/config.json")
SECONDARY = pathlib.Path("/opt/madar-sales-secondary")
UNIT = pathlib.Path("/etc/systemd/system/madar-sales-secondary.service")
X = "/opt/madar-sales-node/xray"
UNIT_SOURCE = """[Unit]
Description=Madar Optional REALITY Multi-Port Sidecar (independent of 443)
After=network-online.target madar-sales-node.service
Wants=network-online.target
[Service]
Type=simple
User=root
Group=root
WorkingDirectory=/opt/madar-sales-secondary
ExecStart=/usr/bin/python3 /opt/madar-sales-secondary/secondary_sidecar.py
Restart=on-failure
RestartSec=5
KillMode=control-group
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
[Install]
WantedBy=multi-user.target
"""


def download(ref, path):
    if not re.fullmatch(r"[a-f0-9]{40}", ref) or "/" in path or ".." in path:
        raise ValueError("INVALID_PINNED_SOURCE")
    req = urllib.request.Request(
        REPO + ref + "/sales-node/" + path,
        headers={"User-Agent": "MadarSecondaryInstaller/1.0"},
    )
    with urllib.request.urlopen(req, timeout=20) as response:
        data = response.read(1048577)
    if len(data) > 1048576:
        raise ValueError("SOURCE_TOO_LARGE")
    return data


def assert_original_untouched(config, node_id):
    if OWNED.is_symlink() or CONFIG.is_symlink() or not CONFIG.is_file():
        raise ValueError("OWNERSHIP_MISMATCH")
    manifest = json.loads((OWNED / "manifest.json").read_text())
    if manifest.get("nodeId") != node_id or config.get("nodeId") != node_id or \
       config.get("shared443") is not True or \
       config.get("frontendManaged") is not True or \
       config.get("protocolVersion") != 2 or \
       config.get("port") != 443 or \
       not config.get("bridgeKey") or not config.get("nodeToken"):
        raise ValueError("OWNERSHIP_MISMATCH")
    if not pathlib.Path(X).is_file():
        raise ValueError("XRAY_NOT_OWNED")
    for service in ("madar-sales-node.service", "madar-sales-xray.service"):
        subprocess.run(
            ["systemctl", "is-active", "--quiet", service],
            timeout=5, check=True, capture_output=True,
        )
    frontend_pid = int(subprocess.run(
        ["systemctl", "show", "madar-sales-xray.service",
         "--property=MainPID", "--value"],
        timeout=5, check=True, capture_output=True, text=True,
    ).stdout.strip())
    if frontend_pid <= 1 or \
       pathlib.Path("/proc/" + str(frontend_pid) + "/exe").resolve() != pathlib.Path(X).resolve():
        raise ValueError("PRIMARY_FRONTEND_IDENTITY_MISMATCH")
    for port in (2053, 8443):
        with socket.socket() as s:
            try:
                s.bind(("0.0.0.0", port))
            except OSError:
                raise ValueError("OPTIONAL_PORT_BUSY") from None


def fetch_and_verify(ref, manifest_digest):
    payload = download(ref, "secondary-source-manifest.json")
    if hashlib.sha256(payload).hexdigest() != manifest_digest:
        raise ValueError("SECONDARY_MANIFEST_HASH_MISMATCH")
    manifest = json.loads(payload)
    if set(manifest) != set(SOURCE_FILES) or \
       not all(isinstance(h, str) and re.fullmatch(r"[a-f0-9]{64}", h)
               for h in manifest.values()):
        raise ValueError("SECONDARY_MANIFEST_INVALID")
    files = {}
    for name, digest in manifest.items():
        data = download(ref, name)
        if hashlib.sha256(data).hexdigest() != digest:
            raise ValueError("SOURCE_HASH_MISMATCH")
        compile(data, name, "exec")
        files[name] = data
    return files


def install(node_id, ref, manifest_digest):
    if os.geteuid() != 0 or \
       not re.fullmatch(r"[a-f0-9-]{36}", node_id) or \
       not re.fullmatch(r"[a-f0-9]{40}", ref) or \
       not re.fullmatch(r"[a-f0-9]{64}", manifest_digest):
        raise ValueError("INVALID_INSTALL_ARGUMENT")
    config = json.loads(CONFIG.read_text())
    assert_original_untouched(config, node_id)
    if SECONDARY.is_symlink() or UNIT.is_symlink() or \
       SECONDARY.exists() or UNIT.exists():
        raise ValueError("SECONDARY_ALREADY_PRESENT")
    files = fetch_and_verify(ref, manifest_digest)
    # Full staging succeeds before the first irreversible service action.
    SECONDARY.mkdir(mode=0o700, parents=False)
    try:
        for name, data in files.items():
            target = SECONDARY / name
            with open(target, "xb") as f:
                f.write(data)
            os.chmod(target, 0o600)
        # Validate the new modules without binding any public ports.
        subprocess.run(
            ["/usr/bin/python3", "-m", "compileall", "-q", str(SECONDARY)],
            check=True, timeout=20,
        )
        unit = UNIT.with_name(UNIT.name + ".installing")
        if unit.exists():
            raise ValueError("SECONDARY_UNIT_CONFLICT")
        with open(unit, "x") as f:
            f.write(UNIT_SOURCE)
        os.chmod(unit, 0o644)
        os.replace(unit, UNIT)
        subprocess.run(["systemctl", "daemon-reload"], check=True, timeout=20)
        subprocess.run(
            ["systemctl", "enable", "--now", "madar-sales-secondary.service"],
            check=True, timeout=20,
        )
        subprocess.run(
            ["systemctl", "is-active", "--quiet", "madar-sales-secondary.service"],
            check=True, timeout=10,
        )
    except Exception:
        # No command in this rollback path ever targets the primary services.
        if UNIT.exists() and UNIT.read_text() == UNIT_SOURCE:
            subprocess.run(
                ["systemctl", "disable", "--now", "madar-sales-secondary.service"],
                check=False, timeout=20,
            )
            UNIT.unlink(missing_ok=True)
            subprocess.run(["systemctl", "daemon-reload"], check=False, timeout=20)
        # Preserve failed staging for forensic inspection by the administrator.
        raise
    print("MADAR_SECONDARY_INSTALLED_PRIMARY_443_UNCHANGED")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--node-id", required=True)
    parser.add_argument("--source-ref", required=True)
    parser.add_argument("--manifest-sha256", required=True)
    args = parser.parse_args()
    install(args.node_id, args.source_ref, args.manifest_sha256)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        # Do not emit path contents, keys or token values.
        print("SECONDARY_INSTALL_ABORTED:" + type(exc).__name__)
        raise SystemExit(1) from None
