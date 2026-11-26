import unittest
from agent.xray_config import compile_config,compile_caddy_site

UUID="123e4567-e89b-42d3-a456-426614174000"
VALID_REALITY={
    "port":443,"target":"www.example.com","server_name":"www.example.com",
    "private_key":"A"*43,"short_ids":["0123456789abcdef"],
}
VALID_WS={"path":"/madar-bridge","loopback_port":10443}

class XrayCompilerTests(unittest.TestCase):
    def test_reality_and_ws_binding_isolation(self):
        config=compile_config(clients=[UUID],reality=VALID_REALITY,websocket=VALID_WS)
        reality,websocket=config["inbounds"]
        self.assertEqual(reality["listen"],"0.0.0.0")
        self.assertEqual(reality["streamSettings"]["security"],"reality")
        self.assertEqual(reality["streamSettings"]["network"],"raw")
        self.assertEqual(websocket["listen"],"127.0.0.1")
        self.assertEqual(websocket["streamSettings"]["network"],"ws")
        self.assertEqual(websocket["streamSettings"]["security"],"none")
        self.assertNotIn("method",reality["streamSettings"])
        self.assertNotIn("method",websocket["streamSettings"])
        self.assertEqual(len(websocket["settings"]["users"]),1)

    def test_wss_only_never_exposes_plain_vless_to_internet(self):
        config=compile_config(clients=[UUID],websocket=VALID_WS)
        for ingress in config["inbounds"]:
            self.assertEqual(ingress["listen"],"127.0.0.1")

    def test_no_secret_or_client_is_fatal(self):
        with self.assertRaises(ValueError):
            compile_config(clients=[],reality=VALID_REALITY)
        private={**VALID_REALITY,"private_key":""}
        with self.assertRaises(ValueError):
            compile_config(clients=[UUID],reality=private)

    def test_duplicate_clients_collision_or_invalid_hostname_rejected(self):
        with self.assertRaises(ValueError):
            compile_config(clients=[UUID,UUID],websocket=VALID_WS)
        with self.assertRaises(ValueError):
            compile_config(clients=[UUID],reality=VALID_REALITY,
                           websocket={**VALID_WS,"loopback_port":443})
        with self.assertRaises(ValueError):
            compile_config(clients=[UUID],reality={**VALID_REALITY,
                           "server_name":"bad/host"})
        with self.assertRaises(ValueError):
            compile_config(clients=[UUID],websocket={**VALID_WS,
                           "path":"/\r\nHeader: evasion"})

    def test_caddy_https_proxy_never_accepts_non_absolute_path(self):
        site=compile_caddy_site(domain="vpn.example.com",ws_path="/madar-bridge",
                                loopback_port=10443)
        self.assertIn("reverse_proxy @madar_ws 127.0.0.1:10443",site)
        self.assertNotIn('respond "OK" 200',site)
        self.assertNotIn("0.0.0.0:10443",site)
        with self.assertRaises(ValueError):
            compile_caddy_site(domain="*.example.com",ws_path="/ws",loopback_port=10443)

if __name__=="__main__":unittest.main()
