"""Isolated V2 dual-port Xray account reconciler and local quota watchdog.

Run as the dedicated root-managed V2 systemd unit only on an approved fresh VPS.
No shell commands, remote code downloads, or changes to V1 Xray services.
A *signed* manifest and policy are required before customer activation.
"""
import argparse
import fcntl
import hashlib
import json
import os
import pathlib
import socket
import stat
import subprocess
import tempfile
import time
import urllib.request
import urllib.error

from .account_policy import (
    API_PORT, LocalLedger, compile_dual_account_config, parse_stats, verify_clients
)
from .bootstrap import XRAY_UNIT
from .installer import require_staging_marker
from .poller import NoRedirect, poll_once, read_node_secret, send, validate_server
from .reconciler import ReconcileError, apply_config, _safe_config_root
from .releases import xray_binary_sha256
from .xray_config import encode

XRAY=pathlib.Path('/opt/madar-v2/bin/xray')
DEFAULT_ROOT=pathlib.Path('/etc/madar-v2')
DEFAULT_STATE=pathlib.Path('/var/lib/madar-v2/runtime')
HEARTBEAT='heartbeat.json'
MAX_STATS=1048576
# Only enumerated diagnostic codes are written to systemd journal.
# Never emit raw remote response bodies, UUIDs, HMACs, paths or secrets.
PUBLIC_RUNTIME_CODES={
    'unrecognized Xray process generation':'XRAY_GENERATION_MISMATCH',
    'signed policy lease expired':'POLICY_LEASE_EXPIRED',
    'dual REALITY and stats listeners not active':'XRAY_PORTS_MISSING',
    'Xray not active':'XRAY_STOPPED',
    'live node health not acknowledged':'HEALTH_ACK_REJECTED',
    'client activation not acknowledged':'CLIENT_ACK_REJECTED',
    'revocation not acknowledged':'REVOCATION_ACK_REJECTED',
    'usage not acknowledged':'USAGE_ACK_REJECTED',
}

def runtime_diagnostic_code(error):
    if isinstance(error,urllib.error.HTTPError):
        return 'HTTP_'+str(error.code) if error.code in (400,401,403,404,409,429,500,502,503,504) else 'HTTP_ERROR'
    if isinstance(error,ReconcileError):
        return PUBLIC_RUNTIME_CODES.get(str(error),'RECONCILE_FAILED')
    if isinstance(error,(OSError,TimeoutError)):
        return 'NETWORK_OR_FILESYSTEM_ERROR'
    if isinstance(error,(ValueError,KeyError)):
        return 'INVALID_RUNTIME_STATE'
    return 'AGENT_ERROR'

def journal_safe_error(phase,error):
    # Stable codes let the admin diagnose service availability, without secrets.
    print('MADAR_RUNTIME_FAULT',phase,runtime_diagnostic_code(error),flush=True)


def read_secret_file(root):
    path=pathlib.Path(root)/'local-secrets.json'
    info=path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.geteuid() or info.st_mode&0o077:
        raise ReconcileError('local secrets must be root-owned mode 0600')
    if info.st_size>8192:
        raise ReconcileError('oversized local secrets')
    return json.loads(path.read_text(encoding='utf-8'))


def xray_pid(runner=subprocess.run):
    result=runner(['/usr/bin/systemctl','show','-p','MainPID','--value',XRAY_UNIT],
        capture_output=True,text=True,timeout=5,check=True)
    pid=int(result.stdout.strip())
    if pid<=1:
        raise ReconcileError('Xray not active')
    return pid


def stats_snapshot(binary=XRAY,runner=subprocess.run):
    """Never reset Xray counters; local SQLite holds durable deltas."""
    with tempfile.TemporaryFile() as output:
        runner([str(binary),'api','statsquery','--server=127.0.0.1:'+str(API_PORT),
               '-timeout','2','-pattern','user>>>'],
               stdin=subprocess.DEVNULL,stdout=output,stderr=subprocess.DEVNULL,
               timeout=4,check=True)
        output.seek(0)
        raw=output.read(MAX_STATS+1)
    if len(raw)>MAX_STATS:
        raise ReconcileError('Xray stats too large')
    return raw.decode('utf-8')


def ports_listening():
    for port in (443,8443,API_PORT):
        try:
            with socket.create_connection(('127.0.0.1',port),timeout=1):
                pass
        except OSError:
            return False
    return True


def wait_for_xray_readiness(runner=subprocess.run,*,timeout=6.0,interval=0.25,
                            monotonic=time.monotonic,sleep=time.sleep):
    """Bounded readiness gate for systemd Type=simple Xray startup.

    A successful systemctl start is NOT proof that TCP listeners and the
    StatsService are ready. Never acknowledge a customer before all three
    listener ports, the stats API, and a single stable live PID pass.
    External watchdog and quota enforcement remain enabled.
    """
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


def store_marker(root,document):
    path=pathlib.Path(root)/HEARTBEAT
    data=json.dumps(document,separators=(',',':'),sort_keys=True)
    fd=os.open(path,os.O_CREAT|os.O_WRONLY|os.O_TRUNC|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'w',encoding='utf-8') as f:
        os.fchmod(f.fileno(),0o600)
        f.write(data)
        f.flush()
        os.fsync(f.fileno())


def read_marker(root):
    try:
        return json.loads((pathlib.Path(root)/HEARTBEAT).read_text())
    except (OSError,ValueError):
        return None


def stop_owned_xray(runner=subprocess.run):
    runner(['/usr/bin/systemctl','stop',XRAY_UNIT],
        stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,check=False,timeout=15)


def watchdog(root=DEFAULT_STATE,now_ms=None,stop=stop_owned_xray):
    """Standalone systemd timer stops Xray if a COMMERCIAL agent dies."""
    now_ms=int(time.time()*1000) if now_ms is None else now_ms
    doc=read_marker(root)
    if not doc or doc.get('mode')!='commercial':
        return False
    stamp=doc.get('checked_ms')
    expires=doc.get('policy_until_ms')
    if type(stamp) is not int or type(expires) is not int or expires<=now_ms or stamp>now_ms+10000 or now_ms-stamp>45000:
        stop()
        return False
    return True


class Runtime:
    def __init__(self,*,origin,node_id,key,root=DEFAULT_ROOT,state=DEFAULT_STATE,
                 opener=None,clock=time.time,runner=subprocess.run):
        self.origin=validate_server(origin)
        self.node_id=node_id
        self.key=key
        self.root=_safe_config_root(root)
        require_staging_marker(self.root)
        self.state=pathlib.Path(state)
        self.state.mkdir(mode=0o700,parents=True,exist_ok=True)
        os.chmod(self.state,0o700)
        self.clock=clock
        self.runner=runner
        self.opener=opener or urllib.request.build_opener(
            urllib.request.ProxyHandler({}),NoRedirect()
        )
    def call(self,method,path,payload=None):
        return send(self.opener,self.origin,self.node_id,self.key,method,path,payload)
    def sample(self,ledger,now_ms):
        ids=[r['id'] for r in ledger.all() if r['installed']==1]
        if not ids:
            return
        # A service restart outside a controlled reconciliation loses
        # continuity: refuse to undercount unknown bytes.
        pid=xray_pid(self.runner)
        recorded=read_marker(self.state)
        if not recorded or recorded.get('mode')!='commercial' or recorded.get('pid')!=pid:
            raise ReconcileError('unrecognized Xray process generation')
        absolute=parse_stats(stats_snapshot(XRAY,self.runner),ids)
        if xray_pid(self.runner)!=pid:
            raise ReconcileError('unrecognized Xray process generation')
        ledger.observe(absolute,now_ms)
    def apply(self,ledger,active):
        desired=compile_dual_account_config(read_secret_file(self.root),active)
        current_path=self.root/'config.json'
        current=json.loads(current_path.read_text(encoding='utf-8'))
        changed=current!=desired
        if changed:
            apply_config(self.root,desired,binary=XRAY,sha256=xray_binary_sha256(),
                         runner=self._simple_runner)
            ledger.epoch_reset()
        else:
            is_active=self.runner(['/usr/bin/systemctl','is-active','--quiet',XRAY_UNIT],
                check=False,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,timeout=5).returncode==0
            if not is_active:
                self.runner(['/usr/bin/systemctl','start',XRAY_UNIT],
                    check=True,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,timeout=20)
                ledger.epoch_reset()
        # Type=simple returns before sockets and StatsService are necessarily
        # ready. Do not race immediate readiness against the Xray startup.
        # The signed policy lease and the independent watchdog are unchanged.
        wait_for_xray_readiness(self.runner)
        ledger.mark_installed([x['subscription_id'] for x in active])
        return changed
    def _simple_runner(self,args,timeout=20):
        try:
            return self.runner(args,stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
                check=False,timeout=timeout).returncode==0
        except (OSError,subprocess.TimeoutExpired):
            return False
    def report_usage(self,ledger,now_ms):
        pending=ledger.reportable()
        for start in range(0,len(pending),20):
            group=pending[start:start+20]
            payload={'revision':self.revision,'reports':[
              {'subscription_id':r['id'],'sequence':r['sequence'],
               'cumulative_bytes':r['total'],'observed_ms':now_ms}
              for r in group
            ]}
            result=self.call('POST','/api/node/v1/usage',payload)
            if result.get('ok') is not True:
                raise ReconcileError('usage not acknowledged')
            received={x['subscription_id']:x for x in result.get('received',[])}
            if len(received)!=len(group):
                raise ReconcileError('usage ACK incomplete')
            for r in group:
                if received[r['id']]['sequence']<r['sequence']:
                    raise ReconcileError('usage ACK stale')
                ledger.ack_report(r['id'],r['sequence'])
    def announce_clients(self,active):
        for start in range(0,len(active),80):
            batch=active[start:start+80]
            payload={'revision':self.revision,'ports':[443,8443],'xray_healthy':True,
              'clients':[{'subscription_id':c['subscription_id'],
                'uuid_sha256':hashlib.sha256(c['uuid'].encode('ascii')).hexdigest()}
                for c in batch]}
            response=self.call('POST','/api/node/v1/clients/ack',payload)
            if response.get('ok') is not True:
                raise ReconcileError('client activation not acknowledged')
    def revoke(self,ledger):
        removed=[r['id'] for r in ledger.all()
          if not r['present'] or not r['installed']]
        for start in range(0,len(removed),80):
            response=self.call('POST','/api/node/v1/clients/revoked',
                {'revision':self.revision,'subscription_ids':removed[start:start+80]})
            if response.get('ok') is not True:
                raise ReconcileError('revocation not acknowledged')
    def once(self):
        now_ms=int(self.clock()*1000)
        # The original signed desired-state protocol remains intact.
        poll_once(self.origin,self.node_id,self.key,self.state/'desired',
                  opener=self.opener,now=int(self.clock()))
        envelope=self.call('GET','/api/node/v1/clients')
        policy=verify_clients(envelope,self.key,self.node_id,now=int(self.clock()))
        self.revision=policy['revision']
        if policy['mode']!='commercial':
            # Never continue a former commercial session after demotion.
            old=read_marker(self.state)
            if old and old.get('mode')=='commercial':
                stop_owned_xray()
                raise ReconcileError('commercial node was demoted')
            # Leave the original bootstrap UUID available for field testing.
            return {'mode':'test','connected':False}
        ledger=LocalLedger(self.state/'quota.sqlite')
        try:
            self.sample(ledger,now_ms)
            ledger.reconcile(policy['clients'],now_ms)
            # LocalLedger rows use "id", while the signed client policy and
            # Xray/ACK compiler require "subscription_id". The first new
            # commercial account must be normalized BEFORE apply/ACK; otherwise
            # a KeyError strands the order in provisioning forever.
            active=[{'subscription_id':row['id'],'uuid':row['uuid']}
                    for row in ledger.active(now_ms)]
            self.apply(ledger,active)
            pid=xray_pid(self.runner)
            store_marker(self.state,{'mode':'commercial','pid':pid,
                'checked_ms':now_ms,'policy_until_ms':policy['expires_at']*1000})
            response=self.call('POST','/api/node/v1/health',{
                'revision':self.revision,'observed_ms':now_ms,
                'xray_healthy':True,'stats_healthy':True,'ports':[443,8443]})
            if response.get('ok') is not True:
                raise ReconcileError('live node health not acknowledged')
            self.announce_clients(active)
            self.report_usage(ledger,now_ms)
            self.revoke(ledger)
            return {'mode':'commercial','active':len(active)}
        finally:
            ledger.close()
    def local_tick(self):
        """Locally enforce byte and time limits every second, with NO Cloudflare call."""
        old=read_marker(self.state)
        if not old or old.get('mode')!='commercial':
            return
        now_ms=int(self.clock()*1000)
        if type(old.get('policy_until_ms')) is not int or now_ms>=old['policy_until_ms']:
            stop_owned_xray()
            raise ReconcileError('signed policy lease expired')
        ledger=LocalLedger(self.state/'quota.sqlite')
        try:
            self.sample(ledger,now_ms)
            active=ledger.active(now_ms)
            self.apply(ledger,[{'subscription_id':r['id'],'uuid':r['uuid']} for r in active])
            pid=xray_pid(self.runner)
            store_marker(self.state,{'mode':'commercial','pid':pid,
                'checked_ms':now_ms,'policy_until_ms':old['policy_until_ms']})
        finally:
            ledger.close()
    def loop(self):
        """Slow signed policy polling, fast local accounting and watchdog."""
        next_remote=0
        while True:
            now=self.clock()
            if now>=next_remote:
                try:
                    self.once()
                    next_remote=now+30
                except Exception as exc:
                    journal_safe_error('remote',exc)
                    next_remote=now+15
                    # No renewal on a failed request. Enforce the existing
                    # signed deadline locally; the watchdog stops a dead agent.
                    old=read_marker(self.state)
                    if old and old.get('mode')=='commercial':
                        watchdog(self.state,stop=stop_owned_xray)
            else:
                try:
                    self.local_tick()
                except Exception as exc:
                    journal_safe_error('local',exc)
                    stop_owned_xray()
            time.sleep(1)


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--server',required=True)
    parser.add_argument('--node-id',required=True)
    parser.add_argument('--key-file',required=True)
    parser.add_argument('--state-dir',default=str(DEFAULT_STATE))
    parser.add_argument('--root',default=str(DEFAULT_ROOT))
    parser.add_argument('--watchdog',action='store_true')
    args=parser.parse_args(argv)
    if os.geteuid()!=0:
        raise SystemExit('isolated V2 runtime requires root')
    if args.watchdog:
        watchdog(args.state_dir)
        return
    key=read_node_secret(args.key_file)
    runtime=Runtime(origin=args.server,node_id=args.node_id,key=key,
        state=args.state_dir,root=args.root)
    lock_path=pathlib.Path(args.state_dir)/'runtime.lock'
    fd=os.open(lock_path,os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'w') as lock:
        fcntl.flock(lock.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)
        runtime.loop()


if __name__=='__main__':
    main()
