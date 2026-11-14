import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path

from agent.tunnel_probe import (
    diagnostic_client_config,load_test_metadata,
    execute_probe,EXPECTED_XRAY_SHA256
)
from agent.reconciler import ReconcileError
from agent.installer import MARKER_TEXT

UID="123e4567-e89b-42d3-a456-426614174000"
PUBLIC={"wss_domain":"86-54-42-66.sslip.io","wss_path":"/madar-ws",
        "reality_port":8443,"reality_server_name":"www.cloudflare.com",
        "reality_public_key":"B"*43,"short_id":"abcdef0123456789"}

class ReadOnlyTunnelProbeTests(unittest.TestCase):
    def test_expected_binary_matches_first_staging_bootstrap(self):
        self.assertEqual(EXPECTED_XRAY_SHA256,
                         "e87bce586acdb9136aa5b1f1d9c8db9f1ea1d145b6d86368c7f6f662f9f6a66d")

    def test_correct_vless_outbound_and_local_only_socks(self):
        for transport in ("wss","reality"):
            cfg=diagnostic_client_config(UID,PUBLIC,transport,21080)
            self.assertEqual(cfg["inbounds"][0]["listen"],"127.0.0.1")
            vnext=cfg["outbounds"][0]["settings"]["vnext"]
            self.assertEqual(vnext[0]["address"],"127.0.0.1")
            self.assertEqual(vnext[0]["users"][0]["id"],UID)
            self.assertEqual(vnext[0]["users"][0]["encryption"],"none")
            stream=cfg["outbounds"][0]["streamSettings"]
            if transport=="wss":
                self.assertEqual(stream["security"],"tls")
                self.assertFalse(stream["tlsSettings"]["allowInsecure"])
                self.assertEqual(stream["wsSettings"]["headers"]["Host"],PUBLIC["wss_domain"])
                self.assertNotIn("flow",vnext[0]["users"][0])
            else:
                self.assertEqual(stream["security"],"reality")
                self.assertEqual(vnext[0]["users"][0]["flow"],"xtls-rprx-vision")

    def test_metadata_must_be_local_and_mode_0600(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            (root/"STAGING-ONLY").write_text(MARKER_TEXT)
            os.chmod(root/"STAGING-ONLY",0o600)
            (root/"local-secrets.json").write_text(json.dumps({
                "clients":[UID],"reality":{},"websocket":{"path":"/madar-ws"},
                "wss_hostname":PUBLIC["wss_domain"],
            }))
            (root/"public-route-metadata.json").write_text(json.dumps(PUBLIC))
            os.chmod(root/"local-secrets.json",0o600)
            os.chmod(root/"public-route-metadata.json",0o600)
            gotid,metadata=load_test_metadata(root)
            self.assertEqual(gotid,UID)
            self.assertEqual(metadata["reality_port"],8443)
            os.chmod(root/"local-secrets.json",0o644)
            with self.assertRaisesRegex(ReconcileError,"owner-only"):
                load_test_metadata(root)

if __name__=="__main__":unittest.main()
