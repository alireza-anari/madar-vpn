"""Madar V2 outbound node polling only; never installs or restarts Xray.

Node-specific HMAC credentials are read from a local mode-0600 file.
Only HTTPS without redirects is allowed. Control-plane acknowledgements
confirm receipt, not proxy health or field connectivity.
"""
import argparse
import base64
import hashlib
import hmac
import json
import os
import secrets
import stat
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from .manifest import AgentStore, RejectedManifest, sign


def read_node_secret(filename):
    path=Path(filename)
    metadata=path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_mode & 0o077:
        raise ValueError("node credential must be a regular, mode-0600 file")
    if metadata.st_uid != os.geteuid():
        raise ValueError("node credential must belong to the agent account")
    data=path.read_text(encoding="ascii").strip()
    if not data or len(data)>100:
        raise ValueError("invalid node credential encoding")
    raw=base64.urlsafe_b64decode(data+"="*((4-len(data)%4)%4))
    if len(raw)!=32:
        raise ValueError("node credential must be 32 bytes")
    return raw


def validate_server(url):
    parsed=urllib.parse.urlsplit(url)
    if parsed.scheme!="https" or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("control-plane URL must use HTTPS and no user info")
    if parsed.query or parsed.fragment or parsed.path not in ("", "/"):
        raise ValueError("control-plane base URL cannot include a path or query")
    return parsed.scheme+"://"+parsed.netloc


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, hdrs, newurl):
        return None


def signed_headers(key,node_id,method,path,body,now=None):
    now=int(time.time()) if now is None else now
    nonce=secrets.token_hex(16)
    body_hash=hashlib.sha256(body).hexdigest()
    signing_string="\n".join((method,path,str(now),nonce,body_hash)).encode("utf-8")
    signature=base64.urlsafe_b64encode(
        hmac.new(key,signing_string,hashlib.sha256).digest()
    ).rstrip(b"=").decode("ascii")
    return {
        "X-Madar-Node-Id":node_id,
        "X-Madar-Node-Timestamp":str(now),
        "X-Madar-Node-Nonce":nonce,
        "X-Madar-Node-Signature":signature,
    }


def send(opener,base,node_id,key,method,path,payload=None):
    body=b"" if payload is None else json.dumps(
        payload,separators=(",",":"),ensure_ascii=False
    ).encode("utf-8")
    headers=signed_headers(key,node_id,method,path,body)
    headers["Accept"]="application/json"
    if method=="POST":
        headers["Content-Type"]="application/json"
    req=urllib.request.Request(base+path,headers=headers,method=method,
                              data=body if method=="POST" else None)
    with opener.open(req,timeout=10) as response:
        if response.status!=200:
            raise ValueError("control-plane refused signed request")
        raw=response.read(65_537)
        if len(raw)>65_536:
            raise ValueError("control-plane response too large")
    result=json.loads(raw.decode("utf-8"))
    if not isinstance(result,dict):
        raise ValueError("invalid response")
    return result


def poll_once(base_url,node_id,key,state_root,opener=None,now=None):
    if opener is None:
        opener=urllib.request.build_opener(
            urllib.request.ProxyHandler({}),NoRedirect()
        )
    base=validate_server(base_url)
    if not 32<=len(key)<=32:
        raise ValueError("node key must be 32 bytes")
    response=send(opener,base,node_id,key,"GET","/api/node/v1/manifest")
    if set(response)<{"payload","signature"}:
        raise ValueError("unsigned manifest")
    store=AgentStore(state_root,node_id)
    outcome=store.accept(response["payload"],response["signature"],key,now=now)
    current=store.read()
    send(opener,base,node_id,key,"POST","/api/node/v1/ack",{
        "revision":outcome["revision"],
        "digest":current["digest"],
        "status":"accepted",
    })
    return {"revision":outcome["revision"],
            "status":outcome["status"],
            "connection_verified":False}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server",required=True)
    parser.add_argument("--node-id",required=True)
    parser.add_argument("--key-file",required=True)
    parser.add_argument("--state-dir",required=True)
    args=parser.parse_args()
    key=read_node_secret(args.key_file)
    result=poll_once(args.server,args.node_id,key,args.state_dir)
    print(json.dumps(result,sort_keys=True))


if __name__=="__main__":
    main()
