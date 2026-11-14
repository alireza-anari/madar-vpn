"""Real official Xray/Caddy syntax acceptance. Uses pinned release archive digests.

No systemd, VPS, firewall, Telegram, or production mutations in CI.
"""
import hashlib
import json
import os
import socket
import ssl
import time
import base64
import pathlib
import subprocess
import tempfile
import uuid

from agent import releases
from agent.bootstrap import parse_reality_keypair
from agent.xray_config import compile_config,compile_caddy_site
from agent.fresh_dual import build_fresh_dual
from agent.reconciler import _atomic_file

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
            if name=='xray':assert actual==releases.XRAY_BINARY_SHA256['amd64']
        # Verify the ARM64 executable pin as bytes only; this runner is x86-64.
        _,arm_digest=releases.verified_release('xray','arm64')
        assert arm_digest==releases.XRAY_BINARY_SHA256['arm64']
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
        fresh=dict(payload,inbounds=payload['inbounds'][:1])
        dual_path=_atomic_file(directory,'.fresh443-',json.dumps(build_fresh_dual(fresh)))
        try:
            run([paths['xray'],'run','-test','-config',str(dual_path)])
        except subprocess.CalledProcessError as exc:
            raise AssertionError((exc.stdout+exc.stderr).replace(private,'[redacted]')) from None
        caddyfile=directory/"Caddyfile"
        caddyfile.write_text(compile_caddy_site(
            domain="vpn.example.com",ws_path="/madar-ws",loopback_port=10443
        ),encoding="utf-8")
        run([paths["caddy"],"validate","--config",str(caddyfile),
             "--adapter","caddyfile"])
        print("VERIFIED: pinned Xray REALITY+WS and Caddy HTTPS syntax; no service launched")
        # An additional isolated transport test uses Caddy's INTERNAL CA and a
        # high unprivileged HTTPS port. Never treat it as a public certificate.
        testsite=compile_caddy_site(
            domain="vpn.example.com",ws_path="/madar-ws",loopback_port=10443
        ).replace("vpn.example.com {", "vpn.example.com:18443 {\\n    tls internal",1)
        testsite=testsite.replace("\\n", "\n")
        testsite="{\n    admin off\n    skip_install_trust\n    auto_https disable_redirects\n}\n"+testsite
        local_site=directory/"LocalCaddyfile"
        local_site.write_text(testsite,encoding="utf-8")
        run([paths["caddy"],"validate","--config",str(local_site),"--adapter","caddyfile"])
        env=dict(os.environ)
        env["XDG_DATA_HOME"]=str(directory/"caddy-data")
        env["XDG_CONFIG_HOME"]=str(directory/"caddy-config")
        processes=[]
        try:
            processes.append(subprocess.Popen([paths["xray"],"run","-config",str(config_path)],
                stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL))
            processes.append(subprocess.Popen([paths["caddy"],"run","--config",str(local_site),
                "--adapter","caddyfile"],env=env,
                stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL))
            cert=directory/"caddy-data"/"caddy"/"pki"/"authorities"/"local"/"root.crt"
            successful=False
            last_error=None
            for _ in range(70):
                exited=[name+":"+str(p.returncode) for name,p in zip(("xray","caddy"),processes) if p.poll() is not None]
                if exited:
                    raise AssertionError("isolated process exited before TLS upgrade: "+",".join(exited))
                if not cert.exists():
                    time.sleep(0.2)
                    continue
                try:
                    context=ssl.create_default_context(cafile=str(cert))
                    with socket.create_connection(("127.0.0.1",18443),timeout=2) as plain:
                        with context.wrap_socket(plain,server_hostname="vpn.example.com") as tls:
                            tls.settimeout(2)
                            key=base64.b64encode(os.urandom(16)).decode("ascii")
                            request=("GET /madar-ws HTTP/1.1\\r\\n"
                                "Host: vpn.example.com\\r\\n"
                                "Connection: Upgrade\\r\\nUpgrade: websocket\\r\\n"
                                "Sec-WebSocket-Version: 13\\r\\n"
                                "Sec-WebSocket-Key: "+key+"\\r\\n\\r\\n")
                            tls.sendall(request.replace("\\r\\n","\r\n").encode("ascii"))
                            answer=tls.recv(2048)
                    if b" 101 " in answer.split(b"\\r\\n",1)[0]:
                        successful=True
                        break
                    last_error="unexpected HTTP response"
                except (OSError,ssl.SSLError) as e:
                    last_error=type(e).__name__
                time.sleep(0.2)
            if not successful:
                raise AssertionError("local TLS-verified WebSocket upgrade failed: "+str(last_error))
            print("VERIFIED: CA-trusted local TLS -> Caddy -> Xray WSS HTTP 101 upgrade (not carrier tested)")
        finally:
            for process in reversed(processes):
                if process.poll() is None:
                    process.terminate()
                    try: process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill();process.wait(timeout=5)
if __name__=="__main__":main()
