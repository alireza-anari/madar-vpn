"""Operator-only attachment on the existing runner host, not on added VPN nodes.

Uses its local private key to decrypt the V2-only service configuration.
Never reads or modifies runner.json, the V1 service or any VPN service.
"""
import base64
import json
import os
import pathlib
import pwd
import subprocess
import urllib.request
from cryptography.hazmat.primitives import serialization,hashes
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from consumer import ORIGIN,REPO,validate_config

KEY=pathlib.Path('/etc/madar-sales-runner/runner-private.pem')
CONFIG=pathlib.Path('/etc/madar-v2-runner')
V2_KEY=CONFIG/'runner-private.pem'
UNIT=pathlib.Path('/etc/systemd/system/madar-v2-runner.service')

def render_service(repo=REPO):
    return f'''[Unit]
Description=Madar V2 queue on existing provisioning runner
After=network-online.target
Wants=network-online.target
[Service]
User=madar-sales-runner
Group=madar-sales-runner
WorkingDirectory={repo}
ExecStart=/opt/madar-sales-runner/venv/bin/python {repo}/v2/runner/consumer.py --config /etc/madar-v2-runner/runner.json
Restart=always
RestartSec=5
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadOnlyPaths=/etc/madar-v2-runner
[Install]
WantedBy=multi-user.target
'''

def decrypt(envelope,key):
    decode=lambda k:base64.b64decode(envelope[k],validate=True)
    aes=key.decrypt(decode('key'),padding.OAEP(mgf=padding.MGF1(hashes.SHA256()),algorithm=hashes.SHA256(),label=None))
    config=json.loads(AESGCM(aes).decrypt(decode('iv'),decode('data'),None))
    validate_config(config)
    if config.get('privateKeyPath')!=str(V2_KEY):raise ValueError('WRONG_LOCAL_KEY')
    return config

def main():
    if os.geteuid()!=0:raise ValueError('ROOT_REQUIRED')
    # Existing runner must be alive before attachment; this service is left unchanged.
    subprocess.run(['systemctl','is-active','--quiet','madar-sales-runner.service'],check=True)
    if KEY.is_symlink() or KEY.stat().st_mode&0o077:raise ValueError('KEY_PERMISSIONS')
    user=pwd.getpwnam('madar-sales-runner')
    key=serialization.load_pem_private_key(KEY.read_bytes(),password=None)
    req=urllib.request.Request(ORIGIN+'/api/runner/pair',headers={'User-Agent':'MadarV2/1'})
    with urllib.request.urlopen(req,timeout=20) as r:envelope=json.loads(r.read(16384))['envelope']
    config=decrypt(envelope,key)
    if UNIT.exists() and UNIT.read_text()!=render_service():raise ValueError('EXISTING_V2_UNIT')
    CONFIG.mkdir(mode=0o700,exist_ok=True)
    path=CONFIG/'runner.json'
    if CONFIG.is_symlink() or CONFIG.stat().st_mode&0o077:raise ValueError('CONFIG_PERMISSIONS')
    if path.exists() or V2_KEY.exists():raise ValueError('V2_ALREADY_CONFIGURED')
    # A read-only copy gives only the dedicated V2 service account access;
    # the original V1 private key and its permissions remain unchanged.
    key_fd=os.open(V2_KEY,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o400)
    with os.fdopen(key_fd,'wb') as f:f.write(KEY.read_bytes())
    os.chown(V2_KEY,user.pw_uid,user.pw_gid)
    config['privateKeyPath']=str(V2_KEY)
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w') as f:json.dump(config,f)
    for p in [CONFIG,path]:os.chown(p,user.pw_uid,user.pw_gid)
    UNIT.write_text(render_service());UNIT.chmod(0o644)
    subprocess.run(['systemctl','daemon-reload'],check=True)
    subprocess.run(['systemctl','enable','--now','madar-v2-runner.service'],check=True)
    for name in ['madar-sales-runner.service','madar-v2-runner.service']:
        subprocess.run(['systemctl','is-active','--quiet',name],check=True)
    subprocess.run(['systemctl','is-active','--quiet','madar-v2-runner.service'],check=True)
    print('V2_RUNNER_ATTACHED; V1 service and original key unchanged')

if __name__=='__main__':
    try:main()
    except Exception:raise SystemExit('V2_ATTACHMENT_FAILED; no credentials logged') from None
