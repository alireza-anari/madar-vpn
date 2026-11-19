"""Bounded owner-authorized restart from a *zero-observed-use* Xray outage.

This is NOT proof that packets were never sent while Xray was up. Unknown
historical consumption remains explicitly recorded in the local ledger audit
and a private immutable backup. Only for an owner-confirmed non-paid,
never-client-ACKed staging node; refuse all non-zero durable counters.

Without --apply this is read-only. No Worker tokens, UUIDs or private key
contents are printed. The running node runtime is stopped before changing
its installed-generation bit; the watchdog is never disabled.
"""
import argparse
import json
import os
import pathlib
import re
import shutil
import sqlite3
import stat
import subprocess
import tempfile
import time

ROOT=pathlib.Path('/etc/madar-v2')
STATE=pathlib.Path('/var/lib/madar-v2/runtime')
DB=STATE/'quota.sqlite'
MARKER=STATE/'heartbeat.json'
XRAY='madar-v2-xray.service'
AGENT='madar-v2-runtime.service'
PORTS={443,8443,10085}

class RecoveryBlocked(Exception): pass

def require_regular(path,max_size):
    p=pathlib.Path(path)
    try: m=p.lstat()
    except OSError: raise RecoveryBlocked('REQUIRED_FILE_MISSING') from None
    if (not stat.S_ISREG(m.st_mode) or m.st_uid!=0 or m.st_nlink!=1
        or m.st_mode&0o077 or not 1<=m.st_size<=max_size):
        raise RecoveryBlocked('UNTRUSTED_V2_FILE')
    return p

def service_active(name,run=subprocess.run):
    r=run(['/usr/bin/systemctl','is-active','--quiet',name],timeout=8,
          stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
          check=False)
    return r.returncode==0

def ports_are_clear(run=subprocess.run):
    try:
        r=run(['/usr/bin/ss','-lnt'],capture_output=True,text=True,
              timeout=8,check=True)
        for line in r.stdout.splitlines()[1:]:
            columns=line.split()
            if len(columns)>3 and any(columns[3].endswith(':'+str(p)) for p in PORTS):
                return False
        return True
    except (OSError,subprocess.SubprocessError):
        raise RecoveryBlocked('LISTENERS_UNVERIFIABLE') from None

def read_accounts(path):
    with sqlite3.connect('file:'+str(path)+'?mode=ro',uri=True,timeout=5) as c:
        c.execute('PRAGMA query_only=ON')
        rows=c.execute('SELECT id,uuid,installed,present,counter,total,used,sequence,reported_seq '
                       'FROM accounts').fetchall()
    return rows

def preflight(node_id,ip,run=subprocess.run):
    if os.geteuid()!=0: raise RecoveryBlocked('ROOT_REQUIRED')
    if not re.fullmatch(r'[A-Za-z][A-Za-z0-9_-]{2,63}',node_id):
        raise RecoveryBlocked('INVALID_NODE')
    if not re.fullmatch(r'[0-9]{1,3}(?:\\.[0-9]{1,3}){3}',ip):
        raise RecoveryBlocked('INVALID_IP')
    metadata=json.loads(require_regular(ROOT/'public-route-metadata.json',8192).read_text())
    if metadata.get('node_id')!=node_id or metadata.get('public_ip')!=ip:
        raise RecoveryBlocked('WRONG_NODE_IDENTITY')
    db=require_regular(DB,100*1024*1024)
    marker=json.loads(require_regular(MARKER,4096).read_text())
    if marker.get('mode')!='commercial' or not isinstance(marker.get('policy_until_ms'),int):
        raise RecoveryBlocked('NOT_EXPIRED_COMMERCIAL_GENERATION')
    if marker['policy_until_ms']>int(time.time()*1000):
        raise RecoveryBlocked('POLICY_STILL_VALID')
    if service_active(XRAY,run) or not ports_are_clear(run):
        raise RecoveryBlocked('XRAY_OR_LISTENERS_ACTIVE')
    if not service_active(AGENT,run):
        raise RecoveryBlocked('AGENT_NOT_ACTIVE_BEFORE_RECOVERY')
    rows=read_accounts(db)
    if len(rows)!=1: raise RecoveryBlocked('NOT_SINGLE_ACCOUNT')
    sid,uid,installed,present,counter,total,used,seq,reported=rows[0]
    if (installed,present,counter,total,used,seq,reported)!=(1,1,0,0,0,0,0):
        raise RecoveryBlocked('NOT_ZERO_OBSERVED_USAGE')
    config=json.loads(require_regular(ROOT/'config.json',2097152).read_text())
    seen={}
    for inbound in config.get('inbounds',[]):
        if inbound.get('protocol')=='vless' and inbound.get('port') in (443,8443):
            seen[inbound['port']]=inbound.get('settings',{}).get('users')
    if set(seen)!={443,8443} or any(
        not isinstance(users,list) or len(users)!=1 or
        users[0].get('id')!=uid or users[0].get('email')!='v2-'+sid
        for users in seen.values()
    ): raise RecoveryBlocked('XRAY_CLIENT_MISMATCH')
    return {'account_id':sid,'checked_ms':int(time.time()*1000)}

def apply(node_id,ip,run=subprocess.run):
    proof=preflight(node_id,ip,run)
    # No changes at all before explicit acknowledgement by owner.
    run(['/usr/bin/systemctl','stop',AGENT],timeout=25,check=True,
        stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    backup=None
    try:
        if service_active(AGENT,run) or service_active(XRAY,run) or not ports_are_clear(run):
            raise RecoveryBlocked('SERVICES_CHANGED_DURING_STOP')
        # Re-verify the ledger after taking the runtime out of service.
        rows=read_accounts(require_regular(DB,100*1024*1024))
        if len(rows)!=1 or rows[0][0]!=proof['account_id'] or tuple(rows[0][2:])!=(1,1,0,0,0,0,0):
            raise RecoveryBlocked('LEDGER_CHANGED_DURING_STOP')
        os.umask(0o077)
        backup=pathlib.Path(tempfile.mkdtemp(prefix='madar-v2-generation-gap-',dir='/root'))
        with sqlite3.connect('file:'+str(DB)+'?mode=ro',uri=True) as src:
            with sqlite3.connect(str(backup/'quota.sqlite')) as dst: src.backup(dst)
        os.chmod(backup/'quota.sqlite',0o600)
        for filename,src in {
            'heartbeat.json':MARKER,
            'config.json':ROOT/'config.json',
            'public-route-metadata.json':ROOT/'public-route-metadata.json',
            'local-secrets.json':ROOT/'local-secrets.json',
            'node.key':ROOT/'node.key',
        }.items():
            shutil.copyfile(require_regular(src,2097152),backup/filename)
            os.chmod(backup/filename,0o600)
        # Capture the unknown gap, rather than claiming observed usage == actual usage.
        with sqlite3.connect(DB,timeout=10) as db:
            db.execute('BEGIN IMMEDIATE')
            result=db.execute(
                'UPDATE accounts SET installed=0 WHERE id=? AND installed=1 '
                'AND present=1 AND counter=0 AND total=0 AND used=0 '
                'AND sequence=0 AND reported_seq=0',(proof['account_id'],))
            if result.rowcount!=1: raise RecoveryBlocked('LEDGER_RACE')
            audit=json.dumps({'node_id':node_id,'reason':'offline_xray_generation_gap',
              'unmetered_traffic_possible':True,'observed_counter_bytes':0,
              'observed_total_bytes':0,'recovered_ms':int(time.time()*1000)},
              sort_keys=True,separators=(',',':'))
            db.execute('INSERT INTO meta(key,value) VALUES(?,?)',
              ('manual_generation_gap_'+str(int(time.time()*1000)),audit))
            db.commit()
        return str(backup)
    finally:
        # Restore only the already-running control Agent, never bypass its
        # original signed policy or start Xray independently.
        restarted=run(['/usr/bin/systemctl','start',AGENT],timeout=25,check=False,
              stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,
              stderr=subprocess.DEVNULL)
        if restarted.returncode!=0:
            raise RecoveryBlocked('AGENT_RESTART_FAILED_CHECK_PRIVATE_BACKUP')

def main(argv=None):
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--node-id',required=True)
    p.add_argument('--public-ip',required=True)
    p.add_argument('--apply',action='store_true')
    p.add_argument('--acknowledge-possible-unmetered-traffic',action='store_true')
    p.add_argument('--confirm-no-real-customer',action='store_true')
    args=p.parse_args(argv)
    try:
        preflight(args.node_id,args.public_ip)
        if not args.apply:
            print(json.dumps({'result':'PREFLIGHT_ELIGIBLE',
              'warning':'ZERO_OBSERVED_DOES_NOT_PROVE_ZERO_ACTUAL_TRAFFIC'}))
            return
        if not (args.acknowledge_possible_unmetered_traffic and
                args.confirm_no_real_customer):
            raise RecoveryBlocked('EXPLICIT_OWNER_CONSENT_REQUIRED')
        backup=apply(args.node_id,args.public_ip)
        print(json.dumps({'result':'RECOVERY_EPOCH_AUDITED',
          'backup':backup,'warning':'HISTORICAL_TRAFFIC_UNKNOWN_VERIFY_FRESH_HEALTH'}))
    except (OSError,ValueError,sqlite3.Error,subprocess.SubprocessError,RecoveryBlocked) as exc:
        code=str(exc) if isinstance(exc,RecoveryBlocked) else 'RECOVERY_UNEXPECTED_FAILURE'
        print(json.dumps({'result':'BLOCKED','code':code}))
        raise SystemExit(1)

if __name__=='__main__':
    main()
