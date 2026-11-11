"""Enable REALITY on both 443 and 8443 after a fresh disposable bootstrap.

Requires already active REALITY:8443 on a clean test VPS. Never modifies
existing commercial Xray nodes. The original configuration is backed up and
restored on failure. Field acceptance is separate.
"""
import argparse
import copy
import fcntl
import json
import os
import sys

from .dual_reality import (
    ROOT,BIN,XUNIT,UNITS,DROP,BACKUP,
    authorize as authorize_aria, owned, call, listening, put_dropin, remove_dropin
)
from .bootstrap import xray_unit
from .installer import require_staging_marker
from .reconciler import ReconcileError,_atomic_file,_safe_config_root,verify_xray_binary,subprocess_runner
from .tunnel_probe import EXPECTED_XRAY_SHA256
from .xray_config import encode


def build_fresh_dual(old):
    rows=old.get("inbounds") if isinstance(old,dict) else None
    if not isinstance(rows,list) or len(rows)!=1 or not isinstance(rows[0],dict):
        raise ReconcileError("not a fresh single-reality staging installation")
    r=rows[0]
    if not(r.get("tag")=="madar-reality" and r.get("listen")=="0.0.0.0" and
           r.get("port")==8443 and r.get("protocol")=="vless" and
           r.get("streamSettings",{}).get("security")=="reality" and
           r.get("streamSettings",{}).get("network")=="raw" and
           r.get("settings",{}).get("users")):
        raise ReconcileError("baseline REALITY listener not recognized")
    out=copy.deepcopy(old)
    alt=copy.deepcopy(r)
    alt["tag"]="madar-reality-mci"
    alt["port"]=443
    out["inbounds"].append(alt)
    return out


def rollback(root,runner,probe):
    backup=root/BACKUP
    original=owned(backup,0o600)
    os.replace(_atomic_file(root,".restore-",original),root/"config.json")
    remove_dropin()
    if not runner(["/usr/bin/systemctl","daemon-reload"],timeout=20):
        raise ReconcileError("cannot reload original service")
    call(runner,"restart",XUNIT)
    call(runner,"is-active",XUNIT,5)
    if not probe(8443):raise ReconcileError("original REALITY port did not recover")
    backup.unlink()


def enable(node,ip,*,root=ROOT,runner=subprocess_runner,probe=listening):
    if os.geteuid()!=0:raise ReconcileError("requires disposable VPS root")
    root=_safe_config_root(root)
    require_staging_marker(root)
    if not node.startswith('test-'):raise ReconcileError("not a test node")
    metadata=json.loads(owned(root/"public-route-metadata.json",0o600))
    if metadata.get("node_id")!=node or metadata.get("public_ip")!=ip:
        raise ReconcileError("unrecognized node identity")
    if owned(UNITS/XUNIT,0o644,8192)!=xray_unit():
        raise ReconcileError("Xray systemd definition not the approved staging unit")
    verify_xray_binary(BIN,EXPECTED_XRAY_SHA256)
    fd=os.open(root/"installer.lock",os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,"r+") as f:
        os.fchmod(f.fileno(),0o600)
        fcntl.flock(f.fileno(),fcntl.LOCK_EX)
        if (root/BACKUP).exists() or DROP.exists():
            raise ReconcileError("node already cut over or has conflicting drop-in")
        call(runner,"is-active",XUNIT,5)
        if not probe(8443):raise ReconcileError("original 8443 not listening")
        previous=owned(root/"config.json",0o600)
        candidate=build_fresh_dual(json.loads(previous))
        stage=_atomic_file(root,".fresh443-",encode(candidate))
        try:
            if not runner([BIN,"run","-test","-config",str(stage)],timeout=20):
                raise ReconcileError("dual port Xray config test failed")
            original=_atomic_file(root,".pre443-",previous)
            os.replace(original,root/BACKUP)
            try:
                put_dropin()
                if not runner(["/usr/bin/systemctl","daemon-reload"],timeout=20):
                    raise ReconcileError("capability drop-in rejected")
                os.replace(stage,root/"config.json")
                stage=None
                call(runner,"restart",XUNIT)
                call(runner,"is-active",XUNIT,5)
                if not (probe(8443) and probe(443)):
                    raise ReconcileError("one of the ports is not bound")
            except BaseException as exc:
                try:rollback(root,runner,probe)
                except Exception as error:
                    raise ReconcileError("fresh cutover failed and rollback incomplete") from error
                raise ReconcileError("fresh cutover failed; original restored") from exc
        finally:
            if stage is not None:stage.unlink(missing_ok=True)
    return {"status":"dual_reality_started_not_field_verified",
            "ports":[443,8443],"ready_for_sale":False}


def main(argv=None):
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--test-only',action='store_true')
    p.add_argument('--node-id',required=True)
    p.add_argument('--public-ip',required=True)
    args=p.parse_args(argv)
    if not args.test_only:p.error('--test-only required')
    try:
        result=enable(args.node_id,args.public_ip)
        print(json.dumps(result,sort_keys=True))
        return 0
    except (ReconcileError,OSError,ValueError,KeyError,TypeError):
        print("FRESH_DUAL_FAILED: no production or billing changes made",file=sys.stderr)
        return 1


if __name__=='__main__':raise SystemExit(main())
