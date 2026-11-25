import json
import io
import urllib.error
from contextlib import redirect_stdout
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from agent.runtime import read_marker,store_marker,watchdog,Runtime,stats_snapshot,runtime_diagnostic_code,journal_safe_error,boot_id,fenced
from agent.runtime_install import render_runtime_units
from agent.account_policy import LocalLedger
from agent.reconciler import ReconcileError


class RuntimeSafetyTests(unittest.TestCase):
    def test_runtime_error_logging_never_exposes_keys_addresses_or_uuids(self):
        private='https://hidden.invalid/?key=secret-123 user-id'
        self.assertEqual(runtime_diagnostic_code(
            urllib.error.HTTPError(private,403,'private',None,None)),'HTTP_403')
        self.assertEqual(runtime_diagnostic_code(
            ValueError('sensitive UUID=abc123 '+private)),'INVALID_RUNTIME_STATE')
        self.assertEqual(runtime_diagnostic_code(
            RuntimeError('sensitive '+private)),'AGENT_ERROR')
        from agent.reconciler import ReconcileError
        self.assertEqual(runtime_diagnostic_code(
            ReconcileError('unrecognized Xray process generation')),
            'XRAY_GENERATION_MISMATCH')
        captured=io.StringIO()
        with redirect_stdout(captured):
            journal_safe_error('remote',ValueError(private))
            journal_safe_error('local',ReconcileError('unrecognized Xray process generation'))
        output=captured.getvalue()
        self.assertIn('MADAR_RUNTIME_FAULT remote INVALID_RUNTIME_STATE',output)
        self.assertIn('MADAR_RUNTIME_FAULT local XRAY_GENERATION_MISMATCH',output)
        self.assertNotIn(private,output)

    def test_watchdog_only_stops_owned_runtime_after_expired_commercial_heartbeat(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            stopped=[]
            self.assertFalse(watchdog(root,100000,stop=lambda:stopped.append(1)))
            self.assertEqual(stopped,[])
            store_marker(root,{'mode':'commercial','pid':1234,'checked_ms':90000,'policy_until_ms':200000})
            self.assertTrue(watchdog(root,100000,stop=lambda:stopped.append(1)))
            self.assertEqual(stopped,[])
            self.assertFalse(watchdog(root,136000,stop=lambda:stopped.append(1)))
            self.assertEqual(stopped,[1])
            self.assertEqual(read_marker(root)['pid'],1234)
            self.assertTrue(fenced(root))
            self.assertFalse(watchdog(root,137500,stop=lambda:stopped.append(1)))
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            stopped=[]
            store_marker(root,{'mode':'commercial','pid':1234,'checked_ms':137000,'policy_until_ms':138000})
            self.assertTrue(watchdog(root,137500,stop=lambda:stopped.append(1)))
            self.assertFalse(watchdog(root,138000,stop=lambda:stopped.append(1)))
            self.assertEqual(stopped,[1])

    def test_rendered_units_are_isolated_and_include_independent_watchdog(self):
        units=render_runtime_units('test-node01')
        self.assertEqual(len(units),5)
        service=units['madar-v2-runtime.service']
        self.assertIn(' --node-id test-node01 ',service)
        self.assertIn('ExecStart=/usr/bin/python3 -m agent.runtime',service)
        self.assertIn('NoNewPrivileges=yes',service)
        self.assertIn('UMask=0077',service)
        self.assertNotIn('madar-v2-xray.service',service)
        self.assertIn('IPAddressDeny=any',service)
        self.assertIn('IPAddressAllow=localhost',service)
        self.assertIn('--network-once --server',units['madar-v2-runtime-network.service'])
        self.assertIn('TimeoutStartSec=25s',units['madar-v2-runtime-network.service'])
        self.assertNotIn(' --server ',service)
        timer=units['madar-v2-runtime-watchdog.timer']
        self.assertIn('OnUnitActiveSec=15s',timer)
        self.assertNotIn('madar-sales-node',service)
        for invalid in ('node1','prod-01','test node','../etc'):
            with self.assertRaises(Exception):render_runtime_units(invalid)

    def test_prevent_leaking_secrets_or_publishing_raw_stats_service(self):
        units=render_runtime_units('test-safe01')
        text=''.join(units.values())
        self.assertNotIn('NODE_MASTER_KEY',text)
        self.assertNotIn('0.0.0.0:10085',text)
        self.assertNotIn('nodeToken',text)


    def test_sample_rejects_a_process_change_during_stats_read(self):
        with tempfile.TemporaryDirectory() as folder:
            runtime=Runtime.__new__(Runtime)
            runtime.state=Path(folder)
            runtime.runner=Mock()
            ledger=Mock()
            ledger.all.return_value=[{'id':'sub-one','installed':1}]
            gen={'pid':123,'start_us':100,'boot_id':boot_id()}
            old={'mode':'commercial','pid':123,'generation':gen}
            with patch('agent.runtime.live_generation',side_effect=[gen,{**gen,'pid':124}]), \
                 patch('agent.runtime.stats_snapshot',return_value='{"stat":[]}'):
                with self.assertRaisesRegex(ReconcileError,'unrecognized Xray process generation'):
                    runtime.sample(ledger,old,1000)
            ledger.observe.assert_not_called()

    def test_local_tick_removes_exhausted_customer_without_worker_round_trip(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)
            ledger=LocalLedger(path/'quota.sqlite')
            active={'subscription_id':'sub-one',
                'uuid':'12345678-1234-4123-8123-123456789012',
                'expires_at':1800000060000,'quota_bytes':1000,
                'used_bytes':0,'remaining_bytes':1000}
            ledger.reconcile([active],1800000000000)
            ledger.mark_installed(['sub-one'])
            ledger.close()
            store_marker(path,{'mode':'commercial','pid':123,
                'checked_ms':1800000000000,'policy_until_ms':1800000120000})
            runtime=Runtime.__new__(Runtime)
            runtime.state=path
            runtime.clock=lambda:1800000000
            runtime.runner=lambda *args,**kwargs:None
            installed=[]
            def local_sample(x,_old,_now):
                x.observe({'sub-one':1001},1800000000000)
                return {'pid':123,'start_us':100,'boot_id':boot_id()}
            runtime.sample=local_sample
            runtime.apply=lambda _ledger,active,_lease,_current:installed.append(active)
            runtime.tick()
            self.assertEqual(installed,[[]])
            updated=LocalLedger(path/'quota.sqlite')
            self.assertGreaterEqual(updated.get('sub-one')['used'],1000)
            updated.close()
            self.assertEqual(read_marker(path)['checked_ms'],1800000000000)

    def test_local_tick_never_renews_an_expired_signed_policy(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)
            store_marker(path,{'mode':'commercial','pid':123,
                'checked_ms':1800000000000,'policy_until_ms':1800000001000})
            runtime=Runtime.__new__(Runtime)
            runtime.state=path
            runtime.clock=lambda:1800000002
            runtime.runner=Mock()
            with patch('agent.runtime.stop_owned_xray') as stop:
                with self.assertRaisesRegex(ReconcileError,'manual review'):
                    runtime.tick()
                stop.assert_called_once()


if __name__=='__main__':
    unittest.main()
