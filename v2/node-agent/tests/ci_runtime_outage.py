"""Exercise installed, pinned Xray and the real systemd units on hosted CI."""
import json
import os
import pathlib
import signal
import socket
import subprocess
import sys
import time

sys.path.insert(0,'/opt/madar-v2/runtime')
from agent.account_policy import LocalLedger
from agent.manifest import sign
from agent.poller import read_node_secret
from agent.runtime import DEFAULT_ROOT, DEFAULT_STATE, POLICY, ports_listening, publish, read_marker, recovery_ticket, transition_guard
from agent.runtime_install import NETWORK, NETWORK_TIMER, SERVICE, WATCHDOG

NODE='test-ci-native'
XRAY='madar-v2-xray.service'
DROP=pathlib.Path('/etc/systemd/system')/(NETWORK+'.d')
SEED_TOTAL=2493401527


def systemctl(*args,check=True):
    return subprocess.run(['/usr/bin/systemctl',*args],check=check,timeout=30,
                          capture_output=True,text=True)


def eventually(predicate,timeout=15):
    deadline=time.monotonic()+timeout
    while time.monotonic()<deadline:
        value=predicate()
        if value:
            return value
        time.sleep(.25)
    raise AssertionError('timed out waiting for '+predicate.__name__)


def client(sid,uuid,expires,used=0):
    return {'subscription_id':sid,'uuid':uuid,'expires_at':expires,
            'quota_bytes':10**10,'used_bytes':used,'remaining_bytes':10**10-used}


def issue(clients):
    now_ms=int(time.time()*1000)
    now=now_ms//1000
    key=read_node_secret(DEFAULT_ROOT/'node.key')
    payload={'node_id':NODE,'revision':1,'issued_at':now,'expires_at':now+120,
             'mode':'commercial','clients':clients}
    publish(DEFAULT_STATE,POLICY,{'envelope':{'payload':payload,'signature':sign(payload,key),
                                             'applied':False}},now_ms)
    return payload['expires_at']*1000


def installed_ids():
    config=json.loads((DEFAULT_ROOT/'config.json').read_text())
    results=[{r['email'] for r in inbound['settings']['users']} for inbound in config['inbounds'][:2]]
    if len(results)==2 and results[0]==results[1]:
        return results[0]
    raise AssertionError('Xray inbound account sets diverged')


def snapshot():
    ledger=LocalLedger(DEFAULT_STATE/'quota.sqlite')
    try:
        return ledger.get('ci-survivor'),recovery_ticket(ledger)
    finally:
        ledger.close()


def main():
    if (os.geteuid()!=0 or os.getenv('GITHUB_ACTIONS')!='true' or
        os.getenv('RUNNER_ENVIRONMENT')!='github-hosted'):
        raise SystemExit('disposable hosted CI only')
    systemctl('stop',NETWORK_TIMER,NETWORK)
    agent_pid=int(systemctl('show','-p','MainPID','--value',SERVICE).stdout)
    assert agent_pid>1
    try:
        with socket.socket() as server:
            server.bind(('127.0.0.1',0))
            server.listen()
            server.settimeout(10)
            port=server.getsockname()[1]
            DROP.mkdir()
            (DROP/'test-stall.conf').write_text(
                '[Service]\nExecStart=\nExecStart=/usr/bin/python3 -m agent.runtime '
                f'--network-once --server https://127.0.0.1:{port} --node-id {NODE} '
                '--key-file /etc/madar-v2/node.key\n')
            systemctl('daemon-reload')
            systemctl('start','--no-block',NETWORK)
            with server.accept()[0] as conn:
                conn.settimeout(4)
                assert conn.recv(4096)  # The real urllib client is waiting for TLS.
                now=int(time.time()*1000)
                survivor=client('ci-survivor','12345678-1234-4123-8123-123456789011',
                                now+300000,SEED_TOTAL)
                revoked=client('ci-revoked','12345678-1234-4123-8123-123456789012',now+300000)
                expired=client('ci-expired','12345678-1234-4123-8123-123456789013',now+4500)
                lease=issue([survivor,revoked,expired])
                eventually(lambda:read_marker(DEFAULT_STATE) and
                           'phase' not in read_marker(DEFAULT_STATE))
                first=read_marker(DEFAULT_STATE)
                assert installed_ids()=={'v2-ci-survivor','v2-ci-revoked','v2-ci-expired'}
                eventually(lambda:installed_ids()=={'v2-ci-survivor','v2-ci-revoked'},timeout=9)
                eventually(lambda:read_marker(DEFAULT_STATE)['checked_ms']>first['checked_ms'] and
                           'phase' not in read_marker(DEFAULT_STATE))
                assert systemctl('show','-p','ActiveState','--value',NETWORK).stdout.strip()=='activating'
                assert ports_listening()
                assert snapshot()[0]['total']==SEED_TOTAL
                print('Real TLS stall left Xray StatsService, heartbeat and local expiry working',flush=True)
            # Freeze the local controller. The independent timer will observe
            # a stale heartbeat while the signed lease still has time left.
            with transition_guard(DEFAULT_STATE,timeout=5) as acquired:
                assert acquired
                os.kill(agent_pid,signal.SIGSTOP)

            def stopped():
                return read_marker(DEFAULT_STATE).get('phase')=='lease_stopped'

            eventually(stopped,timeout=65)
            row,ticket=snapshot()
            assert ticket['reason']=='watchdog' and ticket['unobserved_tail']=='unknown'
            assert ticket['stopped_ms']<lease and row['total']==SEED_TOTAL
            assert systemctl('is-active','--quiet',XRAY,check=False).returncode!=0
            assert not ports_listening()
            while int(time.time())*1000<ticket['stopped_ms']:
                time.sleep(.1)
            issue([survivor])  # Revocation arrived while Xray was stopped.
            os.kill(agent_pid,signal.SIGCONT)

            def recovered():
                marker=read_marker(DEFAULT_STATE)
                return 'phase' not in marker and marker['pid']!=ticket['generation']['pid']

            eventually(recovered)
            row,pending=snapshot()
            assert pending is None and row['total']==SEED_TOTAL
            assert row['installed']==1 and ports_listening()
            assert installed_ids()=={'v2-ci-survivor'}
            print('Real watchdog stopped Xray before lease expiry and fresh signed policy recovered the checkpoint',flush=True)
    finally:
        os.kill(agent_pid,signal.SIGCONT)
        systemctl('stop',NETWORK,check=False)
        (DROP/'test-stall.conf').unlink(missing_ok=True)
        if DROP.exists():
            DROP.rmdir()
        systemctl('daemon-reload')


if __name__=='__main__':
    main()
