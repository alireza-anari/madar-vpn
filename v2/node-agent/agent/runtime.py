"""Isolated V2 dual-port Xray account reconciler and local quota watchdog.

Run as the dedicated root-managed V2 systemd unit only on an approved fresh VPS.
No shell commands, remote code downloads, or changes to V1 Xray services.
A *signed* manifest and policy are required before customer activation.
"""
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
import pathlib
import secrets
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

XRAY=pathlib.Path('/opt/madar-v2/bin/xray')
DEFAULT_ROOT=pathlib.Path('/etc/madar-v2')
DEFAULT_STATE=pathlib.Path('/var/lib/madar-v2/runtime')
HEARTBEAT='heartbeat.json'
MAX_STATS=1048576
LEASE_RECOVERY_KEY='lease_recovery_pending'
# Stop slightly early when renewal is unavailable, rather than wait for
# the independent watchdog to race the final local accounting checkpoint.
LEASE_STOP_MARGIN_MS=10000
HEARTBEAT_MAX_AGE_MS=45000
MAX_MAILBOX=4*1024*1024
FENCE='generation-fence.json'
POLICY='policy-inbox.json'
OUTBOX='runtime-outbox.json'
RECEIPTS='usage-receipts.json'
START_RECEIPT='start-receipt.json'
RECOVERY_MIN_LEASE_MS=40000
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
    'lease recovery requires manual review':'LEASE_RECOVERY_REVIEW',
    'signed policy rollback':'POLICY_ROLLBACK',
    'commercial node was demoted':'POLICY_DEMOTED',
}

def runtime_diagnostic_code(error):
    if isinstance(error,urllib.error.HTTPError):
        return 'HTTP_'+str(error.code) if error.code in (400,401,403,404,409,429,500,502,503,504) else 'HTTP_ERROR'
    if isinstance(error,ReconcileError):
        return PUBLIC_RUNTIME_CODES.get(str(error),'RECONCILE_FAILED')
    if isinstance(error,(OSError,TimeoutError)):
        return 'IO_ERROR'
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


def store_document(root,name,document):
    path=pathlib.Path(root)/name
    data=json.dumps(document,separators=(',',':'),sort_keys=True)
    # The independent watchdog must never observe a partially written marker.
    fd,name=tempfile.mkstemp(prefix='.'+path.name+'-',dir=path.parent)
    try:
        with os.fdopen(fd,'w',encoding='utf-8') as f:
            os.fchmod(f.fileno(),0o600)
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(name,path)
        directory=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        pathlib.Path(name).unlink(missing_ok=True)


def store_marker(root,document):
    store_document(root,HEARTBEAT,document)


def boot_id():
    return pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()


def boot_ms():
    return int(time.clock_gettime(time.CLOCK_BOOTTIME)*1000)


def read_document(root, name):
    try:
        with (pathlib.Path(root)/name).open('rb') as stream:
            data=stream.read(MAX_MAILBOX+1)
    except FileNotFoundError:
        return None
    if len(data)>MAX_MAILBOX:
        raise ValueError('oversized local record')
    doc=json.loads(data)
    if not isinstance(doc,dict):
        raise ValueError('invalid local record')
    return doc


def read_marker(root):
    return read_document(root, HEARTBEAT)


def stop_owned_xray(runner=subprocess.run):
    runner(['/usr/bin/systemctl','stop',XRAY_UNIT],
        stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,check=True,timeout=15)


@contextmanager
def transition_guard(root,timeout=0.5):
    """Bound lock contention. The watchdog can fence starts without this lock."""
    path=pathlib.Path(root)/'lease-transition.lock'
    fd=os.open(path,os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    acquired=False
    try:
        deadline=time.monotonic()+timeout
        while True:
            try:
                fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
                acquired=True
                break
            except BlockingIOError:
                if time.monotonic()>=deadline:
                    break
                time.sleep(0.025)
        yield acquired
    finally:
        os.close(fd)


def service_generation(runner=subprocess.run):
    fields=('ActiveState','MainPID','ExecMainPID','ExecMainCode','ExecMainStatus',
            'ExecMainStartTimestampMonotonic','ExecMainExitTimestampMonotonic','Result')
    args=['/usr/bin/systemctl','show','--no-pager',XRAY_UNIT]
    for field in fields:
        args+=['-p',field]
    result=runner(args,capture_output=True,text=True,timeout=2,check=True)
    values=dict(line.split('=',1) for line in result.stdout.splitlines() if '=' in line)
    if any(field not in values for field in fields):
        raise ReconcileError('unrecognized Xray process generation')
    return values


def generation(evidence):
    start=int(evidence['ExecMainStartTimestampMonotonic'])
    pid=int(evidence['ExecMainPID'])
    if min(pid,start)<=1:
        raise ReconcileError('unrecognized Xray process generation')
    return {'pid':pid,'start_us':start,'boot_id':boot_id()}


def live_generation(runner):
    info=service_generation(runner)
    if info['ActiveState']!='active' or int(info['MainPID'])<=1:
        raise ReconcileError('Xray not active')
    result=generation(info)
    if int(info['MainPID'])!=result['pid']:
        raise ReconcileError('unrecognized Xray process generation')
    return result


def match_running(doc,current,now_ms):
    if doc.get('generation') is not None:
        return doc['generation']==current and doc.get('pid')==current['pid']
    # Adopt a running PR72 generation only when both recorded checks and the
    # observed service start belong to this boot. PID alone is insufficient.
    stamp=doc.get('checked_ms')
    boot_wall_ms=now_ms-boot_ms()
    service_start_ms=now_ms-int(time.monotonic()*1000)+current['start_us']//1000
    return (doc.get('pid')==current['pid'] and type(stamp) is int
            and max(boot_wall_ms,service_start_ms)<=stamp<=now_ms)


def stop_evidence(info,expected):
    if (info['ActiveState']!='inactive' or info['MainPID']!='0' or
        info['Result']!='success' or
        (info['ExecMainCode'],info['ExecMainStatus']) not in (('1','0'),('2','15')) or
        generation(info)!=expected):
        raise ReconcileError('lease recovery requires manual review')
    exit_us=int(info['ExecMainExitTimestampMonotonic'])
    if exit_us<=expected['start_us']:
        raise ReconcileError('lease recovery requires manual review')
    return exit_us


def ledger_checkpoint(ledger):
    # Reporting acknowledgements do not mutate the metering checkpoint.
    rows=[{k:v for k,v in row.items() if k!='reported_seq'} for row in ledger.all()]
    return hashlib.sha256(json.dumps(rows,sort_keys=True,separators=(',',':')).encode()).hexdigest()


def recovery_ticket(ledger):
    row=ledger.db.execute('SELECT value FROM meta WHERE key=?',(LEASE_RECOVERY_KEY,)).fetchone()
    return json.loads(row[0]) if row else None


def write_ticket(ledger,ticket):
    ledger.db.execute('INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)',
        (LEASE_RECOVERY_KEY,json.dumps(ticket,sort_keys=True,separators=(',',':'))))


def fenced(root):
    return (pathlib.Path(root)/FENCE).exists()


def fail_closed(root,stop):
    # Fence before stopping. An overlapping restart or boot-time start must
    # also pass the Xray-side ExecStartPre gate.
    try:
        store_document(root,FENCE,{'requires_review':True,'unobserved_tail':'unknown'})
    finally:
        stop()


def lease_remaining(doc,now_ms):
    until=doc.get('policy_until_ms')
    if type(until) is not int:
        return 0
    remaining=until-now_ms
    if 'deadline_boot_ms' in doc:
        remaining=min(remaining,doc['deadline_boot_ms']-boot_ms())
    return remaining


def usable_lease(doc,now_ms):
    stamp=doc.get('checked_ms')
    if type(stamp) is not int or not 0<=now_ms-stamp<=HEARTBEAT_MAX_AGE_MS:
        return False
    if 'checked_boot_ms' in doc:
        if not 0<=boot_ms()-doc['checked_boot_ms']<=HEARTBEAT_MAX_AGE_MS:
            return False
        if doc.get('boot_id')!=boot_id():
            return False
    return lease_remaining(doc,now_ms)>0


def config_digest(config):
    return hashlib.sha256(json.dumps(config,sort_keys=True,separators=(',',':')).encode()).hexdigest()


def xray_start_allowed(root,now_ms,*,config_root=None):
    if fenced(root):
        return False
    doc=read_marker(root)
    if doc is None:
        if (pathlib.Path(root)/'quota.sqlite').exists():
            return False
        if config_root is None:
            return True
        # With no runtime state, permit only the installed bootstrap UUID.
        local=read_secret_file(config_root)
        config=json.loads((config_root/'config.json').read_text(encoding='utf-8'))
        return all(user['id'] in local['clients'] for inbound in config['inbounds']
                   if inbound['protocol']=='vless' for user in inbound['settings']['users'])
    if (doc.get('mode')!='commercial' or doc.get('phase')!='starting' or
        doc.get('boot_id')!=boot_id() or not usable_lease(doc,now_ms)):
        return False
    if config_root is not None:
        config=json.loads((config_root/'config.json').read_text(encoding='utf-8'))
        receipt=read_document(root,START_RECEIPT)
        nonce=doc['start_nonce']
        if config_digest(config)!=doc.get('config_digest') or receipt=={'nonce':nonce}:
            return False
        # systemd serializes ExecStartPre invocations for this one unit.
        # The local controller never writes this receipt.
        store_document(root,START_RECEIPT,{'nonce':nonce})
    return not fenced(root)


def checkpoint_stop(root,doc,now_ms,stop,runner,reason,clock):
    """Both the local loop and watchdog use this under the transition lock."""
    if (not doc or doc.get('mode')!='commercial' or doc.get('phase') or
        not (pathlib.Path(root)/'quota.sqlite').is_file() or
        type(doc.get('checked_ms')) is not int or doc['checked_ms']>now_ms or
        type(doc.get('policy_until_ms')) is not int or fenced(root)):
        raise ReconcileError('lease recovery requires manual review')
    ledger=LocalLedger(pathlib.Path(root)/'quota.sqlite',timeout=0.25)
    try:
        current=live_generation(runner)
        digest=ledger_checkpoint(ledger)
        # A watchdog-first stop may use an older, still valid generation's
        # checkpoint. It cannot attribute any bytes since that sample.
        if (not match_running(doc,current,now_ms) or recovery_ticket(ledger) is not None or
            doc.get('checkpoint',digest)!=digest):
            raise ReconcileError('lease recovery requires manual review')
        ticket={'phase':'stopping','generation':current,'policy_until_ms':doc['policy_until_ms'],
                'revision':doc.get('revision',0),'checked_ms':doc['checked_ms'],
                'checkpoint':digest,'unobserved_tail':'unknown','reason':reason}
        with ledger.db:
            write_ticket(ledger,ticket)
        store_marker(root,{**doc,'phase':'stopping','stop_started_ms':now_ms})
        request_us=time.monotonic_ns()//1000
        stop()
        exit_us=stop_evidence(service_generation(runner),current)
        if exit_us<request_us:
            raise ReconcileError('lease recovery requires manual review')
        ticket.update(phase='stopped',exit_us=exit_us,stopped_ms=int(clock()*1000))
        with ledger.db:
            write_ticket(ledger,ticket)
            ledger.db.execute('INSERT INTO meta(key,value) VALUES(?,?)',
                ('controlled_lease_gap_'+str(ticket['stopped_ms']),json.dumps(ticket,sort_keys=True)))
        store_marker(root,{**doc,'phase':'lease_stopped'})
        print('MADAR_LEASE_STOP_CHECKPOINTED',flush=True)
    finally:
        ledger.close()


def watchdog(root=DEFAULT_STATE,now_ms=None,stop=stop_owned_xray,runner=subprocess.run,
             clock=time.time):
    """An independent checker with a bounded, fail-closed lock fallback."""
    root=pathlib.Path(root)
    try:
        with transition_guard(root) as acquired:
            now_ms=int(clock()*1000) if now_ms is None else now_ms
            doc=read_marker(root)
            if doc is None and not (root/'quota.sqlite').exists() and not fenced(root):
                return False
            if not doc or doc.get('mode')!='commercial' or fenced(root):
                raise ReconcileError('lease recovery requires manual review')
            phase=doc.get('phase')
            if phase=='lease_stopped':
                # If the lock is held, recovery might already have moved past
                # this snapshot. A stopped generation is checked by the local
                # start gate and there is no active lease to extend here.
                if acquired:
                    if service_generation(runner)['ActiveState'] in ('inactive','failed'):
                        return False
                    raise ReconcileError('lease recovery requires manual review')
                return False
            if (phase=='stopping' and not acquired and
                type(doc.get('stop_started_ms')) is int and
                0<=now_ms-doc['stop_started_ms']<LEASE_STOP_MARGIN_MS and
                lease_remaining(doc,now_ms)>0):
                return False
            if phase in (None,'starting') and usable_lease(doc,now_ms):
                if phase=='starting' and doc.get('boot_id')!=boot_id():
                    raise ReconcileError('lease recovery requires manual review')
                return True
            if not acquired or phase:
                raise ReconcileError('lease recovery requires manual review')
            checkpoint_stop(root,doc,now_ms,stop,runner,'watchdog',clock)
            return False
    except Exception as exc:
        journal_safe_error('watchdog',exc)
        fail_closed(root,stop)
        return False


def current_mailbox(root,name,now_ms,max_age):
    doc=read_document(root,name)
    if doc is None:
        return None
    stamp=doc.get('published_ms')
    if type(stamp) is not int:
        raise ValueError('invalid mailbox timestamp')
    if doc.get('boot_id')==boot_id() and 0<=now_ms-stamp<=max_age:
        return doc
    return None


def publish(root,name,doc,now_ms):
    store_document(root,name,{**doc,'published_ms':now_ms,'boot_id':boot_id()})


def valid_usage_receipts(expected,received):
    """Accept only a durable checkpoint no newer than the submitted local usage.

    The control plane coalesces frequent usage reports. An older acknowledged
    sequence remains safe: publish_usage marks only that sequence as reported,
    leaving newer local bytes pending for the next network cycle.
    """
    if not isinstance(expected,list) or not isinstance(received,list) or len(expected)!=len(received):
        return False
    expected_by_id={}
    for row in expected:
        if not isinstance(row,dict):
            return False
        sid=row.get('subscription_id')
        if not isinstance(sid,str) or sid in expected_by_id:
            return False
        if type(row.get('sequence')) is not int or row['sequence']<1:
            return False
        if type(row.get('cumulative_bytes')) is not int or row['cumulative_bytes']<0:
            return False
        expected_by_id[sid]=row
    seen=set()
    for receipt in received:
        if not isinstance(receipt,dict) or set(receipt)!={'subscription_id','sequence','cumulative_bytes'}:
            return False
        sid=receipt.get('subscription_id')
        submitted=expected_by_id.get(sid)
        sequence=receipt.get('sequence')
        cumulative=receipt.get('cumulative_bytes')
        if sid in seen or submitted is None or type(sequence) is not int or type(cumulative) is not int:
            return False
        if sequence<1 or sequence>submitted['sequence'] or cumulative<0 or cumulative>submitted['cumulative_bytes']:
            return False
        if sequence==submitted['sequence'] and cumulative!=submitted['cumulative_bytes']:
            return False
        seen.add(sid)
    return seen==set(expected_by_id)


def network_cycle(origin,node_id,key,state,*,clock=time.time,opener=None):
    """Own all external I/O. The local runtime owns the ledger and Xray."""
    opener=opener or urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
    origin=validate_server(origin)

    def call(method,path,body=None):
        return send(opener,origin,node_id,key,method,path,body)

    try:
        poll_once(origin,node_id,key,state/'desired',opener=opener,now=int(clock()))
        envelope=send(opener,origin,node_id,key,'GET','/api/node/v1/clients',max_response=384*1024)
    except ValueError:
        publish(state,POLICY,{'envelope':None},int(clock()*1000))
        raise
    publish(state,POLICY,{'envelope':envelope},int(clock()*1000))
    # Verify before using a revision for telemetry. Local control verifies
    # independently before touching the ledger or authorizing any start.
    policy=verify_clients(envelope,key,node_id,now=int(clock()))
    if policy['mode']!='commercial':
        return
    revision=policy['revision']
    out=current_mailbox(state,OUTBOX,int(clock()*1000),15000)
    if not out:
        return
    received=[]
    for batch in chunks(out['usage'],20):
        payload={'revision':revision,'reports':[
            {**report,'observed_ms':out['published_ms']} for report in batch]}
        try:
            response=call('POST','/api/node/v1/usage',payload)
            expected=[{k:v for k,v in report.items() if k!='observed_ms'}
                      for report in payload['reports']]
            acknowledged=response.get('received')
            if response.get('ok') is not True or not valid_usage_receipts(expected,acknowledged):
                raise ReconcileError('usage not acknowledged')
            received.extend(acknowledged)
            publish(state,RECEIPTS,{'usage':received},int(clock()*1000))
        except Exception as exc:
            journal_safe_error('remote',exc)

    def serving():
        now_ms=int(clock()*1000)
        doc=read_marker(state)
        return (doc and not doc.get('phase') and not fenced(state) and
                doc.get('generation')==out['generation'] and
                doc.get('revision')==revision and usable_lease(doc,now_ms) and
                now_ms-out['published_ms']<=15000)

    if not out['generation'] or not serving():
        return
    response=call('POST','/api/node/v1/health',{
        'revision':revision,'observed_ms':out['published_ms'],
        'xray_healthy':True,'stats_healthy':True,'ports':[443,8443]})
    if response.get('ok') is not True:
        raise ReconcileError('live node health not acknowledged')
    allowed={c['subscription_id']:hashlib.sha256(c['uuid'].encode('ascii')).hexdigest()
             for c in policy['clients']}
    clients=[c for c in out['clients'] if allowed.get(c['subscription_id'])==c['uuid_sha256']]
    for batch in chunks(clients,80):
        if not serving():
            return
        response=call('POST','/api/node/v1/clients/ack',{
            'revision':revision,'ports':[443,8443],'xray_healthy':True,'clients':batch})
        if response.get('ok') is not True:
            raise ReconcileError('client activation not acknowledged')
    # Keep the server allocation until outstanding usage has been accepted.
    pending={r['subscription_id'] for r in out['usage']}
    pending.difference_update(r['subscription_id'] for r in received)
    for batch in chunks([sid for sid in out['removed'] if sid not in pending],80):
        if not serving():
            return
        response=call('POST','/api/node/v1/clients/revoked',{
            'revision':revision,'subscription_ids':batch})
        if response.get('ok') is not True:
            raise ReconcileError('revocation not acknowledged')


def chunks(rows,size):
    for start in range(0,len(rows),size):
        yield rows[start:start+size]


class Runtime:
    def __init__(self,*,node_id,key,root=DEFAULT_ROOT,state=DEFAULT_STATE,
                 clock=time.time,runner=subprocess.run):
        self.node_id=node_id
        self.key=key
        self.root=_safe_config_root(root)
        require_staging_marker(self.root)
        self.state=_safe_config_root(state)
        self.clock=clock
        self.runner=runner
        self.last_policy=None

    def stop(self):
        stop_owned_xray(self.runner)

    def sample(self,ledger,old,now_ms):
        current=live_generation(self.runner)
        if (not match_running(old,current,now_ms) or
            ('checkpoint' in old and old['checkpoint']!=ledger_checkpoint(ledger))):
            raise ReconcileError('unrecognized Xray process generation')
        ids=[r['id'] for r in ledger.all() if r['installed']==1]
        counters=parse_stats(stats_snapshot(XRAY,self.runner),ids)
        if live_generation(self.runner)!=current:
            raise ReconcileError('unrecognized Xray process generation')
        ledger.observe(counters,now_ms)
        return current

    def accept_policy(self,now_ms,old):
        # Store the observation time separately from the HMAC payload. A
        # mailbox left by a previous boot cannot authorize a new generation.
        incoming=current_mailbox(self.state,POLICY,now_ms,45000)
        if incoming is None or incoming==self.last_policy:
            return None
        self.last_policy=incoming
        policy=verify_clients(incoming.get('envelope'),self.key,self.node_id,now=now_ms//1000)
        if old and (policy['revision']<old.get('revision',0) or
                    policy['issued_at']<old.get('issued_at',0) or
                    (policy['mode']=='commercial' and
                     policy['expires_at']*1000<old.get('policy_until_ms',0))):
            raise ReconcileError('signed policy rollback')
        return policy

    def begin_recovery(self,ledger,policy,old,ticket,now_ms):
        if not isinstance(ticket,dict) or ticket.get('phase')!='stopped':
            raise ReconcileError('lease recovery requires manual review')
        if (old.get('phase')!='lease_stopped' or
            any(old.get(k)!=ticket.get(k) for k in ('checked_ms','policy_until_ms')) or
            ledger_checkpoint(ledger)!=ticket.get('checkpoint')):
            raise ReconcileError('lease recovery requires manual review')
        evidence=service_generation(self.runner)
        if 'generation' in ticket:
            expected=ticket['generation']
            if (old.get('pid')!=expected['pid'] or
                stop_evidence(evidence,expected)!=ticket['exit_us']):
                raise ReconcileError('lease recovery requires manual review')
        else:
            # Existing PR72 tickets can be verified against the same boot and
            # unchanged systemd stop evidence without rewriting their totals.
            if (ticket.get('boot_id')!=boot_id() or ticket.get('pid')!=old.get('pid') or
                generation(evidence)['pid']!=ticket.get('pid') or
                stop_evidence(evidence,generation(evidence))!=int(ticket['exit_monotonic'])):
                raise ReconcileError('lease recovery requires manual review')
        if (not policy or policy['issued_at']*1000<ticket['stopped_ms'] or
            policy['expires_at']*1000<=ticket['policy_until_ms'] or
            policy['revision']<ticket.get('revision',0) or
            policy['expires_at']*1000-now_ms<RECOVERY_MIN_LEASE_MS):
            return False
        with ledger.db:
            write_ticket(ledger,{**ticket,'phase':'starting'})
        return True

    def apply(self,ledger,active,lease,current):
        desired=compile_dual_account_config(read_secret_file(self.root),active)
        installed_config=json.loads((self.root/'config.json').read_text(encoding='utf-8'))
        changed=installed_config!=desired
        if not changed and current is not None:
            return
        now_ms=int(self.clock()*1000)
        if fenced(self.state) or lease_remaining(lease,now_ms)<=LEASE_STOP_MARGIN_MS:
            raise ReconcileError('signed policy lease expired')
        if current is not None:
            gap={'generation':current,'checkpoint':ledger_checkpoint(ledger),
                 'unobserved_tail':'unknown','reason':'config_change'}
            with ledger.db:
                ledger.db.execute('INSERT INTO meta(key,value) VALUES(?,?)',
                    ('config_gap_'+str(now_ms),json.dumps(gap,sort_keys=True)))
        store_marker(self.state,{**lease,'phase':'starting','pid':0,'checked_ms':now_ms,
                                 'boot_id':boot_id(),'checked_boot_ms':boot_ms(),
                                 'start_nonce':secrets.token_hex(16),
                                 'config_digest':config_digest(desired)})
        if changed:
            def apply_runner(args,timeout=20):
                return self._apply_runner(args,timeout,current)
            apply_config(self.root,desired,binary=XRAY,sha256=xray_binary_sha256(),
                         runner=apply_runner,restart_on_rollback=False)
        else:
            self.runner(['/usr/bin/systemctl','start',XRAY_UNIT],
                check=True,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,timeout=15)
        ready_pid=wait_for_xray_readiness(self.runner)
        current=live_generation(self.runner)
        if ready_pid!=current['pid']:
            raise ReconcileError('unrecognized Xray process generation')
        ledger.epoch_reset()
        ledger.mark_installed([x['subscription_id'] for x in active])
        return current

    def _apply_runner(self,args,timeout,current):
        if args[:2]==['/usr/bin/systemctl','restart']:
            if current is not None:
                if live_generation(self.runner)!=current:
                    raise ReconcileError('unrecognized Xray process generation')
                request_us=time.monotonic_ns()//1000
                self.stop()
                if stop_evidence(service_generation(self.runner),current)<request_us:
                    raise ReconcileError('unrecognized Xray process generation')
            elif service_generation(self.runner)['ActiveState']=='active':
                # Initial commercial activation replaces the bootstrap route.
                self.stop()
            if not xray_start_allowed(self.state,int(self.clock()*1000)):
                return False
            args=['/usr/bin/systemctl','start',XRAY_UNIT]
        try:
            return self.runner(args,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,check=False,timeout=min(timeout,15)).returncode==0
        except (OSError,subprocess.TimeoutExpired):
            return False

    def publish_usage(self,ledger,now_ms,*,current=None,active=()):
        receipts=current_mailbox(self.state,RECEIPTS,now_ms,90000)
        if receipts:
            for report in receipts['usage']:
                row=ledger.get(report['subscription_id'])
                if (row and report['sequence']<=row['sequence'] and
                    report['cumulative_bytes']<=row['total'] and
                    row['reported_seq']<report['sequence']):
                    ledger.ack_report(row['id'],report['sequence'])
        publish(self.state,OUTBOX,{
            'generation':current,
            'usage':[{'subscription_id':r['id'],'sequence':r['sequence'],
                      'cumulative_bytes':r['total']} for r in ledger.reportable()],
            'clients':[{'subscription_id':c['subscription_id'],
                        'uuid_sha256':hashlib.sha256(c['uuid'].encode('ascii')).hexdigest()}
                       for c in active],
            'removed':[r['id'] for r in ledger.all() if not r['present'] or not r['installed']],
        },now_ms)

    def tick(self):
        with transition_guard(self.state) as acquired:
            if not acquired or fenced(self.state):
                return
            old=None
            try:
                old=read_marker(self.state)
                now_ms=int(self.clock()*1000)
                try:
                    policy=self.accept_policy(now_ms,old)
                except ValueError as exc:
                    if old and old.get('phase')=='lease_stopped':
                        # The stopped generation still needs a fresh signature.
                        journal_safe_error('local',exc)
                        policy=None
                    else:
                        raise
                self.local_tick(old,policy,now_ms)
            except Exception:
                fail_closed(self.state,self.stop)
                raise

    def local_tick(self,old,policy,now_ms):
        path=self.state/'quota.sqlite'
        if not old:
            if path.exists():
                raise ReconcileError('lease recovery requires manual review')
            if not policy or policy['mode']!='commercial':
                return
        elif (old.get('mode')!='commercial' or not path.is_file() or
              old.get('phase') not in (None,'lease_stopped')):
            raise ReconcileError('lease recovery requires manual review')
        if policy and policy['mode']!='commercial':
            raise ReconcileError('commercial node was demoted')
        if (old and not old.get('phase') and
            (not usable_lease(old,now_ms) or lease_remaining(old,now_ms)<=LEASE_STOP_MARGIN_MS)):
            checkpoint_stop(self.state,old,now_ms,self.stop,self.runner,'local',self.clock)
            # A renewal received at the boundary cannot bypass the stop.
            return

        ledger=LocalLedger(path,timeout=0.25)
        try:
            ticket=recovery_ticket(ledger)
            recovering=old and old.get('phase')=='lease_stopped'
            if recovering:
                self.publish_usage(ledger,now_ms)
                if not self.begin_recovery(ledger,policy,old,ticket,now_ms):
                    return
                # A durable starting ticket precedes every recovery attempt.
                # Fence on any exception after consuming it, including failures
                # before Xray's startup marker could be written.
                store_marker(self.state,{**old,'phase':'recovering'})
            elif ticket is not None:
                raise ReconcileError('lease recovery requires manual review')
            current=self.sample(ledger,old,now_ms) if old and not recovering else None
            if policy:
                ledger.reconcile(policy['clients'],now_ms)
                until=policy['expires_at']*1000
                deadline=boot_ms()+until-int(self.clock()*1000)
                if old and until==old.get('policy_until_ms'):
                    deadline=min(deadline,old.get('deadline_boot_ms',deadline))
                lease={'mode':'commercial','revision':policy['revision'],
                       'issued_at':policy['issued_at'],'policy_until_ms':until,
                       'deadline_boot_ms':deadline}
            else:
                lease={k:old[k] for k in ('mode','revision','issued_at',
                      'policy_until_ms','deadline_boot_ms') if k in old}
                lease.setdefault('deadline_boot_ms',boot_ms()+lease['policy_until_ms']-now_ms)
            now_ms=int(self.clock()*1000)
            active=[{'subscription_id':r['id'],'uuid':r['uuid']} for r in ledger.active(now_ms)]
            current=self.apply(ledger,active,lease,current) or current
            now_ms=int(self.clock()*1000)
            if fenced(self.state) or lease_remaining(lease,now_ms)<=0:
                raise ReconcileError('signed policy lease expired')
            if recovering:
                with ledger.db:
                    ledger.db.execute('DELETE FROM meta WHERE key=?',(LEASE_RECOVERY_KEY,))
            store_marker(self.state,{**lease,'pid':current['pid'],'generation':current,
                'checked_ms':now_ms,'boot_id':boot_id(),'checked_boot_ms':boot_ms(),
                'checkpoint':ledger_checkpoint(ledger)})
            if recovering:
                print('MADAR_LEASE_RECOVERY_COMPLETE',flush=True)
            self.publish_usage(ledger,now_ms,current=current,active=active)
        finally:
            ledger.close()

    def loop(self):
        while True:
            try:
                self.tick()
            except Exception as exc:
                journal_safe_error('local',exc)
            time.sleep(1)


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--server')
    parser.add_argument('--node-id')
    parser.add_argument('--key-file')
    parser.add_argument('--state-dir',default=str(DEFAULT_STATE))
    parser.add_argument('--root',default=str(DEFAULT_ROOT))
    mode=parser.add_mutually_exclusive_group()
    mode.add_argument('--watchdog',action='store_true')
    mode.add_argument('--network-once',action='store_true')
    mode.add_argument('--xray-start-check',action='store_true')
    args=parser.parse_args(argv)
    if os.geteuid()!=0:
        raise SystemExit('isolated V2 runtime requires root')
    state=pathlib.Path(args.state_dir)
    phase='local'
    try:
        if args.xray_start_check:
            return 0 if xray_start_allowed(state,int(time.time()*1000),
                                           config_root=pathlib.Path(args.root)) else 1
        if args.watchdog:
            phase='watchdog'
            watchdog(state)
            return 0
        if args.network_once:
            phase='remote'
            key=read_node_secret(args.key_file)
            network_cycle(args.server,args.node_id,key,state)
            return 0
        key=read_node_secret(args.key_file)
        runtime=Runtime(node_id=args.node_id,key=key,state=state,root=args.root)
        with os.fdopen(os.open(state/'runtime.lock',os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600),'w') as lock:
            fcntl.flock(lock.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)
            runtime.loop()
    except Exception as exc:
        journal_safe_error(phase,exc)
        return 1


if __name__=='__main__':
    raise SystemExit(main())
