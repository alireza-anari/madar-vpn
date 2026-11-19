import json
import tempfile
import time
import unittest
from pathlib import Path

from agent.account_policy import (
    LocalLedger,compile_dual_account_config,parse_stats,verify_clients
)
from agent.manifest import sign

NODE='test_node01'
UUID='12345678-1234-4123-8123-123456789012'
KEY=b'a'*32
NOW=1800000000


def policy(*,clients=None,mode='commercial',issued=NOW):
    p={'node_id':NODE,'revision':1,'issued_at':issued,'expires_at':issued+120,
       'mode':mode,'clients':[] if clients is None else clients}
    return {'payload':p,'signature':sign(p,KEY),'applied':False}


def client(*,quota=5000,used=0,expiry=(NOW+86400)*1000):
    return {'subscription_id':'sub-one','uuid':UUID,'expires_at':expiry,
            'quota_bytes':quota,'used_bytes':used,'remaining_bytes':quota-used}


class AccountPolicyTests(unittest.TestCase):
    def test_signature_freshness_and_authorized_accounts(self):
        self.assertEqual(verify_clients(policy(clients=[client()]),KEY,NODE,NOW)
                         ['clients'][0]['uuid'],UUID)
        tampered=policy(clients=[client()])
        tampered['payload']['clients'][0]['quota_bytes']=10000000
        with self.assertRaisesRegex(ValueError,'SIGNATURE'):
            verify_clients(tampered,KEY,NODE,NOW)
        with self.assertRaisesRegex(ValueError,'EXPIRED'):
            verify_clients(policy(issued=NOW-180),KEY,NODE,NOW)
        bad=client()
        bad['remaining_bytes']=999
        with self.assertRaises(ValueError):
            verify_clients(policy(clients=[bad]),KEY,NODE,NOW)

    def test_two_ports_same_uuid_and_one_stats_api_on_loopback(self):
        sec={'clients':[UUID],
            'reality':{'port':8443,'target':'www.cloudflare.com',
                'server_name':'www.cloudflare.com','private_key':'a'*43,
                'short_ids':['aabbccdd']},
            'websocket':None}
        x=compile_dual_account_config(sec,[client()])
        self.assertEqual([i['port'] for i in x['inbounds']],[8443,443,10085])
        self.assertEqual([i['listen'] for i in x['inbounds']],
                         ['0.0.0.0','0.0.0.0','127.0.0.1'])
        for inbound in x['inbounds'][:2]:
            self.assertEqual(inbound['settings']['users'][0]['id'],UUID)
            self.assertEqual(inbound['settings']['users'][0]['email'],'v2-sub-one')
        self.assertEqual(x['api']['services'],['StatsService'])
        empty=compile_dual_account_config(sec,[])
        self.assertEqual(empty['inbounds'][0]['settings']['users'],[])
        self.assertEqual(empty['inbounds'][1]['settings']['users'],[])

    def test_strict_stats_match_and_no_ambiguity(self):
        raw=json.dumps({'stat':[{'name':'user>>>v2-sub-one>>>traffic>>>uplink','value':'300'},
                               {'name':'user>>>v2-sub-one>>>traffic>>>downlink','value':400}]})
        self.assertEqual(parse_stats(raw,['sub-one']),{'sub-one':700})
        with self.assertRaisesRegex(ValueError,'DUPLICATE_STATS'):
            parse_stats(json.dumps({'stat':[{'name':'user>>>v2-sub-one>>>traffic>>>uplink','value':1}]*2}),
                        ['sub-one'])

    def test_durable_local_quota_and_restart_continuity(self):
        with tempfile.TemporaryDirectory() as root:
            path=Path(root)/'quota.sqlite'
            l=LocalLedger(path)
            first=client(quota=5000,used=50,expiry=(NOW+120)*1000)
            l.reconcile([first],NOW*1000)
            self.assertEqual(l.get('sub-one')['total'],50)
            l.mark_installed(['sub-one'])
            l.observe({'sub-one':100},NOW*1000)
            self.assertEqual(l.get('sub-one')['total'],150)
            self.assertEqual(l.get('sub-one')['used'],150)
            l.observe({'sub-one':250},NOW*1000)
            self.assertEqual(l.get('sub-one')['total'],300)
            with self.assertRaisesRegex(ValueError,'COUNTER_ROLLBACK'):
                l.observe({'sub-one':1},NOW*1000)
            self.assertEqual(l.get('sub-one')['total'],300)
            l.epoch_reset()
            l.mark_installed(['sub-one'])
            l.observe({'sub-one':500},NOW*1000)
            self.assertEqual(l.get('sub-one')['total'],800)
            l.close()
            l=LocalLedger(path)
            self.assertEqual(l.get('sub-one')['total'],800)
            l.reconcile([client(quota=5000,used=700,expiry=(NOW+86400)*1000)],NOW*1000)
            self.assertEqual(l.get('sub-one')['used'],800)
            self.assertEqual(l.get('sub-one')['expires_ms'],(NOW+86400)*1000)
            l.observe({'sub-one':5000},NOW*1000)
            self.assertEqual(l.active(NOW*1000),[])
            l.close()


if __name__=='__main__':
    unittest.main()
