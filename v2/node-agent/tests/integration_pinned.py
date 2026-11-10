"""Real official Xray/Caddy syntax acceptance. Uses pinned release archive digests.

No systemd, VPS, firewall, Telegram, or production mutations in CI.
"""
import hashlib
import json
import os
import pathlib
import subprocess
import tempfile
import uuid

from agent import releases
from agent.bootstrap import parse_reality_keypair
from agent.xray_config import compile_config,compile_caddy_site

def run(args):
    return subprocess.run(args,check=True,timeout=25,text=True,capture_output=True)

def main():
    with tempfile.TemporaryDirectory(prefix="madar-v2-config-") as root:
        directory=pathlib.Path(root)
        paths={}
        for name in ("xray","caddy"):
            content,expected_sha=releases.verified_release(name,"amd64")
            binary=releases.place_executable(directory,name,content)
            actual=hashlib.sha256(binary.read_bytes()).hexdigest()
            assert actual==expected_sha
            paths[name]=str(binary)
        # The private key remains in a temporary directory and is never logged.
        private,_=parse_reality_keypair(run([paths["xray"],"x25519"]).stdout)
        payload=compile_config(
            clients=[str(uuid.uuid4())],
            reality={"port":8443,"target":"www.cloudflare.com",
                     "server_name":"www.cloudflare.com",
                     "private_key":private,"short_ids":["aabbccddeeff0011"]},
            websocket={"path":"/madar-ws","loopback_port":10443},
        )
        config_path=directory/"config.json"
        config_path.write_text(json.dumps(payload),encoding="utf-8")
        os.chmod(config_path,0o600)
        run([paths["xray"],"run","-test","-config",str(config_path)])
        caddyfile=directory/"Caddyfile"
        caddyfile.write_text(compile_caddy_site(
            domain="vpn.example.com",ws_path="/madar-ws",loopback_port=10443
        ),encoding="utf-8")
        run([paths["caddy"],"validate","--config",str(caddyfile),
             "--adapter","caddyfile"])
        print("VERIFIED: pinned Xray REALITY+WS and Caddy HTTPS syntax; no service launched")
if __name__=="__main__":main()
