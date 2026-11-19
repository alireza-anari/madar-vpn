"""One-time, bounded recovery for the first-commercial-client V2 runtime bug.

The old installed agent used SQLite account rows ("id") as if they had
"subscription_id". This tool patches exactly that reviewed source fragment
without touching the local quota ledger, Xray config, keys, or prior ACKs.

Dry-run by default. For an already-installed, affected V2 node only.
Never run against a node with installed commercial accounts.
"""
import argparse
import json
import os
import pathlib
import re
import sqlite3
import stat
import subprocess
import tempfile
from urllib.parse import quote

CODE=pathlib.Path('/opt/madar-v2/runtime/agent/runtime.py')
METADATA=pathlib.Path('/etc/madar-v2/public-route-metadata.json')
LEDGER=pathlib.Path('/var/lib/madar-v2/runtime/quota.sqlite')
UNIT=pathlib.Path('/etc/systemd/system/madar-v2-runtime.service')
SERVICE='madar-v2-runtime.service'
NODE=re.compile(r'^[A-Za-z][A-Za-z0-9_-]{2,63}$')
OLD="""            ledger.reconcile(policy['clients'],now_ms)
            active=ledger.active(now_ms)
            self.apply(ledger,active)
            pid=xray_pid(self.runner)"""
NEW="""            ledger.reconcile(policy['clients'],now_ms)
            # LocalLedger rows use "id", while the signed client policy and
            # Xray/ACK compiler require "subscription_id". The first new
            # commercial account must be normalized BEFORE apply/ACK; otherwise
            # a KeyError strands the order in provisioning forever.
            active=[{'subscription_id':row['id'],'uuid':row['uuid']}
                    for row in ledger.active(now_ms)]
            self.apply(ledger,active)
            pid=xray_pid(self.runner)"""


class RepairBlocked(Exception):
    pass


def safe_regular(path,*,max_bytes,permissions):
    path=pathlib.Path(path)
    if path.is_symlink():
        raise RepairBlocked('SYMLINK_NOT_ALLOWED')
    try:
        info=path.lstat()
    except OSError:
        raise RepairBlocked('EXPECTED_FILE_MISSING') from None
    if (not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or
        info.st_size>max_bytes or info.st_size<1 or
        info.st_mode&0o777 !=permissions):
        raise RepairBlocked('UNTRUSTED_EXISTING_FILE')
    return path


def check(node,*,code=CODE,metadata=METADATA,ledger=LEDGER,unit=UNIT):
    if os.geteuid()!=0:
        raise RepairBlocked('ROOT_REQUIRED')
    if not isinstance(node,str) or not NODE.fullmatch(node):
        raise RepairBlocked('INVALID_NODE')
    code=pathlib.Path(code)
    # The runtime package must live in a real root-owned private directory.
    if code.parent.is_symlink() or code.parent.parent.is_symlink():
        raise RepairBlocked('SYMLINK_NOT_ALLOWED')
    safe_regular(code,max_bytes=65536,permissions=0o600)
    safe_regular(metadata,max_bytes=8192,permissions=0o600)
    safe_regular(ledger,max_bytes=100*1024*1024,permissions=0o600)
    safe_regular(unit,max_bytes=8192,permissions=0o644)
    try:
        doc=json.loads(pathlib.Path(metadata).read_text(encoding='utf-8'))
    except (OSError,ValueError):
        raise RepairBlocked('METADATA_INVALID') from None
    if doc.get('node_id')!=node:
        raise RepairBlocked('NODE_MISMATCH')
    unit_text=pathlib.Path(unit).read_text(encoding='utf-8')
    if ('Description=Madar V2 isolated node quota and client reconciler' not in unit_text or
        'ExecStart=/usr/bin/python3 -m agent.runtime ' not in unit_text or
        'PYTHONPATH=/opt/madar-v2/runtime' not in unit_text):
        raise RepairBlocked('UNIT_NOT_REVIEWED')
    # Read-only SQLite query. Never reset usage or change ledger metadata.
    address='file:'+quote(str(pathlib.Path(ledger)),safe='/')+'?mode=ro'
    try:
        with sqlite3.connect(address,uri=True,timeout=2) as db:
            installed=db.execute(
                'SELECT COUNT(*) FROM accounts WHERE installed=1'
            ).fetchone()[0]
    except sqlite3.Error:
        raise RepairBlocked('LEDGER_NOT_READABLE') from None
    if installed:
        raise RepairBlocked('COMMERCIAL_ACCOUNTS_INSTALLED')
    original=code.read_text(encoding='utf-8')
    if NEW in original and OLD not in original:
        return {'state':'ALREADY_PATCHED','content':None}
    if original.count(OLD)!=1 or NEW in original:
        raise RepairBlocked('UNKNOWN_RUNTIME_GENERATION')
    patched=original.replace(OLD,NEW,1)
    try:
        compile(patched,str(code),'exec')
    except SyntaxError:
        raise RepairBlocked('PATCH_SYNTAX_INVALID') from None
    return {'state':'PATCH_APPLICABLE','content':patched}


def atomic_write(path,data):
    path=pathlib.Path(path)
    fd,name=tempfile.mkstemp(prefix='.runtime-repair-',dir=path.parent)
    try:
        with os.fdopen(fd,'w',encoding='utf-8') as out:
            os.fchmod(out.fileno(),0o600)
            out.write(data)
            out.flush()
            os.fsync(out.fileno())
        os.replace(name,path)
        dir_fd=os.open(path.parent,os.O_RDONLY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
    finally:
        pathlib.Path(name).unlink(missing_ok=True)


def repair(node,*,apply=False,code=CODE,metadata=METADATA,ledger=LEDGER,
           unit=UNIT,runner=subprocess.run):
    state=check(node,code=code,metadata=metadata,ledger=ledger,unit=unit)
    if state['state']=='ALREADY_PATCHED':
        return 'ALREADY_PATCHED'
    if not apply:
        return 'PATCH_APPLICABLE_NO_CHANGES'
    path=pathlib.Path(code)
    original=path.read_text(encoding='utf-8')
    # Private rollback copy is deliberately kept. Never modify the SQLite
    # ledger or heartbeat marker while repairing this Python-only bug.
    backup=path.with_name(path.name+'.first-client-backup')
    if backup.exists() or backup.is_symlink():
        raise RepairBlocked('BACKUP_ALREADY_EXISTS')
    with backup.open('x',encoding='utf-8') as dst:
        os.fchmod(dst.fileno(),0o600)
        dst.write(original)
        dst.flush()
        os.fsync(dst.fileno())
    atomic_write(path,state['content'])
    def invoke():
        result=runner(['/usr/bin/systemctl','restart',SERVICE],
                      check=False,timeout=30,stdout=subprocess.DEVNULL,
                      stderr=subprocess.DEVNULL)
        if result.returncode!=0:
            raise RepairBlocked('RUNTIME_RESTART_FAILED')
        result=runner(['/usr/bin/systemctl','is-active','--quiet',SERVICE],
                      check=False,timeout=10,stdout=subprocess.DEVNULL,
                      stderr=subprocess.DEVNULL)
        if result.returncode!=0:
            raise RepairBlocked('RUNTIME_NOT_ACTIVE')
    try:
        invoke()
    except (OSError,subprocess.SubprocessError,RepairBlocked):
        # Safe to restore source because preflight proved no commercial
        # Xray accounts were installed at the start of this repair.
        atomic_write(path,original)
        try:
            runner(['/usr/bin/systemctl','restart',SERVICE],
                check=False,timeout=30,stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL)
        except (OSError,subprocess.SubprocessError):
            pass
        raise RepairBlocked('RESTART_FAILED_OR_ROLLED_BACK') from None
    # Service active alone is not health or a signed client ACK.
    return 'PATCH_APPLIED_WAIT_FOR_SIGNED_CLIENT_ACK'


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--node-id',required=True)
    parser.add_argument('--apply',action='store_true')
    args=parser.parse_args()
    try:
        print(repair(args.node_id,apply=args.apply))
    except RepairBlocked as exc:
        print('REPAIR_BLOCKED_'+str(exc))
        raise SystemExit(1)


if __name__=='__main__':
    main()
