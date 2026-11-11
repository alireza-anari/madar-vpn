"""Reversible REALITY:443 + REALITY:8443 on the DISPOSABLE Aria test VPS.

Requires original standalone V2 bootstrap service units. No packages, DNS,
UFW, production services, sales or route-readiness flags are changed.
"""
import argparse
import copy
import fcntl
import json
import os
import socket
import stat
import sys
from pathlib import Path

from .bootstrap import caddy_unit, xray_unit
from .installer import require_staging_marker
from .reconciler import ReconcileError, _atomic_file, _safe_config_root, subprocess_runner, verify_xray_binary
from .tunnel_probe import EXPECTED_XRAY_SHA256
from .xray_config import encode

ROOT=Path("/etc/madar-v2")
BIN="/opt/madar-v2/bin/xray"
XUNIT="madar-v2-xray.service"
CUNIT="madar-v2-caddy.service"
UNITS=Path("/etc/systemd/system")
DROP=UNITS/(XUNIT+".d")
DROP_FILE=DROP/"20-madar-test-reality-443.conf"
BACKUP="config.pre-carrier443.json"
CAPABILITIES="""[Service]
# Grant only privileged TCP port binding to the unprivileged test Xray user.
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
"""


def owned(path,mode,maxbytes=65536):
    info=path.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or
        info.st_mode & 0o777!=mode or info.st_size>maxbytes):
        raise ReconcileError("unexpected staging file ownership or permissions")
    return path.read_text(encoding="utf-8")


def call(runner,verb,unit,timeout=30):
    if not runner(["/usr/bin/systemctl",verb,unit],timeout=timeout):
        raise ReconcileError("staging service operation failed: "+verb+" "+unit)


def listening(port):
    try:
        with socket.create_connection(("127.0.0.1",port),timeout=1):return True
    except OSError:return False


def dual_config(old):
    rows=old.get("inbounds") if isinstance(old,dict) else None
    if not isinstance(rows,list) or len(rows)!=2 or any(not isinstance(x,dict) for x in rows):
        raise ReconcileError("unexpected initial test-only inbounds")
    lookup={x.get("tag"):x for x in rows}
    if set(lookup)!={"madar-reality","madar-ws-loopback"}:
        raise ReconcileError("unknown live inbound tags")
    a=lookup["madar-reality"];b=lookup["madar-ws-loopback"]
    if not (a.get("port")==8443 and a.get("listen")=="0.0.0.0" and
            a.get("protocol")=="vless" and
            a.get("streamSettings",{}).get("network")=="raw" and
            a.get("streamSettings",{}).get("security")=="reality" and
            b.get("listen")=="127.0.0.1" and b.get("port")==10443 and
            b.get("protocol")=="vless" and b.get("streamSettings",{}).get("network")=="ws"):
        raise ReconcileError("initial test ports or transports do not match")
    users=a.get("settings",{}).get("users",[])
    if not isinstance(users,list) or not users or any(
            not isinstance(u,dict) or u.get("flow")!="xtls-rprx-vision" for u in users):
        raise ReconcileError("existing REALITY users missing")
    c=copy.deepcopy(old)
    replica=copy.deepcopy(a)
    replica["port"]=443;replica["tag"]="madar-reality-mci"
    c["inbounds"]=[copy.deepcopy(a),replica]
    return c


def authorize(root,node,ip):
    if node!="test-aria01" or ip!="86.54.42.66":
        raise ReconcileError("only dedicated Aria TEST VPS is authorized")
    m=json.loads(owned(root/"public-route-metadata.json",0o600))
    if m.get("node_id")!=node or m.get("public_ip")!=ip or m.get("reality_port")!=8443:
        raise ReconcileError("test node identity mismatch")
    if (owned(UNITS/XUNIT,0o644,8192)!=xray_unit() or
            owned(UNITS/CUNIT,0o644,8192)!=caddy_unit()):
        raise ReconcileError("test service unit definitions modified")
    verify_xray_binary(BIN,EXPECTED_XRAY_SHA256)


def put_dropin():
    if DROP.exists() or DROP.is_symlink():
        raise ReconcileError("existing Xray override; refuse overwrite")
    DROP.mkdir(mode=0o755)
    try:
        fd=os.open(DROP_FILE,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o644)
        os.fchmod(fd,0o644)
        with os.fdopen(fd,"w") as f:
            f.write(CAPABILITIES);f.flush();os.fsync(f.fileno())
    except BaseException:
        DROP_FILE.unlink(missing_ok=True);DROP.rmdir();raise


def remove_dropin():
    if not DROP.exists():return
    if DROP.is_symlink() or not DROP.is_dir() or set(DROP.iterdir())!={DROP_FILE}:
        raise ReconcileError("service override directory changed")
    if owned(DROP_FILE,0o644,2048)!=CAPABILITIES:
        raise ReconcileError("capabilities override changed")
    DROP_FILE.unlink();DROP.rmdir()


def restore(root,runner,probe=listening):
    backup=root/BACKUP
    original=owned(backup,0o600)
    stage=_atomic_file(root,".restore-",original)
    os.replace(stage,root/"config.json")
    remove_dropin()
    if not runner(["/usr/bin/systemctl","daemon-reload"],timeout=30):
        raise ReconcileError("rollback daemon reload failed")
    call(runner,"restart",XUNIT)
    call(runner,"enable",CUNIT)
    call(runner,"start",CUNIT)
    for unit in (XUNIT,CUNIT):call(runner,"is-active",unit,5)
    if not (probe(8443) and probe(443)):
        raise ReconcileError("original listeners not restored")
    backup.unlink()
    return {"status":"original_wss_443_and_reality_8443_restored","field_verified":False}


def migrate(node,ip,*,apply=False,rollback=False,root=ROOT,
            runner=subprocess_runner,probe=listening):
    if os.geteuid()!=0:raise ReconcileError("root required")
    root=_safe_config_root(root)
    require_staging_marker(root)
    authorize(root,node,ip)
    fd=os.open(root/"carrier443.lock",os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,"r+") as f:
        os.fchmod(f.fileno(),0o600)
        fcntl.flock(f.fileno(),fcntl.LOCK_EX)
        backup=root/BACKUP
        if rollback:
            if not backup.exists():raise ReconcileError("no previous carrier443 cutover")
            return restore(root,runner,probe)
        if backup.exists() or DROP.exists() or DROP.is_symlink():
            raise ReconcileError("cutover already present; use --rollback")
        for unit in (XUNIT,CUNIT):call(runner,"is-active",unit,5)
        call(runner,"is-enabled",CUNIT,5)
        oldtext=owned(root/"config.json",0o600)
        old=json.loads(oldtext)
        candidate=dual_config(old)
        if candidate["inbounds"][0]!=next(x for x in old["inbounds"] if x["tag"]=="madar-reality"):
            raise ReconcileError("existing 8443 inbound would change")
        if not (probe(443) and probe(8443)):
            raise ReconcileError("existing 443/8443 listener unavailable")
        staged=_atomic_file(root,".candidate443-",encode(candidate))
        try:
            if not runner([BIN,"run","-test","-config",str(staged)],timeout=20):
                raise ReconcileError("native Xray rejected candidate")
            if not apply:
                return {"status":"validated_only","reality_ports":[443,8443],
                        "services_unchanged":True,"field_verified":False}
            original=_atomic_file(root,".original443-",oldtext)
            os.replace(original,backup)
            try:
                put_dropin()
                if not runner(["/usr/bin/systemctl","daemon-reload"],timeout=30):
                    raise ReconcileError("systemd privilege drop-in not accepted")
                call(runner,"disable",CUNIT)
                call(runner,"stop",CUNIT)
                os.replace(staged,root/"config.json")
                staged=None
                call(runner,"restart",XUNIT)
                call(runner,"is-active",XUNIT,5)
                if not (probe(443) and probe(8443)):
                    raise ReconcileError("new reality listeners failed")
            except BaseException as exc:
                try:restore(root,runner,probe)
                except Exception as e:
                    raise ReconcileError("automatic rollback incomplete; backup retained") from e
                raise ReconcileError("cutover failed; old Xray and WSS restored") from exc
            return {"status":"dual_reality_started_not_field_verified",
                "reality_ports":[443,8443],"wss_443_disabled":True,
                "rollback_available":True,"ready_for_sale":False,
                "field_verified":False}
        finally:
            if staged is not None:staged.unlink(missing_ok=True)


def main(argv=None):
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--test-only",action="store_true")
    p.add_argument("--apply",action="store_true")
    p.add_argument("--rollback",action="store_true")
    p.add_argument("--node-id",required=True)
    p.add_argument("--public-ip",required=True)
    a=p.parse_args(argv)
    if not a.test_only or (a.apply and a.rollback):
        p.error("--test-only required; choose preview, --apply or --rollback")
    try:
        result=migrate(a.node_id,a.public_ip,apply=a.apply,rollback=a.rollback)
        print(json.dumps(result,sort_keys=True));return 0
    except (ReconcileError,OSError,ValueError,KeyError,TypeError):
        print("CUTOVER_REJECTED; inspect dedicated V2 services, do not remove backup",file=sys.stderr)
        return 1


if __name__=="__main__":raise SystemExit(main())
