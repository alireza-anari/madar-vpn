import hashlib
import os
import tempfile
import unittest
from pathlib import Path

from agent.reconciler import apply_config,verify_xray_binary,ReconcileError
from agent.xray_config import compile_config

UUID="123e4567-e89b-42d3-a456-426614174000"
REALITY={"port":443,"target":"www.example.com","server_name":"www.example.com",
         "private_key":"A"*43,"short_ids":["abcdef0123456789"]}

class ReconcilerTests(unittest.TestCase):
    def setUp(self):
        self.root=tempfile.TemporaryDirectory()
        self.path=Path(self.root.name)
        self.binary=self.path/"xray"
        self.binary.write_bytes(b"PINNED_TEST_STUB_DO_NOT_EXECUTE")
        os.chmod(self.binary,0o700)
        self.sha=hashlib.sha256(self.binary.read_bytes()).hexdigest()
        self.config=compile_config(clients=[UUID],reality=REALITY)

    def tearDown(self):self.root.cleanup()

    def test_rejects_unpinned_binary(self):
        with self.assertRaises(ReconcileError):
            verify_xray_binary(self.binary,"a"*64)
        with self.assertRaises(ReconcileError):
            verify_xray_binary(self.path/"missing","a"*64)

    def test_validate_before_restart(self):
        calls=[]
        def runner(args,timeout):
            calls.append(args)
            return True
        result=apply_config(self.path,self.config,binary=self.binary,sha256=self.sha,runner=runner)
        self.assertFalse(result["field_verified"])
        self.assertEqual(result["status"],"service_configured")
        self.assertTrue((self.path/"config.json").exists())
        self.assertEqual(len(calls),3)
        self.assertEqual(calls[0][1:4],["run","-test","-config"])
        self.assertEqual(calls[1],["/usr/bin/systemctl","restart","madar-v2-xray.service"])

    def test_stats_api_inbound_without_users_does_not_fake_client_count(self):
        # Commercial config has two VLESS listeners and a loopback stats API.
        # The latter has settings.address, not settings.users.
        from agent.account_policy import compile_dual_account_config
        config=compile_dual_account_config({
            'clients':[UUID],
            'reality':{
                'port':8443,'target':'www.example.com','server_name':'www.example.com',
                'private_key':'A'*43,'short_ids':['abcdef0123456789']
            },
            'websocket':None
        },[{'subscription_id':'sub-one','uuid':UUID}])
        self.assertEqual(config['inbounds'][2]['protocol'],'dokodemo-door')
        self.assertNotIn('users',config['inbounds'][2]['settings'])
        result=apply_config(self.path,config,binary=self.binary,sha256=self.sha,
                            runner=lambda *_args,**_kw:True)
        self.assertEqual(result['status'],'service_configured')
        # Two ports share a single customer UUID. Count installed VLESS entries.
        self.assertEqual(result['client_count'],2)

    def test_config_validation_failure_does_not_touch_existing(self):
        current=self.path/"config.json"
        current.write_text("PREVIOUS")
        os.chmod(current,0o600)
        def fail(args,timeout):return False
        with self.assertRaises(ReconcileError):
            apply_config(self.path,self.config,binary=self.binary,sha256=self.sha,runner=fail)
        self.assertEqual(current.read_text(),"PREVIOUS")

    def test_failed_restart_restores_previous_config(self):
        current=self.path/"config.json"
        current.write_text("PREVIOUS")
        os.chmod(current,0o600)
        def runner(args,timeout):
            if args[:2]==["/usr/bin/systemctl","restart"] and "previous.json" in self.path.name:
                return False
            # first config syntax okay; all service restarts fail
            if args[:2]==["/usr/bin/systemctl","restart"]:return False
            return True
        with self.assertRaises(ReconcileError):
            apply_config(self.path,self.config,binary=self.binary,sha256=self.sha,runner=runner)
        self.assertEqual(current.read_text(),"PREVIOUS")

    def test_symlink_root_or_previous_config_rejected(self):
        link=self.path/"external"
        link.symlink_to(self.path,target_is_directory=True)
        with self.assertRaises(ReconcileError):
            apply_config(link,self.config,binary=self.binary,sha256=self.sha,runner=lambda *_:True)
        (self.path/"config.json").symlink_to(self.binary)
        with self.assertRaises(ReconcileError):
            apply_config(self.path,self.config,binary=self.binary,sha256=self.sha,runner=lambda *_:True)

if __name__=="__main__":unittest.main()
