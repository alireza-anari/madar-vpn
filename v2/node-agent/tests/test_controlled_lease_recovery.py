"""Lease outage regression: real SQLite, signed policy and mocked OS/network."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from agent.account_policy import LocalLedger
from agent.manifest import sign
from agent.reconciler import ReconcileError
from agent.runtime import Runtime, read_marker, store_marker, recovery_ticket, watchdog

NOW=1800000000000
SID='sub-existing'
UUID='12345678-1234-4123-8123-123456789012'
NODE='test-node01'

class ControlledLeaseRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state=Path(self.temp.name)
        self.clock_ms=NOW
        self.client={'subscription_id':SID,'uuid':UUID,
                     'quota_bytes':10000,'used_bytes':1000,'remaining_bytes':9000,
                     'expires_at':NOW+86400000}
        ledger=LocalLedger(self.state/'quota.sqlite')
        ledger.reconcile([self.client],NOW)
        ledger.mark_installed([SID])
        ledger.observe({SID:300},NOW)
        ledger.ack_report(SID,0)
        ledger.close()
        self.old={'mode':'commercial','pid':123,'checked_ms':NOW-1000,
                  'policy_until_ms':NOW+4000}
        store_marker(self.state,self.old)
        self.runtime=Runtime.__new__(Runtime)
        self.runtime.state=self.state
        self.runtime.clock=lambda:self.clock_ms/1000
        self.runtime.node_id=NODE
        self.runtime.key=b'x'*32
        self.runtime.origin='https://example.invalid'
        self.runtime.opener=Mock()
        self.runtime.runner=Mock()
        self.active=True
        self.exit_stamp='100'
        self.events=[]
        self.runtime.call=self.call
        self.runtime.apply=Mock(side_effect=self.apply)
        self.bad_ack=False
        self.fail_usage=False
        self.bad_signature=False
        self.short_lease=False
        self.failed_start=False
        self.runtime.runner.side_effect=self.run_systemctl

    def evidence(self):
        return {'ActiveState':'active' if self.active else 'inactive',
                'MainPID':'123' if self.active else '0',
                'ExecMainPID':'123','ExecMainCode':'1','ExecMainStatus':'0',
                'ExecMainExitTimestampMonotonic':self.exit_stamp}

    def run_systemctl(self,args,**kwargs):
        if args[1]=='stop':
            self.active=False
            self.events.append('stop')
            return Mock(returncode=0)
        raise AssertionError(args)

    def call(self,method,path,payload=None):
        if path=='/api/node/v1/clients':
            sec=self.clock_ms//1000
            policy={'node_id':NODE,'revision':1,'issued_at':sec,
                    'expires_at':sec+(10 if self.short_lease else 120),
                    'mode':'commercial','clients':[self.client]}
            return {'payload':policy,'signature':'wrong' if self.bad_signature else sign(policy,self.runtime.key),'applied':False}
        if path=='/api/node/v1/usage':
            self.events.append('usage')
            if self.fail_usage:
                raise OSError('unavailable')
            result=[{k:r[k] for k in ('subscription_id','sequence','cumulative_bytes')}
                    for r in payload['reports']]
            if self.bad_ack:
                result[0]['cumulative_bytes']-=1
            return {'ok':True,'received':result}
        if path=='/api/node/v1/health':
            self.events.append('health')
            self.assertTrue(self.active)
            self.assertNotIn('phase',read_marker(self.state))
            return {'ok':True}
        if path=='/api/node/v1/clients/ack':
            self.events.append('client_ack')
            return {'ok':True}
        raise AssertionError(path)

    def apply(self,ledger,active):
        self.events.append('apply')
        self.assertEqual(read_marker(self.state)['phase'],'starting')
        self.assertEqual(active,[{'subscription_id':SID,'uuid':UUID}])
        self.assertEqual(ledger.get(SID)['total'],1300)
        self.assertEqual(ledger.get(SID)['counter'],0)
        self.assertEqual(ledger.get(SID)['reported_seq'],1)
        self.active=True
        if self.failed_start:
            raise ReconcileError('startup failure')
        ledger.mark_installed([SID])

    def stop(self):
        with patch('agent.runtime.service_generation',side_effect=lambda *_:self.evidence()):
            self.runtime.local_tick()
        self.assertFalse(self.active)
        self.assertEqual(read_marker(self.state)['phase'],'lease_stopped')
        self.clock_ms+=300000

    def once(self):
        with patch('agent.runtime.poll_once'), \
             patch('agent.runtime.service_generation',side_effect=lambda *_:self.evidence()), \
             patch('agent.runtime.xray_pid',return_value=456), \
             patch('agent.runtime.stop_owned_xray',side_effect=lambda:self.run_systemctl(['systemctl','stop'])):
            return self.runtime.once()

    def snapshot(self):
        ledger=LocalLedger(self.state/'quota.sqlite')
        try:
            return ledger.get(SID),recovery_ticket(ledger)
        finally:
            ledger.close()

    def test_expired_lease_recovery_preserves_usage_and_reports_before_start(self):
        self.stop()
        row,ticket=self.snapshot()
        self.assertEqual((row['total'],row['counter'],row['sequence'],row['reported_seq']),(1300,300,1,0))
        self.assertEqual(ticket['unobserved_tail'],'unknown')
        self.assertEqual(self.once(),{'mode':'commercial','active':1})
        row,ticket=self.snapshot()
        self.assertEqual((row['total'],row['used'],row['counter'],row['sequence'],row['reported_seq'],row['installed']),(1300,1300,0,1,1,1))
        self.assertIsNone(ticket)
        self.assertEqual(read_marker(self.state)['pid'],456)
        self.assertEqual(self.events,['stop','usage','apply','health','client_ack'])
        ledger=LocalLedger(self.state/'quota.sqlite')
        try:
            ledger.observe({SID:75},self.clock_ms)
            self.assertEqual(ledger.get(SID)['total'],1375)
            self.assertEqual(ledger.get(SID)['sequence'],2)
            self.assertEqual(ledger.db.execute("SELECT COUNT(*) FROM meta WHERE key LIKE 'controlled_lease_gap_%'").fetchone()[0],1)
        finally:
            ledger.close()

    def test_unexpected_stop_is_not_recovery_authorization(self):
        self.active=False
        with patch('agent.runtime.service_generation',side_effect=lambda *_:self.evidence()), \
             patch('agent.runtime.stop_owned_xray'):
            with self.assertRaisesRegex(ReconcileError,'signed policy lease expired'):
                self.runtime.local_tick()
        self.assertIsNone(self.snapshot()[1])
        self.clock_ms+=300000
        with patch('agent.runtime.poll_once'),patch('agent.runtime.xray_pid',side_effect=ReconcileError('Xray not active')):
            with self.assertRaisesRegex(ReconcileError,'Xray not active'):
                self.runtime.once()
        self.runtime.apply.assert_not_called()
        self.assertEqual(self.snapshot()[0]['counter'],300)

    def test_changed_exit_evidence_blocks_recovery(self):
        self.stop()
        self.exit_stamp='101'
        with self.assertRaisesRegex(ReconcileError,'manual review'):
            self.once()
        self.runtime.apply.assert_not_called()
        self.assertEqual(self.snapshot()[0]['counter'],300)

    def test_invalid_signed_policy_cannot_restart(self):
        self.stop()
        self.bad_signature=True
        with self.assertRaisesRegex(ValueError,'BAD_POLICY_SIGNATURE'):
            self.once()
        self.runtime.apply.assert_not_called()
        self.assertEqual(self.snapshot()[0]['counter'],300)

    def test_usage_failure_keeps_ticket_and_retry_succeeds(self):
        self.stop()
        self.fail_usage=True
        with self.assertRaises(OSError):
            self.once()
        self.runtime.apply.assert_not_called()
        self.assertEqual(self.snapshot()[1]['phase'],'stopped')
        self.fail_usage=False
        self.assertEqual(self.once()['active'],1)

    def test_wrong_usage_ack_does_not_consume_ticket(self):
        self.stop()
        self.bad_ack=True
        with self.assertRaisesRegex(ReconcileError,'usage ACK stale'):
            self.once()
        self.assertEqual(self.snapshot()[0]['reported_seq'],0)
        self.runtime.apply.assert_not_called()

    def test_short_lease_does_not_consume_ticket(self):
        self.stop()
        self.short_lease=True
        with self.assertRaisesRegex(ReconcileError,'fresh policy'):
            self.once()
        self.assertEqual(self.snapshot()[1]['phase'],'stopped')
        self.runtime.apply.assert_not_called()

    def test_interrupted_start_never_reuses_ticket(self):
        self.stop()
        self.failed_start=True
        with self.assertRaisesRegex(ReconcileError,'startup failure'):
            self.once()
        self.assertFalse(self.active)
        self.assertEqual(self.snapshot()[1]['phase'],'starting')
        with self.assertRaisesRegex(ReconcileError,'manual review'):
            self.once()
        self.assertEqual(self.runtime.apply.call_count,1)
        self.assertNotIn('health',self.events)

    def test_watchdog_still_stops_stale_starting_generation(self):
        self.stop()
        store_marker(self.state,{'mode':'commercial','phase':'starting','pid':0,
                    'checked_ms':NOW,'policy_until_ms':NOW+120000})
        stop=Mock()
        self.assertTrue(watchdog(self.state,NOW+1000,stop=stop))
        self.assertFalse(watchdog(self.state,NOW+46000,stop=stop))
        stop.assert_called_once()

if __name__=='__main__':
    unittest.main()
