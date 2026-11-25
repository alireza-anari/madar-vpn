"""Exercise the runtime and watchdog entry points against a durable ledger."""
import json
import socket
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from agent.account_policy import LocalLedger
from agent.installer import MARKER_TEXT
from agent.manifest import sign
from agent.reconciler import ReconcileError
from agent.runtime import (
    OUTBOX, POLICY, Runtime, boot_id, fenced, ledger_checkpoint, network_cycle,
    publish, read_document, read_marker, recovery_ticket, store_marker,
    transition_guard, watchdog, xray_start_allowed,
)


NOW=1800000000000
SID='sub-existing'
UUID='12345678-1234-4123-8123-123456789012'
NODE='test-node01'
KEY=b'x'*32


class ControlledLeaseRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state=Path(self.temp.name)
        (self.state/'STAGING-ONLY').write_text(MARKER_TEXT)
        (self.state/'STAGING-ONLY').chmod(0o600)
        self.now=NOW
        self.client={'subscription_id':SID,'uuid':UUID,'quota_bytes':10000,
                     'used_bytes':1000,'remaining_bytes':9000,'expires_at':NOW+86400000}
        self.use=XrayDouble()
        self.runtime=self.new_runtime()
        ledger=LocalLedger(self.state/'quota.sqlite')
        try:
            ledger.reconcile([self.client],NOW)
            ledger.mark_installed([SID])
            ledger.observe({SID:300},NOW)
            self.old={'mode':'commercial','pid':self.use.pid,'checked_ms':NOW-1000,
                      'policy_until_ms':NOW+120000,'revision':1,
                      'generation':self.use.generation(),'checkpoint':ledger_checkpoint(ledger)}
        finally:
            ledger.close()
        store_marker(self.state,self.old)
        self.stats=Mock(return_value=self.stats_for(300))
        patcher=patch('agent.runtime.stats_snapshot',self.stats)
        patcher.start()
        self.addCleanup(patcher.stop)

    def stats_for(self,value):
        return json.dumps({'stat':[{'name':f'user>>>v2-{SID}>>>traffic>>>uplink','value':value}]})

    def new_runtime(self):
        runtime=Runtime(node_id=NODE,key=KEY,state=self.state,root=self.state,
                        clock=lambda:self.now/1000,runner=self.use.systemctl)
        def apply(ledger,active,lease,current):
            self.use.installed=[row['subscription_id'] for row in active]
            if current:
                return current
            store_marker(self.state,{**lease,'phase':'starting','checked_ms':self.now,
                                     'boot_id':boot_id(),'pid':0})
            self.use.start()
            if self.use.interrupt:
                raise SystemExit('crashed during start')
            ledger.epoch_reset()
            ledger.mark_installed(self.use.installed)
            return self.use.generation()
        runtime.apply=Mock(side_effect=apply)
        return runtime

    def signed_policy(self,*,clients=None,issued=None,duration=120,bad=False):
        second=self.now//1000 if issued is None else issued
        payload={'node_id':NODE,'revision':1,'issued_at':second,'expires_at':second+duration,
                 'mode':'commercial','clients':[self.client] if clients is None else clients}
        return {'payload':payload,'signature':'invalid' if bad else sign(payload,KEY),'applied':False}

    def policy(self,**kwargs):
        publish(self.state,POLICY,{'envelope':self.signed_policy(**kwargs)},self.now)

    def local_stop(self):
        self.now+=111000
        self.runtime.tick()
        self.assertFalse(self.use.active)
        self.assertEqual(read_marker(self.state)['phase'],'lease_stopped')

    def watchdog(self):
        return watchdog(self.state,self.now,stop=self.runtime.stop,runner=self.use.systemctl,
                        clock=lambda:self.now/1000)

    def snapshot(self):
        ledger=LocalLedger(self.state/'quota.sqlite')
        try:
            return ledger.get(SID),recovery_ticket(ledger)
        finally:
            ledger.close()

    def test_watchdog_first_then_fresh_signed_lease_restores_monotonic_accounting(self):
        self.now+=47000
        self.assertLess(self.now,self.old['policy_until_ms'])
        self.assertFalse(self.watchdog())
        self.assertFalse(self.use.active)
        row,ticket=self.snapshot()
        self.assertEqual((row['total'],row['counter'],row['sequence']),(1300,300,1))
        self.assertEqual(ticket['unobserved_tail'],'unknown')
        self.assertEqual(ticket['reason'],'watchdog')
        self.assertEqual(ticket['generation'],self.old['generation'])
        self.assertFalse(xray_start_allowed(self.state,self.now))
        self.policy(issued=NOW//1000+45)
        self.runtime.tick()
        self.assertFalse(self.use.active)
        self.now+=1000
        self.policy()
        self.runtime.tick()
        row,ticket=self.snapshot()
        self.assertEqual((row['total'],row['counter'],row['sequence']),(1300,0,1))
        self.assertIsNone(ticket)
        self.assertNotEqual(read_marker(self.state)['pid'],self.old['pid'])
        self.stats.return_value=self.stats_for(75)
        self.now+=1000
        self.runtime.tick()
        row,_=self.snapshot()
        self.assertEqual((row['total'],row['sequence']),(1375,2))
        out=read_document(self.state,OUTBOX)
        self.assertEqual(out['usage'],[{'subscription_id':SID,'sequence':2,'cumulative_bytes':1375}])

    def test_expired_and_revoked_accounts_are_removed_before_recovery_start(self):
        self.local_stop()
        expired={**self.client,'expires_at':self.now-1}
        self.now+=1000
        self.policy(clients=[expired])
        self.runtime.tick()
        self.assertTrue(self.use.active)
        self.assertEqual(self.use.installed,[])
        self.assertEqual(self.snapshot()[0]['installed'],0)
        self.assertEqual(self.snapshot()[0]['total'],1300)
        self.now+=46000
        self.assertFalse(self.watchdog())
        self.now+=1000
        self.policy(clients=[])
        self.runtime.tick()
        self.assertTrue(self.use.active)
        self.assertEqual(self.use.installed,[])
        self.assertEqual(self.snapshot()[0]['present'],0)
        self.assertEqual(self.snapshot()[0]['total'],1300)

    def test_unexpected_stop_does_not_issue_ticket(self):
        self.use.active=False
        self.now+=48000
        self.assertFalse(self.watchdog())
        self.assertIsNone(self.snapshot()[1])
        self.assertTrue(fenced(self.state))
        self.now+=1000
        self.policy()
        self.runtime.tick()
        self.runtime.apply.assert_not_called()

    def test_changed_exit_evidence_blocks_recovery(self):
        self.local_stop()
        self.use.exit_us+=1
        self.now+=1000
        self.policy()
        with self.assertRaisesRegex(ReconcileError,'manual review'):
            self.runtime.tick()
        self.runtime.apply.assert_not_called()
        self.assertTrue(fenced(self.state))
        self.assertEqual(self.snapshot()[0]['counter'],300)

    def test_invalid_signed_policy_while_serving_stops_and_fences(self):
        self.policy(bad=True)
        with self.assertRaisesRegex(ValueError,'BAD_POLICY_SIGNATURE'):
            self.runtime.tick()
        self.assertFalse(self.use.active)
        self.assertTrue(fenced(self.state))
        self.assertIsNone(self.snapshot()[1])

    def test_short_or_unsigned_recovery_policy_cannot_consume_ticket(self):
        self.local_stop()
        self.now+=1000
        self.policy(bad=True)
        self.runtime.tick()
        self.now+=300000
        self.policy(duration=10)
        self.runtime.tick()
        self.runtime.apply.assert_not_called()
        self.assertEqual(self.snapshot()[1]['phase'],'stopped')
        self.assertFalse(fenced(self.state))
        self.assertEqual(self.snapshot()[0]['counter'],300)

    def test_interrupted_start_is_fenced_on_next_runtime_invocation(self):
        self.local_stop()
        self.now+=1000
        self.policy()
        self.use.interrupt=True
        with self.assertRaises(SystemExit):
            self.runtime.tick()
        self.assertEqual(self.snapshot()[1]['phase'],'starting')
        self.assertTrue(self.use.active)
        restarted=self.new_runtime()
        with self.assertRaisesRegex(ReconcileError,'manual review'):
            restarted.tick()
        self.assertTrue(fenced(self.state))
        self.assertFalse(self.use.active)
        self.assertEqual(self.snapshot()[0]['total'],1300)
        restarted.apply.assert_not_called()

    def test_contended_watchdog_fences_stale_generation_and_returns(self):
        self.now+=48000
        with transition_guard(self.state) as acquired:
            self.assertTrue(acquired)
            started=time.monotonic()
            self.assertFalse(self.watchdog())
            self.assertLess(time.monotonic()-started,2)
        self.assertFalse(self.use.active)
        self.assertTrue(fenced(self.state))
        self.assertIsNone(self.snapshot()[1])

    def test_network_tls_handshake_stall_does_not_block_local_usage_or_expiry(self):
        with socket.socket() as server:
            server.bind(('127.0.0.1',0))
            server.listen()
            origin='https://127.0.0.1:'+str(server.getsockname()[1])
            finished=threading.Event()
            stalled=threading.Event()

            def worker():
                try:
                    network_cycle(origin,NODE,KEY,self.state)
                except OSError:
                    stalled.set()
                finally:
                    finished.set()

            exchange=threading.Thread(target=worker,daemon=True)
            exchange.start()
            server.settimeout(4)
            with server.accept()[0] as conn:
                conn.settimeout(4)
                self.assertTrue(conn.recv(4096))  # Real TLS ClientHello, no ServerHello.
                self.stats.return_value=self.stats_for(415)
                self.client['expires_at']=self.now+1000
                self.policy()
                self.runtime.tick()
                self.now+=2000
                self.runtime.tick()
                self.assertFalse(finished.is_set())
                self.assertEqual(self.snapshot()[0]['total'],1415)
                self.assertEqual(self.use.installed,[])
            self.assertTrue(stalled.wait(4))
            exchange.join(4)


class XrayDouble:
    def __init__(self):
        self.pid=123
        self.start_us=time.monotonic_ns()//1000-5_000_000
        self.active=True
        self.exit_us=0
        self.installed=[]
        self.interrupt=False

    def generation(self):
        return {'pid':self.pid,'start_us':self.start_us,'boot_id':boot_id()}

    def start(self):
        self.pid+=1
        self.start_us=time.monotonic_ns()//1000
        self.active=True

    def systemctl(self,args,**kwargs):
        if args[1]=='stop':
            if self.active:
                self.exit_us=time.monotonic_ns()//1000+1
            self.active=False
            return Mock(returncode=0)
        if args[1]=='show':
            evidence={'ActiveState':'active' if self.active else 'inactive',
                      'MainPID':self.pid if self.active else 0,'ExecMainPID':self.pid,
                      'ExecMainCode':1,'ExecMainStatus':0,'Result':'success',
                      'ExecMainStartTimestampMonotonic':self.start_us,
                      'ExecMainExitTimestampMonotonic':self.exit_us}
            return Mock(stdout='\n'.join(f'{k}={v}' for k,v in evidence.items()))
        raise AssertionError(args)


if __name__=='__main__':
    unittest.main()
