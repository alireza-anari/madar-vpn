"""One-time background pairing. Private keys are generated only on the Runner host."""
import argparse,base64,hashlib,json,os,pathlib,pwd,subprocess,time,urllib.request
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa,padding
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

CONFIG=pathlib.Path('/etc/madar-sales-runner')
BASE='https://madar-sales-bot.alirezaanari117.workers.dev'

def private_write(path,value):
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 with os.fdopen(fd,'wb') as f:f.write(value)

def prepare_identity(directory):
 directory=pathlib.Path(directory);directory.mkdir(parents=True,exist_ok=True,mode=0o700)
 if directory.stat().st_mode & 0o077:raise ValueError('CONFIG_PERMISSIONS')
 path=directory/'runner-private.pem'
 if not path.exists():
  key=rsa.generate_private_key(public_exponent=65537,key_size=3072)
  private_write(path,key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()))
 if path.stat().st_mode & 0o077:raise ValueError('KEY_PERMISSIONS')
 key=serialization.load_pem_private_key(path.read_bytes(),None)
 numbers=key.public_key().public_numbers()
 b64=lambda n:base64.urlsafe_b64encode(n.to_bytes((n.bit_length()+7)//8,'big')).decode().rstrip('=')
 public={'kty':'RSA','n':b64(numbers.n),'e':b64(numbers.e),'alg':'RSA-OAEP-256','ext':True,'key_ops':['encrypt']}
 fingerprint=hashlib.sha256(json.dumps(public,sort_keys=True,separators=(',',':')).encode()).hexdigest()
 return {'publicKey':public,'fingerprint':fingerprint}

def install_config(directory,payload,base):
 directory=pathlib.Path(directory);identity=prepare_identity(directory)
 if payload.get('baseUrl')!=base or payload.get('fingerprint')!=identity['fingerprint']:raise ValueError('PAIRING_MISMATCH')
 if not isinstance(payload.get('serviceSecret'),str) or not payload['serviceSecret']:raise ValueError('INVALID_CONFIG')
 config={'baseUrl':base,'serviceSecret':payload['serviceSecret'],'runnerId':'sales-runner-1','privateKeyPath':str((directory/'runner-private.pem').resolve())}
 path=directory/'runner.json'
 if path.exists():
  if path.stat().st_mode & 0o077 or json.loads(path.read_text())!=config:raise ValueError('CONFIG_ALREADY_EXISTS')
 else:private_write(path,json.dumps(config).encode())

def render_service():
 return '''[Unit]
Description=Madar sales provisioning runner
After=network-online.target
Wants=network-online.target
[Service]
User=madar-sales-runner
Group=madar-sales-runner
WorkingDirectory=/opt/madar-sales-runner/sales-runner
ExecStart=/opt/madar-sales-runner/venv/bin/python /opt/madar-sales-runner/sales-runner/runner.py --config /etc/madar-sales-runner/runner.json
Restart=always
RestartSec=5
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadOnlyPaths=/etc/madar-sales-runner
[Install]
WantedBy=multi-user.target
'''

def request(path,data):
 req=urllib.request.Request(BASE+'/ops/runner-bootstrap/'+path,data=json.dumps(data).encode(),headers={'Content-Type':'application/json'})
 with urllib.request.urlopen(req,timeout=20) as response:return json.loads(response.read(16384))

def main():
 if os.geteuid()!=0:raise ValueError('ROOT_REQUIRED')
 identity=prepare_identity(CONFIG)
 print('PAIRING '+identity['fingerprint'],flush=True)
 deadline=time.monotonic()+1800
 while time.monotonic()<deadline:
  try:
   response=request('pair',identity)
   if response.get('envelope'):
    data=response['envelope'];decode=lambda k:base64.b64decode(data[k],validate=True)
    key=serialization.load_pem_private_key((CONFIG/'runner-private.pem').read_bytes(),None)
    aes=key.decrypt(decode('key'),padding.OAEP(mgf=padding.MGF1(hashes.SHA256()),algorithm=hashes.SHA256(),label=None))
    payload=json.loads(AESGCM(aes).decrypt(decode('iv'),decode('data'),None))
    install_config(CONFIG,payload,BASE)
    user=pwd.getpwnam('madar-sales-runner')
    for path in [CONFIG,CONFIG/'runner-private.pem',CONFIG/'runner.json']:os.chown(path,user.pw_uid,user.pw_gid)
    unit=pathlib.Path('/etc/systemd/system/madar-sales-runner.service')
    if unit.exists() and unit.read_text()!=render_service():raise ValueError('EXISTING_UNIT')
    unit.write_text(render_service());os.chmod(unit,0o644)
    subprocess.run(['systemctl','daemon-reload'],check=True)
    subprocess.run(['systemctl','enable','--now','madar-sales-runner.service'],check=True)
    subprocess.run(['systemctl','is-active','--quiet','madar-sales-runner.service'],check=True)
    print('RUNNER_SERVICE_STARTED; real enrollment verification remains required.',flush=True)
    return
  except (urllib.error.URLError,TimeoutError):pass
  time.sleep(10)
 raise ValueError('PAIRING_TIMEOUT')

if __name__=='__main__':
 try:main()
 except Exception:raise SystemExit('RUNNER_BOOTSTRAP_FAILED; no secret values logged') from None
