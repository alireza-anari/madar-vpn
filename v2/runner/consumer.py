"""V2 queue consumer on the existing runner HOST; never runs a V1 installer.

Shares the reviewed V1 SSH transport, envelope decryptor and signed lease
client. Uses an independent V2 config/service/queue. The V1 private key stays
on its current host and is only referenced locally by the V2 service user.
"""
import argparse
import base64
import io
import json
import logging
import os
import pathlib
import re
import shlex
import sys
import tarfile
import threading
import time

REPO=pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0,str(REPO/'sales-runner'))
from runner import Api
from credential_envelope import decrypt_credentials
from ssh_transport import SshTransport,probe,assert_public_target
from cryptography.hazmat.primitives import serialization

ORIGIN='https://madar-v2-staging.alirezaanari117.workers.dev'
REMOTE=r'''
import fcntl,io,json,os,pathlib,sys,tarfile
job=json.loads(sys.argv[1])
os.umask(0o077)
lock=open('/run/lock/madar-v2-provision.lock','a')
fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
dest=pathlib.Path('/var/lib/madar-v2-jobs')/job['id']
dest.mkdir(parents=True,mode=0o700,exist_ok=False)
archive=tarfile.open(fileobj=io.BytesIO(sys.stdin.buffer.read(1048576)),mode='r:')
for member in archive.getmembers():
    if not member.isfile() or not member.name.startswith('agent/') or len(pathlib.PurePosixPath(member.name).parts)!=2 or not member.name.endswith('.py') or member.size>65536:
        raise ValueError('INVALID_PACKAGE')
    target=dest/member.name
    target.parent.mkdir(mode=0o700,exist_ok=True)
    target.write_bytes(archive.extractfile(member).read())
sys.path.insert(0,str(dest))
if job['mode']=='aria-cutover':
    from agent.dual_reality import migrate
    migrate(job['nodeId'],job['targetIp'],apply=True)
else:
    from agent.bootstrap import plan_node,install_test_node
    from agent.fresh_dual import enable
    install_test_node(plan_node(node_id=job['nodeId'],public_ip=job['targetIp'],reality_port=8443,wss_domain=None,ws_path='/madar-ws',reality_target='www.cloudflare.com'))
    enable(job['nodeId'],job['targetIp'])
from agent.dual_reality import listening
if not (listening(443) and listening(8443)):raise ValueError('LISTENERS_FAILED')
root=pathlib.Path('/etc/madar-v2')
m=json.loads((root/'public-route-metadata.json').read_text())
s=json.loads((root/'local-secrets.json').read_text())
print(json.dumps(dict(public_key=m['reality_public_key'],short_id=m['short_id'],server_name=m['reality_server_name'],uuid=s['clients'][0])))
'''

def validate_job(job):
    assert_public_target(job.get('targetIp',''))
    if (not re.fullmatch(r'[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}',job.get('id','')) or
        not re.fullmatch(r'test-[A-Za-z0-9_-]{2,55}',job.get('nodeId','')) or
        type(job.get('port')) is not int or not 1<=job['port']<=65535 or
        not re.fullmatch(r'[a-z_][a-z0-9_-]{0,31}',job.get('username','')) or
        job.get('kind') not in ('probe','v2-install')):
        raise ValueError('INVALID_V2_JOB')
    if job['targetIp']=='86.54.42.66':
        if (job['nodeId'],job.get('mode'))!=('test-aria01','aria-cutover'):raise ValueError('INVALID_V2_JOB')
    elif job.get('mode')!='fresh':raise ValueError('INVALID_V2_JOB')

def install(transport,job,check):
    validate_job(job)
    buffer=io.BytesIO()
    with tarfile.open(fileobj=buffer,mode='w:') as archive:
        for path in sorted((REPO/'v2/node-agent/agent').glob('*.py')):
            data=path.read_bytes();info=tarfile.TarInfo('agent/'+path.name);info.size=len(data);info.mode=0o600
            archive.addfile(info,io.BytesIO(data))
    # The remote command never contains credentials, only fixed source and validated metadata.
    fields={k:job[k] for k in ('id','nodeId','targetIp','mode')}
    code=base64.b64encode(REMOTE.encode()).decode()
    command='sudo -n python3 -c '+shlex.quote('import base64;exec(base64.b64decode('+repr(code)+'))')+' '+shlex.quote(json.dumps(fields))
    check();out=transport.run(command,buffer.getvalue(),timeout=600);check()
    result=json.loads(out)
    if set(result)!={'public_key','short_id','server_name','uuid'}:raise ValueError('INVALID_METADATA')
    return result

def run_job(job,api,private_key,clock=time.time):
    stop=threading.Event();lost=threading.Event();credentials={}
    def post(path,**extra):return api.post(path,dict(id=job['id'],leaseId=job['leaseId'],**extra))
    def check():
        if lost.is_set():raise ValueError('LEASE_EXPIRED')
    def renew():
        while not stop.wait(20):
            try:post('renew')
            except Exception:lost.set();return
    thread=threading.Thread(target=renew,daemon=True);thread.start()
    try:
        validate_job(job)
        if job['credentialsExpireAt']<=int(clock()):raise ValueError('EXPIRED')
        if job['kind']=='probe':
            fp=probe(job['targetIp'],job['port']);check()
            post('report',state='ready',details={'fingerprint':fp});return 'ready'
        credentials=decrypt_credentials(job['encryptedCredentials'],private_key,int(clock()),job['credentialsExpireAt'])
        job['encryptedCredentials']=None
        with SshTransport(job['targetIp'],job['port'],job['username'],job['hostFingerprint'],credentials) as transport:
            details=install(transport,job,check);check()
        post('report',state='ready',details=details);return 'ready'
    except Exception:
        try:post('report',state='failed',safeCode='INSTALLATION_FAILED')
        except Exception:pass
        return 'failed'
    finally:
        credentials.clear();job['encryptedCredentials']=None;stop.set();thread.join(timeout=1)

def validate_config(config):
    if config.get('baseUrl')!=ORIGIN or not re.fullmatch(r'[A-Za-z0-9_-]{3,64}',config.get('runnerId','')) or len(config.get('serviceSecret',''))<32:
        raise ValueError('V2_CONFIG_REQUIRED')

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--config',required=True);args=parser.parse_args()
    path=pathlib.Path(args.config)
    if path.stat().st_mode&0o077:raise ValueError('CONFIG_PERMISSIONS')
    config=json.loads(path.read_text());validate_config(config)
    key=pathlib.Path(config['privateKeyPath'])
    if key.stat().st_mode&0o077:raise ValueError('KEY_PERMISSIONS')
    private=serialization.load_pem_private_key(key.read_bytes(),password=None)
    api=Api(config['baseUrl'],config['serviceSecret']);logging.getLogger('paramiko').disabled=True
    while True:
        try:
            job=api.lease(config['runnerId'])
            if job:run_job(job,api,private)
        except Exception:pass
        time.sleep(3)

if __name__=='__main__':main()
