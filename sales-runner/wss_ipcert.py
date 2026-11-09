"""Optional fresh-node IP certificate for isolated metered WSS tests.

Never affects existing nodes, REALITY port 443, other services, DNS or
customer traffic. Uses Let's Encrypt's 160-hour IP SAN certificate via
Certbot >= 5.4 on Ubuntu 22.04/24.04. A failed WSS preflight must not
misreport this protocol as installed.
"""
import ipaddress
import json
import re

WSS_TEST_PORT = 2087
ACME_HTTP_PORT = 80


def validate_ip(target):
    if not isinstance(target, str):
        raise ValueError("WSS_INVALID_PUBLIC_IP")
    try:
        ip = ipaddress.IPv4Address(target)
    except (ValueError, TypeError):
        raise ValueError("WSS_INVALID_PUBLIC_IP") from None
    if not ip.is_global or str(ip) != target:
        raise ValueError("WSS_INVALID_PUBLIC_IP")
    return target


def ipcert_paths(target):
    ip = validate_ip(target)
    return {
        "wssIpAddress": ip,
        "wssTlsCert": "/etc/letsencrypt/live/" + ip + "/fullchain.pem",
        "wssTlsKey": "/etc/letsencrypt/live/" + ip + "/privkey.pem",
    }


def preparation_script(target):
    ip = validate_ip(target)
    return r"""
import ipaddress,json,pathlib,re,socket,ssl,subprocess,time
ip=%r
if not ipaddress.IPv4Address(ip).is_global:raise SystemExit('WSS_INVALID_IP')
for port in (80,2087):
 with socket.socket() as sock:
  try:sock.bind(('0.0.0.0',port))
  except OSError:raise SystemExit('WSS_PORT_BUSY')
cert=pathlib.Path('/etc/letsencrypt/live')/ip/'fullchain.pem'
key=pathlib.Path('/etc/letsencrypt/live')/ip/'privkey.pem'
def verify():
 try:
  if not cert.is_file() or not key.is_file():return False
  data=ssl._ssl._test_decode_cert(str(cert))
  return ((('IP Address',ip) in data.get('subjectAltName',[]))
          and ssl.cert_time_to_seconds(data['notAfter'])>time.time()+3600
          and key.stat().st_mode & 0o077==0)
 except Exception:return False
if not verify():
 version=subprocess.run(['sh','-c','command -v certbot'],capture_output=True,text=True,timeout=5)
 if version.returncode!=0:
  subprocess.run(['snap','install','certbot','--classic'],check=True,timeout=160,
                 capture_output=True)
 result=subprocess.run(['certbot','--version'],capture_output=True,text=True,check=True,timeout=6)
 match=re.search(r'certbot (\d+)\.(\d+)',result.stdout+' '+result.stderr)
 if not match or tuple(map(int,match.groups()))<(5,4):
  raise SystemExit('WSS_CERTBOT_TOO_OLD')
 subprocess.run(['certbot','certonly','--standalone','--non-interactive',
                 '--agree-tos','--register-unsafely-without-email',
                 '--preferred-profile','shortlived','--ip-address',ip],
                check=True,timeout=180,capture_output=True)
if not verify():raise SystemExit('WSS_CERT_INVALID')
print(json.dumps({'verified':True,'ip':ip,'port':2087}))
""" % repr(ip)


def parse_preparation(result, target):
    try:
        data = json.loads(result)
    except (TypeError, ValueError):
        raise ValueError("WSS_CERT_NOT_VERIFIED") from None
    if (data != {"verified": True, "ip": validate_ip(target), "port": 2087}):
        raise ValueError("WSS_CERT_NOT_VERIFIED")
    return ipcert_paths(target)
