import base64
import hashlib
import hmac
import json
import tempfile
import unittest

from agent.manifest import AgentStore, sign
from agent.poller import signed_headers,validate_server,send,poll_once,NODE_USER_AGENT

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

    def test_cloudflare_1010_regression_all_signed_node_requests_have_agent_identity(self):
        # Fake Cloudflare edge: urllib's default Python-urllib/3.x is blocked
        # even when the request has a valid HMAC signature.
        class Accepted:
            status=200
            def __enter__(self): return self
            def __exit__(self,*args): return False
            def read(self,n): return b'{"ok":true}'

        class CloudflareEdge:
            def __init__(self): self.received=[]
            def open(self,req,timeout):
                from urllib.parse import urlsplit
                self.received.append(req)
                headers={k.lower():v for k,v in req.header_items()}
                if headers.get("user-agent")!=NODE_USER_AGENT:
                    raise ValueError("Cloudflare error code 1010")
                self_assert=unittest.TestCase()
                self_assert.assertEqual(timeout,10)
                self_assert.assertEqual(headers["x-madar-node-id"],"node_01")
                self_assert.assertEqual(headers["accept"],"application/json")
                method=req.get_method()
                path=urlsplit(req.full_url).path
                body=req.data or b""
                canonical="\n".join((
                    method,path,headers["x-madar-node-timestamp"],
                    headers["x-madar-node-nonce"],hashlib.sha256(body).hexdigest()
                )).encode()
                sig=base64.urlsafe_b64encode(
                    hmac.new(KEY,canonical,hashlib.sha256).digest()
                ).rstrip(b"=").decode()
                self_assert.assertEqual(headers["x-madar-node-signature"],sig)
                if method=="POST":
                    self_assert.assertEqual(headers["content-type"],"application/json")
                return Accepted()

        transport=CloudflareEdge()
        requests=[
            ("GET","/api/node/v1/manifest",None),
            ("POST","/api/node/v1/ack",{"revision":1,"digest":"a"*64,"status":"accepted"}),
            ("GET","/api/node/v1/clients",None),
            ("POST","/api/node/v1/clients/ack",{"revision":1,"clients":[]}),
            ("POST","/api/node/v1/health",{"revision":1,"ports":[443,8443]}),
            ("POST","/api/node/v1/usage",{"revision":1,"reports":[]}),
            ("POST","/api/node/v1/clients/revoked",{"revision":1,"subscription_ids":[]}),
        ]
        for method,path,payload in requests:
            self.assertTrue(send(transport,"https://example.com","node_01",
                                 KEY,method,path,payload)["ok"])
        self.assertEqual(len(transport.received),len(requests))

    def test_poll_once_uses_same_user_agent_for_manifest_and_ack(self):
        class Response:
            status=200
            def __init__(self,payload): self.payload=json.dumps(payload).encode()
            def __enter__(self): return self
            def __exit__(self,*args): return False
            def read(self,n): return self.payload[:n]

        class ControlPlane:
            def __init__(self): self.seen=[]
            def open(self,req,timeout):
                self.seen.append(req)
                headers={k.lower():v for k,v in req.header_items()}
                if headers.get("user-agent")!=NODE_USER_AGENT:
                    raise ValueError("Cloudflare error code 1010")
                if req.get_method()=="GET":
                    manifest=desired("f"*32)
                    return Response({"payload":manifest,"signature":sign(manifest,KEY)})
                self.assert_ack=json.loads(req.data)
                return Response({"ok":True,"route_ready":False})

        with tempfile.TemporaryDirectory() as directory:
            edge=ControlPlane()
            result=poll_once("https://example.com","node_01",KEY,directory,
                             opener=edge,now=NOW)
            self.assertEqual(result["revision"],1)
            self.assertEqual(len(edge.seen),2)
            self.assertEqual([req.get_method() for req in edge.seen],
                             ["GET","POST"])
            self.assertEqual(edge.assert_ack["status"],"accepted")

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
