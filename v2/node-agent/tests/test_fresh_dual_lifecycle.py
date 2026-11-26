import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from agent import fresh_dual as fresh, dual_reality as dual
from agent.bootstrap import xray_unit
from agent.xray_config import compile_config, encode
from agent.reconciler import ReconcileError


class FreshDualLifecycleTests(unittest.TestCase):
    def setUp(self):
        temporary=tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root=Path(temporary.name)
        units=self.root/'units'
        units.mkdir()
        drop=units/(dual.XUNIT+'.d')
        (units/dual.XUNIT).write_text(xray_unit())
        self.original=encode(compile_config(
            clients=['123e4567-e89b-42d3-a456-426614174000'],
            reality=dict(port=8443,target='www.cloudflare.com',server_name='www.cloudflare.com',
                         private_key='A'*43,short_ids=['abcdef0123456789'])))
        (self.root/'config.json').write_text(self.original)
        (self.root/'public-route-metadata.json').write_text(json.dumps(
            dict(node_id='test-ci-native',public_ip='8.8.4.4')))
        # Privilege/binary ownership is separately covered by ephemeral CI.
        # Keep real atomic file moves and real capability drop-in lifecycle.
        for module in (fresh,dual):
            for key,value in dict(UNITS=units,DROP=drop,owned=lambda p,*a:p.read_text()).items():
                context=patch.object(module,key,value);context.start();self.addCleanup(context.stop)
        for key,value in dict(_safe_config_root=lambda p:p,require_staging_marker=lambda p:None,
                              verify_xray_binary=lambda *a:None).items():
            context=patch.object(fresh,key,value);context.start();self.addCleanup(context.stop)
        context=patch.object(dual,'DROP_FILE',drop/'20-madar-test-reality-443.conf')
        context.start();self.addCleanup(context.stop)
        context=patch.object(fresh.os,'geteuid',return_value=0)
        context.start();self.addCleanup(context.stop)

    def test_delayed_listeners_do_not_trigger_spurious_rollback(self):
        attempts={443:0,8443:0}
        def probe(port):
            attempts[port]+=1
            return attempts[port]>2
        result=fresh.enable('test-ci-native','8.8.4.4',root=self.root,
                            runner=lambda *a,**k:True,probe=probe)
        self.assertFalse(result['ready_for_sale'])
        self.assertEqual([x['port'] for x in json.loads((self.root/'config.json').read_text())['inbounds']], [8443,443])

    def test_restart_failure_restores_config_and_removes_owned_dropin(self):
        restarts=0
        def runner(args,**kwargs):
            nonlocal restarts
            if 'restart' in args:
                restarts+=1
                return restarts>1
            return True
        with self.assertRaisesRegex(ReconcileError,'original restored'):
            fresh.enable('test-ci-native','8.8.4.4',root=self.root,runner=runner,probe=lambda p:True)
        self.assertEqual((self.root/'config.json').read_text(),self.original)
        self.assertFalse((self.root/dual.BACKUP).exists())
        self.assertFalse(fresh.DROP.exists())

    def test_unrecovered_listener_fails_closed_and_retains_backup(self):
        calls=0
        def probe(port):
            nonlocal calls
            calls+=1
            return calls==1
        with patch.object(fresh.time,'sleep'), self.assertRaisesRegex(ReconcileError,'rollback incomplete'):
            fresh.enable('test-ci-native','8.8.4.4',root=self.root,
                         runner=lambda *a,**k:True,probe=probe)
        self.assertEqual((self.root/dual.BACKUP).read_text(),self.original)
        self.assertEqual((self.root/'config.json').read_text(),self.original)
        self.assertLessEqual(calls,101)
