import socket
import unittest
from agent.bootstrap import (
    BootstrapError,plan_node,parse_reality_keypair,xray_unit,caddy_unit,main
)

GOOD_IP="8.8.4.4"
def dns_ok(name,port,**kw):
    return [(socket.AF_INET,socket.SOCK_STREAM,6,"",(GOOD_IP,port))]

class BootstrapTests(unittest.TestCase):
    def test_reality_only_dry_run_does_not_change_server(self):
        plan=plan_node(node_id="test-eu01",public_ip=GOOD_IP)
        self.assertEqual(plan["protocols"],["reality"])
        self.assertEqual(plan["reality_port"],8443)
        self.assertIsNone(plan["wss_domain"])
        self.assertEqual(plan["status"],"planned_not_installed")

    def test_wss_requires_proper_dns_to_origin_and_separate_public_port(self):
        plan=plan_node(node_id="test-eu01",public_ip=GOOD_IP,
                       wss_domain="vpn.example.com",dns_lookup=dns_ok)
        self.assertEqual(plan["protocols"],["reality","wss"])
        self.assertEqual(plan["wss_port"],443)
        self.assertEqual(plan["local_ws_port"],10443)
        with self.assertRaises(BootstrapError):
            plan_node(node_id="test-eu01",public_ip=GOOD_IP,
                      wss_domain="vpn.example.com",dns_lookup=lambda *a,**kw:[
                          (socket.AF_INET,socket.SOCK_STREAM,6,"",("104.16.1.1",443))])

    def test_cannot_enroll_production_or_conflicting_ports(self):
        for name in ("node1","production","prod-node","madar-v2-node1"):
            with self.assertRaises(BootstrapError):
                plan_node(node_id=name,public_ip=GOOD_IP)
        for port in (80,443,10443,65536,0):
            with self.assertRaises(BootstrapError):
                plan_node(node_id="test-new",public_ip=GOOD_IP,reality_port=port)
        for ip in ("127.0.0.1","10.0.0.1","192.168.1.1","fd00::1"):
            with self.assertRaises(BootstrapError):
                plan_node(node_id="test-new",public_ip=ip)

    def test_strict_hostname_and_websocket_path_validation(self):
        with self.assertRaises(BootstrapError):
            plan_node(node_id="test-node",public_ip=GOOD_IP,wss_domain="evil\nhostname",
                      dns_lookup=dns_ok)
        with self.assertRaises(BootstrapError):
            plan_node(node_id="test-node",public_ip=GOOD_IP,wss_domain="vpn.example.com",
                      ws_path="/ws?secret=1",dns_lookup=dns_ok)

    def test_reality_private_key_never_in_stdout_or_unit(self):
        priv="A"*43
        pub="B"*43
        self.assertEqual(parse_reality_keypair("PrivateKey: "+priv+"\nPassword: "+pub),(priv,pub))
        self.assertEqual(parse_reality_keypair("PrivateKey: "+priv+"\nPassword (PublicKey): "+pub+"\nHash32: "+"C"*43),(priv,pub))
        with self.assertRaises(BootstrapError):
            parse_reality_keypair("PrivateKey: "+priv)
        self.assertIn("LoadCredential=config.json:",xray_unit())
        self.assertIn("User=madar-v2-xray",xray_unit())
        self.assertNotIn(priv,xray_unit())

    def test_caddy_https_uses_bounded_ambient_capabilities(self):
        unit=caddy_unit()
        self.assertIn("AmbientCapabilities=CAP_NET_BIND_SERVICE",unit)
        self.assertIn("User=madar-v2-caddy",unit)
        self.assertIn("LoadCredential=Caddyfile:/etc/madar-v2/Caddyfile",unit)
        self.assertIn("--config %d/Caddyfile",unit)
        self.assertIn("ProtectSystem=strict",unit)

    def test_cli_fails_closed_without_test_acknowledgment(self):
        self.assertEqual(main(["--node-id","test-eu01","--public-ip",GOOD_IP]),1)

if __name__=="__main__":
    unittest.main()
