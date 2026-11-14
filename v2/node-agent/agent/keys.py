"""Offline per-node HKDF bootstrap. Run only on a trusted provisioning host.

The Cloudflare Worker holds the MASTER secret. Never copy the master to VPS
nodes. Transfer only the derived 0600 node key over a pinned encrypted channel.
"""
import argparse
import base64
import hashlib
import hmac
import os
import re
import stat
from pathlib import Path

NODE_RE=re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$")


def derive_node_secret(master,node_id):
    if not isinstance(master,bytes) or len(master)!=32:
        raise ValueError("master key must be exactly 32 bytes")
    if not isinstance(node_id,str) or not NODE_RE.fullmatch(node_id):
        raise ValueError("invalid node identity")
    salt=b"madar-v2/node-hkdf/v1"
    info=b"madar-v2/node/v1:"+node_id.encode("ascii")
    prk=hmac.new(salt,master,hashlib.sha256).digest()
    return hmac.new(prk,info+b"\x01",hashlib.sha256).digest()


def read_master(filename):
    p=Path(filename)
    s=p.lstat()
    if not stat.S_ISREG(s.st_mode) or s.st_mode & 0o077 or s.st_uid!=os.geteuid():
        raise ValueError("master file must be local, owned and mode 0600")
    text=p.read_text(encoding="ascii").strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{43}",text):
        raise ValueError("invalid master encoding")
    raw=base64.urlsafe_b64decode(text+"=")
    if len(raw)!=32:
        raise ValueError("invalid master length")
    return raw


def write_node_secret(dest,key):
    path=Path(dest)
    parent=path.parent
    meta=parent.stat()
    if not stat.S_ISDIR(meta.st_mode) or meta.st_mode & 0o022:
        raise ValueError("node key directory must not be group/world writable")
    flags=os.O_WRONLY|os.O_CREAT|os.O_EXCL
    if hasattr(os,"O_NOFOLLOW"):
        flags|=os.O_NOFOLLOW
    fd=os.open(path,flags,0o600)
    try:
        os.fchmod(fd,0o600)
        with os.fdopen(fd,"w",encoding="ascii") as stream:
            stream.write(base64.urlsafe_b64encode(key).rstrip(b"=").decode("ascii")+"\n")
            stream.flush()
            os.fsync(stream.fileno())
    except:
        try: path.unlink(missing_ok=True)
        finally: raise


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--master-file",required=True)
    parser.add_argument("--node-id",required=True)
    parser.add_argument("--output",required=True)
    args=parser.parse_args()
    master=read_master(args.master_file)
    secret=derive_node_secret(master,args.node_id)
    write_node_secret(args.output,secret)
    print("Node-specific secret written (contents intentionally hidden).")


if __name__=="__main__":
    main()
