import copy
import json
import tempfile
import time
import unittest

from agent.manifest import AgentStore, RejectedManifest, sign, verify

SECRET=b"A"*32
NOW=1800000000

def sample():
    return {"node_id":"node_01","revision":1,"issued_at":NOW-2,
        "expires_at":NOW+200,"nonce":"a"*32,
        "routes":[{"id":"reality_1","transport":"reality","listen_port":443},
                  {"id":"wss_1","transport":"wss","listen_port":2087,
                   "tls_hostname":"vpn.example.com","ws_path":"/proxy"}],
        "user_limit":20,"byte_limit":1_000_000_000_000}

class ManifestTests(unittest.TestCase):
    def test_valid_admission_then_idempotent_replay(self):
        with tempfile.TemporaryDirectory() as root:
            store=AgentStore(root,"node_01")
            p=sample()
            sig=sign(p,SECRET)
            a=store.accept(p,sig,SECRET,now=NOW)
            self.assertEqual(a["status"],"provisioning")
            self.assertFalse(a["unchanged"])
            self.assertTrue(store.accept(p,sig,SECRET,now=NOW)["unchanged"])

    def test_tampering_wrong_node_and_expiry_fail_closed(self):
        p=sample()
        good=sign(p,SECRET)
        p["routes"][0]["listen_port"]=9999
        with self.assertRaises(RejectedManifest):
            verify(p,good,SECRET,expected_node_id="node_01",now=NOW)
        with self.assertRaises(RejectedManifest):
            verify(p,sign(p,SECRET),SECRET,expected_node_id="other",now=NOW)
        with self.assertRaises(RejectedManifest):
            verify(p,sign(p,SECRET),SECRET,expected_node_id="node_01",now=NOW+500)

    def test_monotonic_revision_and_conflicting_replay(self):
        with tempfile.TemporaryDirectory() as root:
            store=AgentStore(root,"node_01")
            p=sample()
            store.accept(p,sign(p,SECRET),SECRET,now=NOW)
            p["revision"]=2
            p["nonce"]="b"*32
            store.accept(p,sign(p,SECRET),SECRET,now=NOW)
            p["revision"]=1
            with self.assertRaisesRegex(RejectedManifest,"replayed"):
                store.accept(p,sign(p,SECRET),SECRET,now=NOW)
            p["revision"]=2
            p["user_limit"]=100
            with self.assertRaisesRegex(RejectedManifest,"conflicting"):
                store.accept(p,sign(p,SECRET),SECRET,now=NOW)

    def test_rejects_protocol_ambiguity_and_arbitrary_commands(self):
        p=sample()
        p["shell"]="rm -rf /"
        with self.assertRaises(RejectedManifest):
            verify(p,sign(p,SECRET),SECRET,expected_node_id="node_01",now=NOW)
        p.pop("shell")
        p["routes"][1]["ws_path"]="wrong"
        with self.assertRaises(RejectedManifest):
            verify(p,sign(p,SECRET),SECRET,expected_node_id="node_01",now=NOW)
        p["routes"][1]["ws_path"]="/valid"
        p["routes"].append(dict(p["routes"][0]))
        with self.assertRaises(RejectedManifest):
            verify(p,sign(p,SECRET),SECRET,expected_node_id="node_01",now=NOW)

    def test_invalid_secret_is_never_accepted(self):
        p=sample()
        with self.assertRaises(ValueError):
            sign(p,b"weak")

if __name__ == "__main__":
    unittest.main()
