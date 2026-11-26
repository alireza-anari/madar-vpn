import hashlib
import os
import socket
import tempfile
import unittest
from pathlib import Path

from agent.installer import apply_staging_pair,require_public_dns,ReconcileError,MARKER_TEXT
from agent.xray_config import compile_config,compile_caddy_site

UUID="123e4567-e89b-42d3-a456-426614174000"
WS={"path":"/madar-v2","loopback_port":10443}

def dns(*args,**kwargs):
    return [(socket.AF_INET,socket.SOCK_STREAM,6,"",("203.0.113.100",443))]

# Public test uses a globally routable non-documentation IP (the runner is
# injected and never contacts the network).
PUBLIC_IP="8.8.8.8"
def test_resolver(*args,**kwargs):
    return [(socket.AF_INET,socket.SOCK_STREAM,6,"",(PUBLIC_IP,443))]

class PairTests(unittest.TestCase):
    def setUp(self):
        self.dir=tempfile.TemporaryDirectory()
        self.root=Path(self.dir.name)
        (self.root/"STAGING-ONLY").write_text(MARKER_TEXT)
        os.chmod(self.root/"STAGING-ONLY",0o600)
        self.xray=self.root/"xray-bin"
        self.caddy=self.root/"caddy-bin"
        self.xray.write_bytes(b"fake xray binary")
        self.caddy.write_bytes(b"fake caddy binary")
        os.chmod(self.xray,0o700);os.chmod(self.caddy,0o700)
        self.config=compile_config(clients=[UUID],websocket=WS)
        self.site=compile_caddy_site(domain="vpn.example.com",ws_path="/madar-v2",loopback_port=10443)

    def tearDown(self):self.dir.cleanup()

    def deploy(self,runner,**kw):
        return apply_staging_pair(
            self.root,self.config,self.site,
            xray_binary=self.xray,xray_sha=hashlib.sha256(self.xray.read_bytes()).hexdigest(),
            caddy_binary=self.caddy,caddy_sha=hashlib.sha256(self.caddy.read_bytes()).hexdigest(),
            hostname="vpn.example.com",public_ip=PUBLIC_IP,resolver=test_resolver,runner=runner,**kw)

    def test_preflight_validates_both_then_starts_only_v2_units(self):
        calls=[]
        def run(cmd,timeout):
            calls.append(cmd)
            return True
        outcome=self.deploy(run)
        self.assertFalse(outcome["ready_for_sale"])
        self.assertFalse(outcome["tls_certificate_verified"])
        self.assertTrue((self.root/"config.json").exists())
        self.assertTrue((self.root/"Caddyfile").exists())
        self.assertEqual([c[1] for c in calls[:2]],["run","validate"])
        self.assertEqual(calls[2],["/usr/bin/systemctl","restart","madar-v2-xray.service"])
        self.assertEqual(calls[4],["/usr/bin/systemctl","restart","madar-v2-caddy.service"])
        self.assertNotIn("madar-sales-bot"," ".join(map(str,calls)))

    def test_caddy_rejected_keeps_existing_configs(self):
        (self.root/"config.json").write_text("old Xray")
        (self.root/"Caddyfile").write_text("old Caddy")
        for name in ("config.json","Caddyfile"):os.chmod(self.root/name,0o600)
        calls=[]
        def run(cmd,timeout):
            calls.append(cmd)
            return cmd[1]!="validate"
        with self.assertRaisesRegex(ReconcileError,"Caddy refused"):
            self.deploy(run)
        self.assertEqual((self.root/"config.json").read_text(),"old Xray")
        self.assertEqual((self.root/"Caddyfile").read_text(),"old Caddy")
        self.assertFalse(any("systemctl" in c[0] for c in calls))

    def test_caddy_restart_fails_and_rolls_back_both(self):
        (self.root/"config.json").write_text("old Xray")
        (self.root/"Caddyfile").write_text("old Caddy")
        for name in ("config.json","Caddyfile"):os.chmod(self.root/name,0o600)
        calls=[]
        def run(cmd,timeout):
            calls.append(cmd)
            return not (cmd==["/usr/bin/systemctl","restart","madar-v2-caddy.service"]
                        and calls.count(cmd)==1)
        with self.assertRaisesRegex(ReconcileError,"restart failed"):
            self.deploy(run)
        self.assertEqual((self.root/"config.json").read_text(),"old Xray")
        self.assertEqual((self.root/"Caddyfile").read_text(),"old Caddy")
        self.assertIn(["/usr/bin/systemctl","restart","madar-v2-xray.service"],calls)

    def test_missing_marker_and_bad_dns_fail_before_mutation(self):
        (self.root/"STAGING-ONLY").unlink()
        with self.assertRaisesRegex(ReconcileError,"staging marker"):
            self.deploy(lambda *args,**kwargs:True)
        self.assertFalse((self.root/"config.json").exists())
        with self.assertRaises(ReconcileError):
            require_public_dns("vpn.example.com",PUBLIC_IP,dns)

    def test_public_443_collision_refused(self):
        both=compile_config(clients=[UUID],reality={
            "port":443,"target":"www.example.com","server_name":"www.example.com",
            "private_key":"A"*43,"short_ids":["aabbccdd"]
        },websocket=WS)
        with self.assertRaisesRegex(ReconcileError,"public 443"):
            apply_staging_pair(
                self.root,both,self.site,xray_binary=self.xray,
                xray_sha=hashlib.sha256(self.xray.read_bytes()).hexdigest(),
                caddy_binary=self.caddy,
                caddy_sha=hashlib.sha256(self.caddy.read_bytes()).hexdigest(),
                hostname="vpn.example.com",public_ip=PUBLIC_IP,resolver=test_resolver,
                runner=lambda *args,**kwargs:True)

if __name__=="__main__":unittest.main()
