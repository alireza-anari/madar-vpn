"""Strict, replay-resistant admission of centrally signed node configuration.

This module ONLY validates and records desired state. It does not install
binaries, bind sockets, or claim any transport is healthy. That requires a
separate pinned installer and real external field acceptance.
"""
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import tempfile
import time
from pathlib import Path

ROUTES={"reality","wss","hysteria2","amneziawg"}
NODE_ID=re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_-]{1,63}$")
KEYS={"node_id","revision","issued_at","expires_at","nonce","routes","user_limit","byte_limit"}
ROUTE_KEYS={"id","transport","listen_port","tls_hostname","ws_path"}


class RejectedManifest(ValueError):
    """Payload rejected without mutating agent state."""


def canonical(payload):
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def sign(payload, secret):
    if not isinstance(secret, bytes) or len(secret)<32:
        raise ValueError("per-node secret must contain at least 32 bytes")
    mac=hmac.new(secret,canonical(payload),hashlib.sha256).digest()
    return base64.urlsafe_b64encode(mac).rstrip(b"=").decode("ascii")


def _check_int(value, low, high):
    return type(value) is int and low<=value<=high


def verify(payload, signature, secret, *, expected_node_id, now=None):
    now=int(time.time()) if now is None else now
    if not isinstance(payload, dict) or set(payload)!=KEYS:
        raise RejectedManifest("invalid manifest fields")
    if not isinstance(signature,str) or len(signature)!=43:
        raise RejectedManifest("invalid signature format")
    valid=sign(payload,secret)
    if not hmac.compare_digest(signature,valid):
        raise RejectedManifest("manifest signature rejected")
    node_id=payload["node_id"]
    if not isinstance(node_id,str) or not NODE_ID.fullmatch(node_id) or node_id!=expected_node_id:
        raise RejectedManifest("wrong node")
    if not _check_int(payload["revision"],1,2**53-1):
        raise RejectedManifest("invalid revision")
    issued,expires=payload["issued_at"],payload["expires_at"]
    if not _check_int(issued,1,2**53-1) or not _check_int(expires,1,2**53-1):
        raise RejectedManifest("invalid time")
    if issued>now+60 or expires<=now or expires-issued>600:
        raise RejectedManifest("expired or unbounded validity")
    nonce=payload["nonce"]
    if not isinstance(nonce,str) or not re.fullmatch(r"[a-fA-F0-9]{32,128}",nonce):
        raise RejectedManifest("invalid nonce")
    if not _check_int(payload["user_limit"],0,1_000_000) or not _check_int(payload["byte_limit"],0,2**53-1):
        raise RejectedManifest("invalid capacity")
    routes=payload["routes"]
    if not isinstance(routes,list) or not 1<=len(routes)<=8:
        raise RejectedManifest("invalid routes")
    ids=set()
    for route in routes:
        if not isinstance(route,dict) or not set(route).issubset(ROUTE_KEYS) or not {"id","transport","listen_port"}.issubset(route):
            raise RejectedManifest("invalid route fields")
        rid,transport,port=route["id"],route["transport"],route["listen_port"]
        if not isinstance(rid,str) or not NODE_ID.fullmatch(rid) or rid in ids:
            raise RejectedManifest("duplicate or invalid route")
        ids.add(rid)
        if transport not in ROUTES or not _check_int(port,1,65535):
            raise RejectedManifest("invalid transport or port")
        if transport=="wss":
            hostname=route.get("tls_hostname")
            path=route.get("ws_path")
            if not isinstance(hostname,str) or not hostname or len(hostname)>253 or any(c in hostname for c in "\\/@ :"):
                raise RejectedManifest("WSS requires a valid hostname")
            if not isinstance(path,str) or not path.startswith("/") or len(path)>256 or any(c in path for c in "\r\n"):
                raise RejectedManifest("WSS requires safe absolute path")
        elif "ws_path" in route or "tls_hostname" in route:
            raise RejectedManifest("protocol-incompatible route fields")
    # Short-lived issued_at/expires_at/nonce are part of the signed envelope,
    # NOT the desired configuration revision. Otherwise every poll generates
    # a conflicting digest for the same revision.
    desired={key:payload[key] for key in (
        "node_id","revision","routes","user_limit","byte_limit"
    )}
    return hashlib.sha256(canonical(desired)).hexdigest()


class AgentStore:
    def __init__(self, root, node_id):
        if not isinstance(node_id,str) or not NODE_ID.fullmatch(node_id):
            raise ValueError("invalid node ID")
        self.root=Path(root)
        self.node_id=node_id

    def _path(self):
        return self.root/"state.json"

    def read(self):
        path=self._path()
        if not path.exists():
            return {"revision":0,"digest":None,"status":"enrolling"}
        if path.is_symlink():
            raise RejectedManifest("refuse symlink state")
        with path.open("r",encoding="utf-8") as stream:
            data=json.load(stream)
        if (not isinstance(data,dict) or not _check_int(data.get("revision"),0,2**53-1)
            or data.get("status") not in {"provisioning","ready","degraded","quarantined"}
            or (data.get("digest") is not None and not re.fullmatch("[a-f0-9]{64}",str(data["digest"])))):
            raise RejectedManifest("corrupt saved state")
        return data

    def _write(self, state):
        self.root.mkdir(mode=0o700,parents=True,exist_ok=True)
        if self.root.is_symlink():
            raise RejectedManifest("refuse symlink directory")
        fd,path=tempfile.mkstemp(prefix=".madar-",dir=self.root)
        try:
            os.fchmod(fd,0o600)
            with os.fdopen(fd,"w",encoding="utf-8") as stream:
                json.dump(state,stream,sort_keys=True)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(path,self._path())
            directory_fd=os.open(self.root,os.O_RDONLY)
            try: os.fsync(directory_fd)
            finally: os.close(directory_fd)
        finally:
            if os.path.exists(path): os.unlink(path)

    def accept(self, payload, signature, secret, *, now=None):
        digest=verify(payload,signature,secret,expected_node_id=self.node_id,now=now)
        current=self.read()
        rev=payload["revision"]
        if rev<current["revision"]:
            raise RejectedManifest("replayed old revision")
        if rev==current["revision"]:
            if current["digest"]==digest:
                return {"status":current["status"],"revision":rev,"unchanged":True}
            raise RejectedManifest("conflicting manifest revision")
        self._write({"revision":rev,"digest":digest,"status":"provisioning"})
        return {"status":"provisioning","revision":rev,"unchanged":False}
