"""Read-only Madar V2 REALITY / WSS authenticated tunnel diagnostics.

Runs on the DISPOSABLE staging VPS only, where Xray is already installed.
Creates temporary, private loopback-only SOCKS clients; never modifies the
running node services or exposes client secrets, private keys, or VPN URIs.

Unlike an HTTP 101 check, the result verifies actual proxied HTTPS data.
Passing on localhost still does not prove that any mobile carrier can reach
the server from another location.
"""
import argparse
import hashlib
import json
import os
import socket
import stat
import subprocess
import tempfile
import time
import uuid
from pathlib import Path

from .installer import require_staging_marker
from .reconciler import ReconcileError, _safe_config_root
from .xray_config import DOMAIN, BASE64URL, SHORT_ID, WS_PATH

TEST_TARGETS=(
    "https://www.gstatic.com/generate_204",
    "https://www.cloudflare.com/cdn-cgi/trace",
)
EXPECTED_XRAY_SHA256="e87bce586acdb9136aa5b1f1d9c8db9f1ea1d145b6d86368c7f6f662f9f6a66d"


def _private_dict(directory,basename):
    path=directory/basename
    info=path.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077
            or info.st_uid!=os.geteuid() or info.st_size>65536):
        raise ReconcileError("test metadata must be owner-only regular files")
    content=json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(content,dict):
        raise ReconcileError("invalid local test metadata")
    return content


def load_test_metadata(root):
    directory=_safe_config_root(root)
    require_staging_marker(directory)
    secret=_private_dict(directory,"local-secrets.json")
    public=_private_dict(directory,"public-route-metadata.json")
    clients=secret.get("clients")
    if not isinstance(clients,list) or len(clients)!=1 or not isinstance(clients[0],str):
        raise ReconcileError("expected one staging-only test client")
    try:
        client_id=str(uuid.UUID(clients[0]))
    except ValueError:
        raise ReconcileError("invalid test user ID") from None
    reality=secret.get("reality")
    websocket=secret.get("websocket")
    if not isinstance(reality,dict) or not isinstance(websocket,dict):
        raise ReconcileError("REALITY and WSS are both required for diagnostics")
    domain=public.get("wss_domain")
    path=public.get("wss_path")
    rp=public.get("reality_port")
    key=public.get("reality_public_key")
    sid=public.get("short_id")
    sni=public.get("reality_server_name")
    if (not isinstance(domain,str) or not DOMAIN.fullmatch(domain) or
        not isinstance(path,str) or not WS_PATH.fullmatch(path) or
        not isinstance(sni,str) or not DOMAIN.fullmatch(sni) or
        not isinstance(key,str) or not BASE64URL.fullmatch(key) or
        not isinstance(sid,str) or not SHORT_ID.fullmatch(sid) or
        type(rp) is not int or not 1024<=rp<=65535 or
        websocket.get("path")!=path or secret.get("wss_hostname")!=domain):
        raise ReconcileError("incomplete or inconsistent test metadata")
    return client_id,public


def diagnostic_client_config(client_id,public,transport,socks_port,
                             *,insecure_local_tls=False):
    """Valid Xray VLESS outbound config, NEVER print or log the result."""
    if transport not in ("reality","wss"):
        raise ValueError("unsupported staging transport")
    if type(socks_port) is not int or not 1024<=socks_port<=65535:
        raise ValueError("invalid private SOCKS port")
    account={"id":client_id,"encryption":"none"}
    if transport=="reality":
        account["flow"]="xtls-rprx-vision"
        address="127.0.0.1"
        endpoint_port=public["reality_port"]
        stream={
            "network":"raw","security":"reality",
            "realitySettings":{
                "serverName":public["reality_server_name"],
                "fingerprint":"chrome",
                "publicKey":public["reality_public_key"],
                "shortId":public["short_id"],
            },
        }
    else:
        address="127.0.0.1"
        endpoint_port=443
        hostname=public["wss_domain"]
        stream={
            "network":"ws","security":"tls",
            "tlsSettings":{
                "serverName":hostname,"allowInsecure":bool(insecure_local_tls),
                "alpn":["http/1.1"],
            },
            "wsSettings":{
                "path":public["wss_path"],
                "headers":{"Host":hostname},
            },
        }
    return {
        "log":{"loglevel":"warning"},
        "inbounds":[{
            "tag":"diagnostic-socks","listen":"127.0.0.1",
            "port":socks_port,"protocol":"socks",
            "settings":{"auth":"noauth","udp":False},
        }],
        "outbounds":[{
            "tag":"proxy","protocol":"vless",
            "settings":{"vnext":[{
                "address":address,"port":endpoint_port,"users":[account],
            }]},
            "streamSettings":stream,
        }],
    }


def _port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1",0))
        return sock.getsockname()[1]


def _safe_environment():
    result=dict(os.environ)
    for key in list(result):
        if key.lower().endswith("_proxy") or key.lower()=="no_proxy":
            del result[key]
    return result


def execute_probe(xray,client_config,*,timeout=12):
    """Return only sanitized status; no terminal output or credential leakage."""
    with tempfile.TemporaryDirectory(prefix="madar-test-probe-") as temp:
        root=Path(temp)
        path=root/"client.json"
        fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        with os.fdopen(fd,"w",encoding="utf-8") as handle:
            json.dump(client_config,handle)
        try:
            test=subprocess.run([str(xray),"run","-test","-config",str(path)],
                stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
                stdin=subprocess.DEVNULL,timeout=10,check=False)
            if test.returncode:
                return {"status":"FAIL","reason":"client_config_invalid"}
        except (OSError,subprocess.TimeoutExpired):
            return {"status":"FAIL","reason":"native_xray_unavailable"}
        service=None
        try:
            service=subprocess.Popen([str(xray),"run","-config",str(path)],
                stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL)
            socks_port=client_config["inbounds"][0]["port"]
            for _ in range(40):
                if service.poll() is not None:
                    return {"status":"FAIL","reason":"native_client_exited"}
                try:
                    with socket.create_connection(("127.0.0.1",socks_port),timeout=0.2):
                        break
                except OSError:
                    time.sleep(0.1)
            else:
                return {"status":"FAIL","reason":"local_socks_unavailable"}
            reason="remote_request_failed"
            for target in TEST_TARGETS:
                try:
                    result=subprocess.run([
                        "curl","--silent","--show-error","--fail",
                        "--connect-timeout","5","--max-time",str(timeout),
                        "--proxy",f"socks5h://127.0.0.1:{socks_port}",
                        "--output","/dev/null","--write-out","%{http_code}",target
                    ],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,
                        stderr=subprocess.DEVNULL,text=True,
                        timeout=timeout+3,env=_safe_environment(),check=False)
                    if result.returncode==0 and result.stdout.strip() in ("200","204"):
                        return {"status":"PASS","reason":"authenticated_tunneled_https"}
                    reason="curl_exit_"+str(result.returncode)
                except FileNotFoundError:
                    return {"status":"FAIL","reason":"curl_not_installed"}
                except subprocess.TimeoutExpired:
                    reason="probe_timeout"
            return {"status":"FAIL","reason":reason}
        finally:
            if service is not None and service.poll() is None:
                service.terminate()
                try: service.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    service.kill()
                    service.wait(timeout=3)


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root",default="/etc/madar-v2")
    parser.add_argument("--xray",default="/opt/madar-v2/bin/xray")
    args=parser.parse_args(argv)
    uid,public=load_test_metadata(args.root)
    xray=Path(args.xray)
    info=xray.lstat()
    if (not stat.S_ISREG(info.st_mode) or not info.st_mode&stat.S_IXUSR or
            info.st_uid!=0 or xray.is_symlink()):
        raise ReconcileError("test Xray binary is not a safe root-owned regular executable")
    if hashlib.sha256(xray.read_bytes()).hexdigest()!=EXPECTED_XRAY_SHA256:
        raise ReconcileError("test Xray does not match the deployed approved binary")
    outcome={}
    for transport in ("reality","wss"):
        config=diagnostic_client_config(uid,public,transport,_port())
        outcome[transport]=execute_probe(xray,config)
    print(json.dumps({"checks":outcome,"network":"local_test_vps",
                      "carrier_verified":False},sort_keys=True))
    return 0 if all(x["status"]=="PASS" for x in outcome.values()) else 1


if __name__=="__main__":
    raise SystemExit(main())
