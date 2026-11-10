import base64
import hashlib
import hmac
import tempfile
import unittest

from agent.manifest import AgentStore, sign
from agent.poller import signed_headers,validate_server

KEY=b"1"*32
NOW=1800000000

def desired(nonce):
    return {
        "node_id":"node_01","revision":1,
        "issued_at":NOW-1,"expires_at":NOW+150,"nonce":nonce,
        "routes":[{"id":"reality_1","transport":"reality","listen_port":443}],
        "user_limit":10,"byte_limit":100000,
    }

class PollerTests(unittest.TestCase):
    def test_repeated_poll_does_not_conflict_with_new_signature_nonce(self):
        with tempfile.TemporaryDirectory() as root:
            store=AgentStore(root,"node_01")
            a=desired("a"*32)
            b=desired("b"*32)
            first=store.accept(a,sign(a,KEY),KEY,now=NOW)
            second=store.accept(b,sign(b,KEY),KEY,now=NOW)
            self.assertFalse(first["unchanged"])
            self.assertTrue(second["unchanged"])

    def test_same_revision_changed_routes_still_rejected(self):
        from agent.manifest import RejectedManifest
        with tempfile.TemporaryDirectory() as root:
            store=AgentStore(root,"node_01")
            a=desired("a"*32)
            store.accept(a,sign(a,KEY),KEY,now=NOW)
            b=desired("b"*32)
            b["routes"][0]["listen_port"]=8443
            with self.assertRaises(RejectedManifest):
                store.accept(b,sign(b,KEY),KEY,now=NOW)

    def test_request_signature_covers_method_path_nonce_and_body(self):
        headers=signed_headers(KEY,"node_01","GET","/api/node/v1/manifest",b"",now=NOW)
        msg="\n".join(("GET","/api/node/v1/manifest",str(NOW),
            headers["X-Madar-Node-Nonce"],hashlib.sha256(b"").hexdigest())).encode()
        expected=base64.urlsafe_b64encode(hmac.new(KEY,msg,hashlib.sha256).digest()).rstrip(b"=").decode()
        self.assertEqual(headers["X-Madar-Node-Signature"],expected)

    def test_control_base_never_allows_plaintext_or_redirect_urls(self):
        with self.assertRaises(ValueError):
            validate_server("http://example.com")
        with self.assertRaises(ValueError):
            validate_server("https://user:password@example.com")
        with self.assertRaises(ValueError):
            validate_server("https://example.com/steal?secret=x")
        self.assertEqual(validate_server("https://example.com/"),"https://example.com")

if __name__=="__main__":
    unittest.main()
