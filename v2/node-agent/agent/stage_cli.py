"""Explicit one-shot staging deploy on a separately prepared disposable VPS.

Examples (paths are fixed operator-managed files, never Telegram text):
python3 -m agent.stage_cli --root /var/lib/madar-v2-staging \
  --secrets /var/lib/madar-v2-staging/local-secrets.json \
  --hostname vpn.example.com --public-ip 198.51.100.1 \
  --xray-binary /opt/madar-v2/bin/xray --xray-sha256 <approved_sha> \
  --caddy-binary /opt/madar-v2/bin/caddy --caddy-sha256 <approved_sha>

Operator must separately arrange installed fixed-name systemd units.
No package downloads, service-user creation, firewall modifications or
production node discovery. Real end-to-end traffic is an independent gate.
"""
import argparse
import json
import os
import stat
from pathlib import Path

from .installer import apply_staging_pair
from .reconciler import ReconcileError
from .xray_config import compile_config,compile_caddy_site

EXPECTED_FIELDS={"clients","reality","websocket","wss_hostname"}


def read_local_spec(filename):
    path=Path(filename)
    metadata=path.lstat()
    if (not stat.S_ISREG(metadata.st_mode) or metadata.st_mode & 0o077
        or metadata.st_uid!=os.geteuid() or metadata.st_size>65536):
        raise ReconcileError("staging secrets must be locally owned mode-0600")
    raw=json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw,dict) or set(raw)!=EXPECTED_FIELDS:
        raise ReconcileError("staging spec has unknown or missing fields")
    ws=raw["websocket"]
    name=raw["wss_hostname"]
    if not isinstance(ws,dict) or not isinstance(name,str):
        raise ReconcileError("staging WSS hostname and loopback port required")
    xray=compile_config(clients=raw["clients"],reality=raw["reality"],websocket=ws)
    site=compile_caddy_site(domain=name,ws_path=ws["path"],loopback_port=ws["loopback_port"])
    return xray,site


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ("root","secrets","hostname","public-ip","xray-binary",
                 "xray-sha256","caddy-binary","caddy-sha256"):
        parser.add_argument("--"+name,required=True)
    args=parser.parse_args(argv)
    xray,site=read_local_spec(args.secrets)
    spec=json.loads(Path(args.secrets).read_text(encoding="utf-8"))
    if spec["wss_hostname"]!=args.hostname:
        raise ReconcileError("WSS hostname differs from trusted local spec")
    outcome=apply_staging_pair(args.root,xray,site,
        xray_binary=args.xray_binary,xray_sha=args.xray_sha256,
        caddy_binary=args.caddy_binary,caddy_sha=args.caddy_sha256,
        hostname=args.hostname,public_ip=args.public_ip)
    # Never display client UUIDs, node keys, private keys or config body.
    print(json.dumps(outcome,sort_keys=True))
    return outcome


if __name__=="__main__":
    main()
