"""Install a reviewed, bounded readiness-wait fix into an existing V2 Agent.

This patches ONLY the known Type=simple immediate-ports-check bug in the
installed runtime module. There is NO Xray restart, ledger mutation, policy
change, watchdog disablement, quota reset, or synthetic health ACK. It restarts
the ordinary agent so the existing signed-policy / local enforcement path runs.
Dry-run by default; applied mode requires exact source and ledger guards.
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

CODE=pathlib.Path('/opt/madar-v2/runtime/agent/runtime.py')
METADATA=pathlib.Path('/etc/madar-v2/public-route-metadata.json')
LEDGER=pathlib.Path('/var/lib/madar-v2/runtime/quota.sqlite')
UNIT=pathlib.Path('/etc/systemd/system/madar-v2-runtime.service')
SERVICE='madar-v2-runtime.service'
NODE=re.compile(r'^[A-Za-z][A-Za-z0-9_-]{2,63}$')
ANCHOR='def store_marker(root,document):'
OLD="""        if not ports_listening():
            raise ReconcileError('dual REALITY and stats listeners not active')
        # Verify the API endpoint itself BEFORE acknowledging any clients.
        parse_stats(stats_snapshot(XRAY,self.runner),[])
        ledger.mark_installed([x['subscription_id'] for x in active])"""
NEW="""        # Type=simple returns before sockets and StatsService are necessarily
        # ready. Do not race immediate readiness against the Xray startup.
        # The signed policy lease and the independent watchdog are unchanged.
        wait_for_xray_readiness(self.runner)
        ledger.mark_installed([x['subscription_id'] for x in active])"""
HELPER="""def wait_for_xray_readiness(runner=subprocess.run,*,timeout=6.0,interval=0.25,
                            monotonic=time.monotonic,sleep=time.sleep):
    \"\"\"Bounded readiness gate for systemd Type=simple Xray startup.

    A successful systemctl start is NOT proof that TCP listeners and the
    StatsService are ready. Never acknowledge a customer before all three
    listener ports, the stats API, and a single stable live PID pass.
    External watchdog and quota enforcement remain enabled.
    \"\"\"
    if not (0 < timeout <= 10 and 0 < interval <= 1):
        raise ValueError('INVALID_XRAY_READINESS_WINDOW')
    deadline=monotonic()+timeout
    first_pid=None
    while True:
        pid=xray_pid(runner)
        if first_pid is None:
            first_pid=pid
        if pid!=first_pid:
            raise ReconcileError('unrecognized Xray process generation')
        if ports_listening():
            try:
                parse_stats(stats_snapshot(XRAY,runner),[])
            except (OSError,subprocess.CalledProcessError,subprocess.TimeoutExpired):
                # The loopback stats API can briefly lag the TCP listeners.
                # A malformed or inconsistent response is NOT retryable.
                pass
            else:
                if xray_pid(runner)!=first_pid:
                    raise ReconcileError('unrecognized Xray process generation')
                return first_pid
        remaining=deadline-monotonic()
        if remaining<=0:
            raise ReconcileError('dual REALITY and stats listeners not active')
        sleep(min(interval,remaining))


"""

class RepairBlocked(Exception): pass

def safe_regular(path,mode,max_bytes):
    path=pathlib.Path(path)
    try: info=path.lstat()
    except OSError: raise RepairBlocked('REQUIRED_FILE_MISSING') from None
    if (not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or
        info.st_nlink!=1 or info.st_mode&0o777!=mode or
        not 1<=info.st_size<=max_bytes):
        raise RepairBlocked('UNTRUSTED_FILE')
    return path

def check(node,*,code=CODE,metadata=METADATA,ledger=LEDGER,unit=UNIT):
    if os.geteuid()!=0: raise RepairBlocked('ROOT_REQUIRED')
    if not isinstance(node,str) or not NODE.fullmatch(node):
        raise RepairBlocked('INVALID_NODE_ID')
    code=pathlib.Path(code)
    if code.parent.is_symlink() or code.parent.parent.is_symlink():
        raise RepairBlocked('SYMLINK_NOT_ALLOWED')
    safe_regular(code,0o600,65536)
    safe_regular(metadata,0o600,8192)
    safe_regular(ledger,0o600,100*1024*1024)
    safe_regular(unit,0o644,8192)
    try: doc=json.loads(pathlib.Path(metadata).read_text(encoding='utf-8'))
    except (OSError,ValueError):
        raise RepairBlocked('INVALID_METADATA') from None
    if doc.get('node_id')!=node:
        raise RepairBlocked('NODE_MISMATCH')
    unit_text=pathlib.Path(unit).read_text(encoding='utf-8')
    if ('Description=Madar V2 isolated node quota and client reconciler' not in unit_text or
        'ExecStart=/usr/bin/python3 -m agent.runtime ' not in unit_text or
        'PYTHONPATH=/opt/madar-v2/runtime' not in unit_text):
        raise RepairBlocked('WRONG_RUNTIME_UNIT')
    try:
        with sqlite3.connect('file:'+str(ledger)+'?mode=ro',uri=True,timeout=3) as db:
            rows=db.execute('SELECT installed,counter,total,used,sequence,reported_seq FROM accounts').fetchall()
    except sqlite3.Error:
        raise RepairBlocked('INVALID_LOCAL_LEDGER') from None
    if len(rows)!=1 or tuple(rows[0])!=(0,0,0,0,0,0):
        raise RepairBlocked('EXISTING_CUSTOMER_OR_UNRESOLVED_LEDGER')
    old=code.read_text(encoding='utf-8')
    if NEW in old and 'def wait_for_xray_readiness(' in old and OLD not in old:
        return {'status':'ALREADY_PATCHED','content':None}
    if (old.count(OLD)!=1 or old.count(ANCHOR)!=1 or
        'def wait_for_xray_readiness(' in old or NEW in old or
        "active=[{'subscription_id':row['id'],'uuid':row['uuid']}" not in old):
        raise RepairBlocked('UNKNOWN_RUNTIME_GENERATION')
    patched=old.replace(ANCHOR,HELPER+ANCHOR,1).replace(OLD,NEW,1)
    try: compile(patched,str(code),'exec')
    except SyntaxError:
        raise RepairBlocked('PATCH_SYNTAX_INVALID') from None
    return {'status':'PATCH_READY','content':patched}

def atomic_write(path,content):
    path=pathlib.Path(path)
    fd,name=tempfile.mkstemp(prefix='.xray-readiness-',dir=path.parent)
    try:
        with os.fdopen(fd,'w',encoding='utf-8') as out:
            os.fchmod(out.fileno(),0o600)
            out.write(content)
            out.flush();os.fsync(out.fileno())
        os.replace(name,path)
        fd=os.open(path.parent,os.O_RDONLY)
        try: os.fsync(fd)
        finally: os.close(fd)
    finally:
        pathlib.Path(name).unlink(missing_ok=True)

def invoke(runner,operation):
    r=runner(['/usr/bin/systemctl',operation,SERVICE],check=False,timeout=30,
             stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,
             stderr=subprocess.DEVNULL)
    if r.returncode!=0:
        raise RepairBlocked('AGENT_'+operation.upper()+'_FAILED')

def repair(node,*,apply=False,code=CODE,metadata=METADATA,ledger=LEDGER,
           unit=UNIT,runner=subprocess.run):
    verified=check(node,code=code,metadata=metadata,ledger=ledger,unit=unit)
    if verified['status']=='ALREADY_PATCHED':return 'ALREADY_PATCHED'
    if not apply:return 'PATCH_READY_NO_CHANGES'
    path=pathlib.Path(code)
    backup=path.with_name(path.name+'.xray-readiness-backup')
    if backup.exists() or backup.is_symlink():
        raise RepairBlocked('BACKUP_ALREADY_EXISTS')
    # Stop the runtime first so its in-memory old implementation cannot
    # race the patch. Watchdog stays enabled and no Xray service is started.
    invoke(runner,'stop')
    patched=False
    try:
        verified=check(node,code=code,metadata=metadata,ledger=ledger,unit=unit)
        if verified['status']!='PATCH_READY':
            raise RepairBlocked('STATE_CHANGED_DURING_AGENT_STOP')
        original=path.read_text(encoding='utf-8')
        with backup.open('x',encoding='utf-8') as out:
            os.fchmod(out.fileno(),0o600)
            out.write(original)
            out.flush();os.fsync(out.fileno())
        atomic_write(path,verified['content'])
        patched=True
        invoke(runner,'start')
    except BaseException:
        if patched:
            atomic_write(path,original)
        try: invoke(runner,'start')
        except (OSError,subprocess.SubprocessError,RepairBlocked):pass
        raise
    return 'PATCH_APPLIED_WAIT_FOR_FRESH_SIGNED_HEALTH'

def main(argv=None):
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--node-id',required=True)
    p.add_argument('--apply',action='store_true')
    args=p.parse_args(argv)
    try:
        print(repair(args.node_id,apply=args.apply))
    except (OSError,ValueError,sqlite3.Error,subprocess.SubprocessError,RepairBlocked) as exc:
        code=str(exc) if isinstance(exc,RepairBlocked) else 'UNEXPECTED_FAILURE'
        print('REPAIR_BLOCKED_'+code)
        raise SystemExit(1)

if __name__=='__main__':main()
