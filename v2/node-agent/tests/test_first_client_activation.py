"""Regression: a newly issued V2 account must reach real Xray/ACK handoff.

These tests mock only the operating-system and network boundaries. They keep
the actual SQLite LocalLedger, pending-client reconciliation, configuration
compiler and outbound ACK payload construction.
"""
import hashlib
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from agent.account_policy import LocalLedger, compile_dual_account_config
from agent.runtime import Runtime, read_marker


NOW_SECONDS=1800000000
NOW_MS=NOW_SECONDS*1000
SUB_ID='sub-new-order'
CLIENT_UUID='12345678-1234-4123-8123-123456789012'
NODE_ID='test-node01'
LOCAL_SECRETS={
    'clients':[CLIENT_UUID],
    'reality':{
        'port':8443,'target':'www.cloudflare.com',
        'server_name':'www.cloudflare.com',
        'private_key':'a'*43,'short_ids':['aabbccdd'],
    },
    'websocket':None,
}


class FirstClientActivationTests(unittest.TestCase):
    def test_pending_first_client_is_compiled_for_both_ports_and_reaches_signed_ack(self):
        with tempfile.TemporaryDirectory() as directory:
            state=Path(directory)
            runtime=Runtime.__new__(Runtime)
            runtime.state=state
            runtime.clock=lambda:NOW_SECONDS
            runtime.node_id=NODE_ID
            runtime.key=b'a'*32
            runtime.origin='https://staging.invalid'
            runtime.opener=Mock()
            runtime.runner=Mock()
            client={
                'subscription_id':SUB_ID,
                'uuid':CLIENT_UUID,
                'expires_at':NOW_MS+120000,
                'quota_bytes':20*1024**3,
                'used_bytes':0,
                'remaining_bytes':20*1024**3,
            }
            policy={'revision':1,'expires_at':NOW_SECONDS+120,'mode':'commercial',
                    'clients':[client]}
            events=[]
            def fake_apply(ledger,active):
                # Uses the REAL account compiler: this raised KeyError before
                # the fix because SQLite rows have "id", not "subscription_id".
                config=compile_dual_account_config(LOCAL_SECRETS,active)
                for inbound in config['inbounds'][:2]:
                    self.assertEqual(inbound['settings']['users'][0]['id'],CLIENT_UUID)
                    self.assertEqual(inbound['settings']['users'][0]['email'],'v2-'+SUB_ID)
                self.assertEqual([x['port'] for x in config['inbounds'][:2]],
                                 [8443,443])
                ledger.mark_installed([x['subscription_id'] for x in active])
                events.append('xray-installed')
            def fake_call(method,path,payload=None):
                if path=='/api/node/v1/clients':
                    events.append('policy')
                    return {'unused':'verified by mocked policy boundary'}
                if path=='/api/node/v1/health':
                    self.assertEqual(payload['ports'],[443,8443])
                    events.append('healthy')
                    return {'ok':True}
                if path=='/api/node/v1/clients/ack':
                    self.assertEqual(len(payload['clients']),1)
                    self.assertEqual(payload['clients'][0],{
                        'subscription_id':SUB_ID,
                        'uuid_sha256':hashlib.sha256(CLIENT_UUID.encode('ascii')).hexdigest(),
                    })
                    self.assertEqual(payload['ports'],[443,8443])
                    events.append('client-ack')
                    return {'ok':True,'applied':1}
                raise AssertionError('Unexpected outbound control plane path '+path)
            runtime.apply=fake_apply
            runtime.call=fake_call
            with patch('agent.runtime.poll_once') as poll, \
                 patch('agent.runtime.verify_clients',return_value=policy), \
                 patch('agent.runtime.xray_pid',return_value=1234):
                result=runtime.once()
            poll.assert_called_once()
            self.assertEqual(result,{'mode':'commercial','active':1})
            self.assertEqual(events,['policy','xray-installed','healthy','client-ack'])
            self.assertEqual(read_marker(state)['mode'],'commercial')
            ledger=LocalLedger(state/'quota.sqlite')
            stored=ledger.get(SUB_ID)
            self.assertEqual(stored['id'],SUB_ID)
            self.assertEqual(stored['uuid'],CLIENT_UUID)
            self.assertEqual(stored['installed'],1)
            self.assertEqual(stored['total'],0)
            ledger.close()

    def test_real_sqlite_active_rows_have_id_not_subscription_id(self):
        with tempfile.TemporaryDirectory() as directory:
            ledger=LocalLedger(Path(directory)/'quota.sqlite')
            ledger.reconcile([{
                'subscription_id':SUB_ID,'uuid':CLIENT_UUID,
                'expires_at':NOW_MS+120000,'quota_bytes':1000,
                'used_bytes':0,'remaining_bytes':1000,
            }],NOW_MS)
            rows=ledger.active(NOW_MS)
            self.assertEqual(len(rows),1)
            self.assertIn('id',rows[0])
            self.assertNotIn('subscription_id',rows[0])
            ledger.close()


if __name__=='__main__':
    unittest.main()
