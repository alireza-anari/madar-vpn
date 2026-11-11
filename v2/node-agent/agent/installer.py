"""Staging-only atomic Xray+TLS/WebSocket deployment, with two-service rollback.

Preinstalled binary digests and independent staging marker required. This never
downloads code, installs packages, edits UFW, or touches any V1 service.
It does NOT mark a route usable; external authenticated VPN traffic is needed.
"""
import fcntl
import ipaddress
import os
import socket
from pathlib import Path

from .reconciler import (
    ReconcileError, UNIT_NAME, _atomic_file, _safe_config_root,
    _safe_existing_file, subprocess_runner, verify_xray_binary,
)
from .xray_config import encode

CADDY_UNIT = "madar-v2-caddy.service"
MARKER_TEXT = "MADAR_V2_DISPOSABLE_TEST_NODE\n"


def require_staging_marker(directory):
    marker=directory/"STAGING-ONLY"
    if not _safe_existing_file(marker):
        raise ReconcileError("missing explicit disposable staging marker")
    info=marker.lstat()
    if info.st_uid!=os.geteuid() or marker.read_text(encoding="ascii")!=MARKER_TEXT:
        raise ReconcileError("not an authorized disposable staging node")


def require_public_dns(hostname, public_ip, resolver=socket.getaddrinfo):
    """Fail closed when public TLS name is not pointed at the test VPS."""
    expected=ipaddress.ip_address(public_ip)
    if expected.version!=4 or not expected.is_global:
        raise ReconcileError("expected public IPv4 address required")
    if not isinstance(hostname,str) or "." not in hostname or len(hostname)>253:
        raise ReconcileError("invalid TLS hostname")
    if hostname.lower().endswith((".local",".internal",".localhost")):
        raise ReconcileError("not a public TLS hostname")
    try:
        matches={ipaddress.ip_address(x[4][0]) for x in resolver(
            hostname,443,family=socket.AF_INET,type=socket.SOCK_STREAM
        )}
    except (OSError,ValueError,IndexError):
        raise ReconcileError("DNS does not resolve") from None
    if expected not in matches:
        raise ReconcileError("TLS hostname does not point to staging origin")
    return True


def _rollback_file(current,previous,had_current):
    if current.exists():
        current.unlink()
    if had_current:
        if not previous.exists():
            raise ReconcileError("rollback backup missing")
        os.replace(previous,current)


def apply_staging_pair(
    root, xray_config, caddy_site, *, xray_binary,xray_sha,
    caddy_binary,caddy_sha, hostname,public_ip,
    runner=subprocess_runner,resolver=socket.getaddrinfo,
):
    """Validate both before changing either; restore BOTH after failed restart.

    On first-time failures, stop newly started fixed-name units. DNS preflight
    proves hostname direction, not issued TLS cert or live WSS functionality.
    """
    directory=_safe_config_root(root)
    require_staging_marker(directory)
    if (directory/"config.pre-carrier443.json").exists():
        raise ReconcileError("dual REALITY migration active: WSS pair changes blocked")
    require_public_dns(hostname,public_ip,resolver)
    xb=verify_xray_binary(xray_binary,xray_sha)
    cb=verify_xray_binary(caddy_binary,caddy_sha)
    if not isinstance(xray_config,dict) or not isinstance(caddy_site,str) or len(caddy_site)>4096:
        raise ReconcileError("invalid staging pair")
    inbounds=xray_config.get("inbounds",[])
    if not isinstance(inbounds,list) or not inbounds:
        raise ReconcileError("no Xray listener")
    if not any(x.get("tag")=="madar-ws-loopback" and
        x.get("listen")=="127.0.0.1" for x in inbounds if isinstance(x,dict)):
        raise ReconcileError("WSS must use localhost-only Xray WebSocket ingress")
    for x in inbounds:
        if not isinstance(x,dict):
            raise ReconcileError("invalid listener")
        if x.get("tag")=="madar-reality" and x.get("port")==443:
            raise ReconcileError("REALITY and Caddy cannot both own public 443")
    xcur=directory/"config.json"
    ccur=directory/"Caddyfile"
    xprev=directory/"xray.previous.json"
    cprev=directory/"Caddyfile.previous"
    lock=directory/"installer.lock"
    fd=os.open(lock,os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    xstaged=cstaged=None
    try:
        os.fchmod(fd,0o600)
        with os.fdopen(fd,"r+") as f:
            fcntl.flock(f.fileno(),fcntl.LOCK_EX)
            xhad=_safe_existing_file(xcur)
            chad=_safe_existing_file(ccur)
            _safe_existing_file(xprev)
            _safe_existing_file(cprev)
            xstaged=_atomic_file(directory,".xray-",encode(xray_config))
            cstaged=_atomic_file(directory,".caddy-",caddy_site)
            if not runner([xb,"run","-test","-config",str(xstaged)],timeout=20):
                raise ReconcileError("Xray refused candidate; old services untouched")
            if not runner([cb,"validate","--config",str(cstaged),
                           "--adapter","caddyfile"],timeout=20):
                raise ReconcileError("Caddy refused candidate; old services untouched")
            if xprev.exists(): xprev.unlink()
            if cprev.exists(): cprev.unlink()
            if xhad: os.replace(xcur,xprev)
            if chad: os.replace(ccur,cprev)
            try:
                os.replace(xstaged,xcur); xstaged=None
                os.replace(cstaged,ccur); cstaged=None
            except OSError as error:
                _rollback_file(xcur,xprev,xhad)
                _rollback_file(ccur,cprev,chad)
                raise ReconcileError("atomic replacement failed") from error
            try:
                for unit in (UNIT_NAME,CADDY_UNIT):
                    if not runner(["/usr/bin/systemctl","restart",unit],timeout=30):
                        raise ReconcileError("staging unit restart failed: "+unit)
                    if not runner(["/usr/bin/systemctl","is-active","--quiet",unit],timeout=5):
                        raise ReconcileError("staging unit inactive: "+unit)
            except ReconcileError:
                _rollback_file(xcur,xprev,xhad)
                _rollback_file(ccur,cprev,chad)
                # Restore known-good runtime, or stop a first-time deployment.
                for unit,was_configured in ((UNIT_NAME,xhad),(CADDY_UNIT,chad)):
                    command="restart" if was_configured else "stop"
                    runner(["/usr/bin/systemctl",command,unit],timeout=30)
                raise
            return {"status":"services_configured","tls_certificate_verified":False,
                    "authenticated_vpn_traffic_verified":False,"ready_for_sale":False}
    finally:
        if xstaged is not None: xstaged.unlink(missing_ok=True)
        if cstaged is not None: cstaged.unlink(missing_ok=True)
