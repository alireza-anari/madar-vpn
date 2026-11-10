"""Isolated Ubuntu VPS test-node bootstrap for REALITY + TLS WebSocket.

Run only on a FRESH dedicated TEST VPS. No existing Xray/Caddy service, no
external shell downloads, and never install on Node1 or production. Release
archives are SHA256-pinned. No route is marked ready by this installer.
"""
import argparse
import ipaddress
import json
import os
import platform
import re
import socket
import stat
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

from . import releases
from .installer import MARKER_TEXT
from .xray_config import compile_config,compile_caddy_site,encode,DOMAIN

NODE_RE=re.compile(r"^test-[A-Za-z0-9_-]{2,55}$")
B64URL=re.compile(r"^[A-Za-z0-9_-]{43}$")
SAFE_ID=re.compile(r"^[a-f0-9]{16}$")
BASE=Path("/etc/madar-v2")
BIN=Path("/opt/madar-v2/bin")
UNITS=Path("/etc/systemd/system")
PROHIBITED=(
    Path("/etc/systemd/system/xray.service"),
    Path("/etc/systemd/system/caddy.service"),
    Path("/etc/systemd/system/madar-v2-xray.service"),
    Path("/etc/systemd/system/madar-v2-caddy.service"),
    Path("/etc/xray"),
    Path("/usr/local/etc/xray"),
    Path("/etc/caddy"),
    BASE,
    BIN.parent,
)
XRAY_UNIT="madar-v2-xray.service"
CADDY_UNIT="madar-v2-caddy.service"


class BootstrapError(RuntimeError):
    pass


def command(args,timeout=30,output=False):
    try:
        return subprocess.run(args,check=True,timeout=timeout,
                              stdin=subprocess.DEVNULL,
                              stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                              text=True)
    except (subprocess.CalledProcessError,subprocess.TimeoutExpired,OSError) as e:
        raise BootstrapError("command failed without changing readiness: "+str(args[0])) from e


def parse_reality_keypair(output):
    private=re.search(r"(?im)^\s*(?:PrivateKey|Private key)\s*:\s*([A-Za-z0-9_-]{43})\s*$",output)
    public=re.search(r"(?im)^\s*(?:Password(?:\s*\(PublicKey\))?|PublicKey|Public key)\s*:\s*([A-Za-z0-9_-]{43})\s*$",output)
    if not private or not public or private.group(1)==public.group(1):
        raise BootstrapError("pinned Xray did not provide a valid REALITY keypair")
    return private.group(1),public.group(1)


def plan_node(*,node_id,public_ip,reality_port=8443,wss_domain=None,
              ws_path="/madar-ws",reality_target="www.cloudflare.com",
              dns_lookup=socket.getaddrinfo):
    if not isinstance(node_id,str) or not NODE_RE.fullmatch(node_id):
        raise BootstrapError("use a dedicated test-... node ID; production nodes are forbidden")
    try: ip=ipaddress.ip_address(public_ip)
    except ValueError as exc: raise BootstrapError("invalid public IPv4 address") from exc
    if ip.version!=4 or not ip.is_global:
        raise BootstrapError("a globally routable IPv4 is required")
    if type(reality_port) is not int or not 1024<=reality_port<=65535 or reality_port in (80,443,10443):
        raise BootstrapError("REALITY test port must not conflict with HTTPS/loopback")
    if not isinstance(reality_target,str) or not DOMAIN.fullmatch(reality_target):
        raise BootstrapError("invalid REALITY TLS target")
    if wss_domain is not None:
        if not isinstance(wss_domain,str) or not DOMAIN.fullmatch(wss_domain):
            raise BootstrapError("WSS needs a valid public TLS hostname")
        if not re.fullmatch(r"/[A-Za-z0-9_/-]{1,200}",ws_path or ""):
            raise BootstrapError("unsafe WebSocket path")
        try:
            addrs={row[4][0] for row in dns_lookup(wss_domain,443,type=socket.SOCK_STREAM) if row[0]==socket.AF_INET}
        except (OSError,ValueError) as exc:
            raise BootstrapError("WSS DNS record not resolvable") from exc
        if str(ip) not in addrs:
            raise BootstrapError("WSS A record must resolve directly to test VPS IP (no Cloudflare proxy)")
    return {"node_id":node_id,"ip":str(ip),"reality_port":reality_port,
            "target":reality_target,"wss_domain":wss_domain,"ws_path":ws_path,
            "wss_port":443 if wss_domain else None,"local_ws_port":10443 if wss_domain else None,
            "protocols":["reality","wss"] if wss_domain else ["reality"],
            "status":"planned_not_installed"}


def xray_unit():
    return """[Unit]
Description=Madar V2 isolated Xray test node (not carrier-verified)
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=madar-v2-xray
Group=madar-v2-xray
LoadCredential=config.json:/etc/madar-v2/config.json
ExecStart=/opt/madar-v2/bin/xray run -config %d/config.json
Restart=on-failure
RestartSec=3s
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
CapabilityBoundingSet=
AmbientCapabilities=
UMask=0077

[Install]
WantedBy=multi-user.target
"""


def caddy_unit():
    return """[Unit]
Description=Madar V2 isolated HTTPS WebSocket test edge (not carrier-verified)
Wants=network-online.target
After=network-online.target

[Service]
Type=notify
User=madar-v2-caddy
Group=madar-v2-caddy
StateDirectory=madar-v2-caddy
LoadCredential=Caddyfile:/etc/madar-v2/Caddyfile
Environment=HOME=/var/lib/madar-v2-caddy
Environment=XDG_DATA_HOME=/var/lib/madar-v2-caddy/data
Environment=XDG_CONFIG_HOME=/var/lib/madar-v2-caddy/config
ExecStart=/opt/madar-v2/bin/caddy run --config %d/Caddyfile --adapter caddyfile
ExecReload=/opt/madar-v2/bin/caddy reload --config %d/Caddyfile --adapter caddyfile
Restart=on-failure
RestartSec=3s
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
UMask=0077

[Install]
WantedBy=multi-user.target
"""


def _write_exclusive(path,text,mode=0o600):
    flags=os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW
    fd=os.open(path,flags,mode)
    try:
        os.fchmod(fd,mode)
        with os.fdopen(fd,"w",encoding="utf-8") as out:
            out.write(text)
            out.flush()
            os.fsync(out.fileno())
    except BaseException:
        Path(path).unlink(missing_ok=True)
        raise
    return Path(path)


def _guard_fresh_system():
    if os.geteuid()!=0:
        raise BootstrapError("apply requires root on a dedicated test VPS")
    if platform.system()!="Linux":
        raise BootstrapError("only Linux test VPS is supported")
    release=Path("/etc/os-release").read_text(encoding="utf-8")
    if not any(x.startswith("ID=") and x.split("=",1)[1].strip('" \\n') in ("ubuntu","debian") for x in release.splitlines()):
        raise BootstrapError("unsupported host distribution")
    for path in PROHIBITED:
        if path.exists() or path.is_symlink():
            raise BootstrapError("existing VPN/edge installation detected; refuse shared or production VPS")


def _port_available(address,port):
    family=socket.AF_INET
    with socket.socket(family,socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,0)
        try: s.bind((address,port))
        except OSError as exc: raise BootstrapError("local TCP port already in use") from exc


def _probe_ports(plan):
    _port_available("0.0.0.0",plan["reality_port"])
    if plan["wss_domain"] is not None:
        for port in (80,443): _port_available("0.0.0.0",port)
        _port_available("127.0.0.1",plan["local_ws_port"])


def _make_user(name):
    command(["/usr/sbin/useradd","--system","--user-group",
             "--no-create-home","--home-dir","/var/empty",
             "--shell","/usr/sbin/nologin",name])


def _is_active(unit):
    result=subprocess.run(["/usr/bin/systemctl","is-active","--quiet",unit],
                          check=False,stdin=subprocess.DEVNULL,
                          stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=8)
    return result.returncode==0


def install_test_node(plan,*,downloader=None):
    """Only initial installation on a clean, explicitly isolated test VPS.

    A successful return is NOT a verified proxy session or field readiness.
    """
    _guard_fresh_system()
    _probe_ports(plan)
    if downloader is None: downloader=releases._get
    xray,hash_xray=releases.verified_release("xray",downloader=downloader)
    caddy=None
    if plan["wss_domain"]:
        caddy,_=releases.verified_release("caddy",downloader=downloader)
    created=[]
    started=[]
    try:
        BIN.mkdir(parents=True,mode=0o755,exist_ok=False)
        created.append(BIN.parent)
        xray_path=releases.place_executable(BIN,"xray",xray)
        if caddy: releases.place_executable(BIN,"caddy",caddy)
        private,public=parse_reality_keypair(command([str(xray_path),"x25519"],timeout=15,output=True).stdout)
        import secrets
        client=str(uuid.uuid4())
        shortid=secrets.token_hex(8)
        private_input={
            "clients":[client],
            "reality":{"port":plan["reality_port"],
                       "target":plan["target"],"server_name":plan["target"],
                       "private_key":private,"short_ids":[shortid]},
            "websocket":({"path":plan["ws_path"],"loopback_port":plan["local_ws_port"]}
                         if plan["wss_domain"] else None),
        }
        compiled=compile_config(**private_input)
        private_input['wss_hostname']=plan['wss_domain']
        BASE.mkdir(mode=0o755,exist_ok=False)
        created.append(BASE)
        _write_exclusive(BASE/'STAGING-ONLY',MARKER_TEXT,0o600)
        _write_exclusive(BASE/"config.json",encode(compiled),0o600)
        _write_exclusive(BASE/"local-secrets.json",json.dumps(private_input),0o600)
        public_info={"node_id":plan["node_id"],"public_ip":plan["ip"],
                     "reality_port":plan["reality_port"],"reality_server_name":plan["target"],
                     "reality_public_key":public,"short_id":shortid,
                     "wss_domain":plan["wss_domain"],"wss_path":plan["ws_path"] if plan["wss_domain"] else None}
        _write_exclusive(BASE/"public-route-metadata.json",json.dumps(public_info,indent=2),0o600)
        command([str(xray_path),"run","-test","-config",str(BASE/"config.json")],timeout=20)
        if caddy:
            site=compile_caddy_site(domain=plan["wss_domain"],ws_path=plan["ws_path"],
                                    loopback_port=plan["local_ws_port"])
            _write_exclusive(BASE/"Caddyfile",site,0o600)
            command([str(BIN/"caddy"),"validate","--config",str(BASE/"Caddyfile"),
                     "--adapter","caddyfile"],timeout=20)
        _make_user("madar-v2-xray")
        if caddy: _make_user("madar-v2-caddy")
        _write_exclusive(UNITS/XRAY_UNIT,xray_unit(),0o644)
        created.append(UNITS/XRAY_UNIT)
        if caddy:
            _write_exclusive(UNITS/CADDY_UNIT,caddy_unit(),0o644)
            created.append(UNITS/CADDY_UNIT)
        command(["/usr/bin/systemctl","daemon-reload"])
        for unit in [XRAY_UNIT]+([CADDY_UNIT] if caddy else []):
            started.append(unit)
            command(["/usr/bin/systemctl","enable","--now",unit],timeout=45)
            if not _is_active(unit):
                raise BootstrapError("isolated service not active")
        return {
            "status":"service_configured_not_field_verified",
            "node_id":plan["node_id"],
            "transport_states":{proto:"service_started_not_verified" for proto in plan["protocols"]},
            "binary_sha256":hash_xray,
            "field_verified":False,
            "note":"Independent TLS, authenticated VLESS handshake, quota and carrier tests remain mandatory.",
        }
    except BaseException:
        for unit in reversed(started):
            try: command(["/usr/bin/systemctl","disable","--now",unit],timeout=15)
            except Exception: pass
        for path in reversed(created):
            try:
                if path.is_dir():
                    import shutil
                    shutil.rmtree(path)
                else: path.unlink(missing_ok=True)
            except Exception: pass
        try: command(["/usr/bin/systemctl","daemon-reload"],timeout=15)
        except Exception: pass
        raise


def main(argv=None):
    p=argparse.ArgumentParser(description="Madar V2 test-only fresh-VPS bootstrap")
    p.add_argument("--node-id",required=True,help="Must start with test-")
    p.add_argument("--public-ip",required=True)
    p.add_argument("--reality-port",type=int,default=8443)
    p.add_argument("--reality-target",default="www.cloudflare.com")
    p.add_argument("--wss-domain",help="Direct DNS A record to VPS; no proxy")
    p.add_argument("--ws-path",default="/madar-ws")
    p.add_argument("--test-only",action="store_true")
    p.add_argument("--apply",action="store_true",help="Install only on dedicated, pristine test VPS")
    args=p.parse_args(argv)
    try:
        if not args.test_only:
            raise BootstrapError("--test-only explicit acknowledgement required")
        plan=plan_node(node_id=args.node_id,public_ip=args.public_ip,
                       reality_port=args.reality_port,wss_domain=args.wss_domain,
                       ws_path=args.ws_path,reality_target=args.reality_target)
        if args.apply: outcome=install_test_node(plan)
        else: outcome=plan
        print(json.dumps(outcome,sort_keys=True))
        return 0
    except (BootstrapError,releases.ReleaseError) as exc:
        print("BOOTSTRAP_REJECTED: "+str(exc),file=sys.stderr)
        return 1


if __name__=="__main__":
    sys.exit(main())
