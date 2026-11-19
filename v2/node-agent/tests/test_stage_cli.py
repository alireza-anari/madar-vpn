import json
import os
import tempfile
import unittest
from pathlib import Path

from agent.stage_cli import read_local_spec
from agent.reconciler import ReconcileError

UUID="123e4567-e89b-42d3-a456-426614174000"
SPEC={"clients":[UUID],"reality":{
    "port":8443,"target":"www.example.com","server_name":"www.example.com",
    "private_key":"A"*43,"short_ids":["abcdef0123456789"]},
    "websocket":{"path":"/madar-v2","loopback_port":10443},
    "wss_hostname":"vpn.example.com"}

class CLIValidationTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.p=Path(self.temp.name)/"local-secrets.json"
        self.p.write_text(json.dumps(SPEC))
        os.chmod(self.p,0o600)

    def tearDown(self):self.temp.cleanup()

    def test_configures_both_routes_from_local_secrets_only(self):
        xray,site=read_local_spec(self.p)
        self.assertEqual(len(xray["inbounds"]),2)
        self.assertEqual(xray["inbounds"][0]["port"],8443)
        self.assertEqual(xray["inbounds"][1]["listen"],"127.0.0.1")
        self.assertIn("vpn.example.com",site)
        self.assertNotIn("A"*43,site)

    def test_world_readable_credentials_are_never_used(self):
        os.chmod(self.p,0o644)
        with self.assertRaisesRegex(ReconcileError,"mode-0600"):
            read_local_spec(self.p)

    def test_symlink_and_unexpected_fields_fail_closed(self):
        alias=self.p.parent/"link.json"
        alias.symlink_to(self.p)
        with self.assertRaisesRegex(ReconcileError,"mode-0600"):
            read_local_spec(alias)
        self.p.write_text(json.dumps({**SPEC,"command":"curl | sh"}))
        with self.assertRaisesRegex(ReconcileError,"unknown"):
            read_local_spec(self.p)

    def test_no_plain_ws_to_public_interface(self):
        data={**SPEC,"websocket":{"path":"evil\\r\\n","loopback_port":10443}}
        self.p.write_text(json.dumps(data))
        with self.assertRaises(ValueError):
            read_local_spec(self.p)

if __name__=="__main__":unittest.main()
