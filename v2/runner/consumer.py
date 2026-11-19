"""V2 queue consumer on the existing runner HOST; never runs a V1 installer.

Shares the reviewed V1 SSH transport, envelope decryptor and signed lease
client. Uses an independent V2 config/service/queue. The V1 private key stays
on its current host and is only referenced locally by the V2 service user.
"""
import argparse
import errno
import socket
import paramiko
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
import textwrap

REPO=pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0,str(REPO/'sales-runner'))
from runner import Api
from credential_envelope import decrypt_credentials
from ssh_transport import SshTransport,probe,assert_public_target
from aws_network import ensure_network
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
    trusted_code=(member.name.startswith('agent/') and
        len(pathlib.PurePosixPath(member.name).parts)==2 and
        member.name.endswith('.py') and member.size<=65536)
    trusted_key=(member.name=='secrets/node.key' and member.size<=96)
    if not member.isfile() or not (trusted_code or trusted_key):
        raise ValueError('INVALID_PACKAGE')
    target=dest/member.name
    target.parent.mkdir(mode=0o700,exist_ok=True)
    with target.open('xb') as file:
        os.fchmod(file.fileno(),0o600)
        file.write(archive.extractfile(member).read())
sys.path.insert(0,str(dest))
from agent.bootstrap import plan_node,install_test_node
from agent.fresh_dual import enable
if job['mode']!='fresh':raise ValueError('FRESH_NODES_ONLY')
stage='REMOTE_BOOTSTRAP_FAILED'
install_test_node(plan_node(node_id=job['nodeId'],public_ip=job['targetIp'],reality_port=8443,wss_domain=None,ws_path='/madar-ws',reality_target='www.cloudflare.com'))
stage='REMOTE_DUAL_FAILED'
enable(job['nodeId'],job['targetIp'])
from agent.dual_reality import listening
if not (listening(443) and listening(8443)):raise ValueError('LISTENERS_FAILED')
if (dest/'secrets/node.key').exists():
    stage='REMOTE_AGENT_FAILED'
    from agent.runtime_install import install_node_runtime
    install_node_runtime(job['nodeId'],dest/'secrets/node.key',dest/'agent')
stage='REMOTE_METADATA_FAILED'
root=pathlib.Path('/etc/madar-v2')
m=json.loads((root/'public-route-metadata.json').read_text())
s=json.loads((root/'local-secrets.json').read_text())
print(json.dumps(dict(public_key=m['reality_public_key'],short_id=m['short_id'],server_name=m['reality_server_name'],uuid=s['clients'][0])))
'''

# Return only a fixed stage code; raw errors may contain configuration secrets.
REMOTE="import json\nstage='REMOTE_PACKAGE_FAILED'\ntry:\n"+textwrap.indent(REMOTE,'    ')+"\nexcept Exception:\n    print(json.dumps({'error':stage}))\n"
REMOTE_FAILURE_CODES=frozenset({'REMOTE_PACKAGE_FAILED','REMOTE_BOOTSTRAP_FAILED',
    'REMOTE_DUAL_FAILED','REMOTE_METADATA_FAILED','REMOTE_AGENT_FAILED'})


class RemoteInstallError(ValueError):
    pass


# Fixed, read-only diagnostic. No shell input, file writes or installs.
REMOTE_DIAG=r'''
import json,os,pathlib,platform,socket,urllib.request,urllib.error
code='DIAG_PRECHECK_OK'
paths=('/etc/systemd/system/xray.service','/etc/systemd/system/caddy.service',
'/etc/systemd/system/madar-v2-xray.service','/etc/systemd/system/madar-v2-caddy.service',
'/etc/xray','/usr/local/etc/xray','/etc/caddy','/etc/madar-v2','/opt/madar-v2')
try:
 if os.geteuid()!=0:code='DIAG_NO_ROOT'
 elif platform.system()!='Linux':code='DIAG_UNSUPPORTED_OS'
 else:
  release=pathlib.Path('/etc/os-release').read_text(encoding='utf-8')
  rows=[x.split('=',1)[1].strip('" ') for x in release.splitlines() if x.startswith('ID=')]
  if not rows or rows[0] not in ('ubuntu','debian'):code='DIAG_UNSUPPORTED_OS'
  elif any(pathlib.Path(p).exists() or pathlib.Path(p).is_symlink() for p in paths):
   code='DIAG_EXISTING_VPN'
  elif not pathlib.Path('/usr/bin/systemctl').is_file() or not pathlib.Path('/usr/sbin/useradd').is_file():
   code='DIAG_SYSTEMD_MISSING'
  else:
   for port in (443,8443):
    with socket.socket(socket.AF_INET,socket.SOCK_STREAM) as sock:
     try:sock.bind(('0.0.0.0',port))
     except OSError:
      code='DIAG_PORT_443_BUSY' if port==443 else 'DIAG_PORT_8443_BUSY'
      break
   if code=='DIAG_PRECHECK_OK':
    url='https://github.com/XTLS/Xray-core/releases/download/v26.11.9/Xray-linux-64.zip'
    request=urllib.request.Request(url,method='HEAD',headers={'User-Agent':'Madar-V2-ReadOnly-Diagnostic/1'})
    try:
     with urllib.request.urlopen(request,timeout=12) as response:
      if response.status!=200:code='DIAG_GITHUB_UNREACHABLE'
    except (urllib.error.URLError,TimeoutError,OSError):
     code='DIAG_GITHUB_UNREACHABLE'
except Exception:
 code='DIAG_REMOTE_FAILED'
print(json.dumps({'code':code},separators=(',',':')))
'''
REMOTE_RUNTIME_DIAG=r'''
import json,os,pathlib,stat,subprocess,tempfile
def write_unit(path,text,mode):
 fd,name=tempfile.mkstemp(prefix='.madar-runtime-',dir=path.parent)
 try:
  with os.fdopen(fd,'w',encoding='utf-8') as out:
   os.fchmod(out.fileno(),mode)
   out.write(text)
   out.flush()
   os.fsync(out.fileno())
  os.replace(name,path)
 finally:
  pathlib.Path(name).unlink(missing_ok=True)
def remove_legacy_dependency(unit):
 path=pathlib.Path('/etc/systemd/system')/unit
 info=path.lstat()
 if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or info.st_mode&0o022 or info.st_size>8192:
  raise OSError('Unexpected Madar unit file')
 text=path.read_text(encoding='utf-8')
 legacy='After=network-online.target madar-v2-xray.service\nRequires=madar-v2-xray.service\n'
 if legacy not in text:return
 if ('Description=Madar V2 isolated node quota and client reconciler\n' not in text or
     'ExecStart=/usr/bin/python3 -m agent.runtime ' not in text or text.count(legacy)!=1):
  raise OSError('Unexpected Madar unit content')
 mode=stat.S_IMODE(info.st_mode)
 write_unit(path,text.replace(legacy,'After=network-online.target\n'),mode)
 try:
  subprocess.run(['/usr/bin/systemctl','daemon-reload'],timeout=8,check=True)
 except (OSError,subprocess.SubprocessError):
  write_unit(path,text,mode)
  subprocess.run(['/usr/bin/systemctl','daemon-reload'],timeout=8,check=True)
  raise
def active(unit):
 return subprocess.run(['/usr/bin/systemctl','is-active','--quiet',unit],timeout=5).returncode==0
runtime='madar-v2-runtime.service'
code='DIAG_RUNTIME_ACTIVE'
try:
 if not active(runtime):
  code='DIAG_RUNTIME_DOWN'
  if START_RUNTIME:
   remove_legacy_dependency(runtime)
   result=subprocess.run(['/usr/bin/systemctl','start',runtime],timeout=18)
   code='DIAG_RUNTIME_STARTED' if result.returncode==0 and active(runtime) else 'DIAG_RUNTIME_START_FAILED'
 else:
  log=subprocess.run(['/usr/bin/journalctl','-u',runtime,'--since','5 minutes ago','-n','100','--no-pager','-o','cat'],capture_output=True,text=True,timeout=8,check=True).stdout
  faults=[line for line in log.splitlines() if line.startswith(('MADAR_RUNTIME_FAULT','MADAR_REMOTE_ERROR'))]
  if faults:
   last=faults[-1]
   code='DIAG_RUNTIME_GENERATION' if ('XRAY_GENERATION_MISMATCH' in last or 'unrecognized Xray process generation' in last) else 'DIAG_RUNTIME_ERROR'
  elif not active('madar-v2-xray.service'):code='DIAG_XRAY_DOWN'
except (OSError,subprocess.SubprocessError):
 code='DIAG_REMOTE_FAILED'
print(json.dumps({'code':code},separators=(',',':')))
'''
DIAG_CODES=frozenset({'DIAG_EXISTING_VPN','DIAG_PORT_443_BUSY','DIAG_PORT_8443_BUSY',
    'DIAG_UNSUPPORTED_OS','DIAG_NO_ROOT','DIAG_SYSTEMD_MISSING','DIAG_GITHUB_UNREACHABLE',
    'DIAG_PRECHECK_OK','DIAG_REMOTE_FAILED','DIAG_RUNTIME_ACTIVE','DIAG_RUNTIME_DOWN',
    'DIAG_XRAY_DOWN','DIAG_RUNTIME_GENERATION','DIAG_RUNTIME_ERROR',
    'DIAG_RUNTIME_STARTED','DIAG_RUNTIME_START_FAILED'})
def diagnose(transport,check,runtime=False,start=False):
    # SSH command only runs a fixed Python snippet; no user-provided shell text.
    script=('START_RUNTIME = '+repr(start)+'\n'+REMOTE_RUNTIME_DIAG) if runtime else REMOTE_DIAG
    code=base64.b64encode(script.encode()).decode()
    cmd='sudo -n python3 -c '+shlex.quote('import base64;exec(base64.b64decode('+repr(code)+'))')
    check()
    out=transport.run(cmd,timeout=50 if runtime and start else 35)
    check()
    result=json.loads(out)
    if not isinstance(result,dict) or set(result)!={'code'} or result['code'] not in DIAG_CODES:
        raise ValueError('BAD_DIAGNOSTIC_RESPONSE')
    return result['code']

def validate_job(job):
    assert_public_target(job.get('targetIp',''))
    if (not re.fullmatch(r'[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}',job.get('id','')) or
        not re.fullmatch(r'[A-Za-z][A-Za-z0-9_-]{2,63}',job.get('nodeId','')) or
        re.match(r'^(?:prod(?:uction)?(?:[-_0-9]|$)|main(?:[-_0-9]|$)|node1$|madar-v2-node1$)',job.get('nodeId',''),re.I) or
        type(job.get('port')) is not int or not 1<=job['port']<=65535 or
        not re.fullmatch(r'[a-z_][a-z0-9_-]{0,31}',job.get('username','')) or
        job.get('kind') not in ('probe','v2-install')):
        raise ValueError('INVALID_V2_JOB')
    if job.get('mode')!='fresh':raise ValueError('INVALID_V2_JOB')

def install(transport,job,check,node_key=None):
    validate_job(job)
    buffer=io.BytesIO()
    with tarfile.open(fileobj=buffer,mode='w:') as archive:
        for path in sorted((REPO/'v2/node-agent/agent').glob('*.py')):
            data=path.read_bytes();info=tarfile.TarInfo('agent/'+path.name);info.size=len(data);info.mode=0o600
            archive.addfile(info,io.BytesIO(data))
        if node_key is not None:
            if not isinstance(node_key,str) or not re.fullmatch(r'[A-Za-z0-9_-]{43}',node_key):
                raise ValueError('INVALID_NODE_KEY')
            data=(node_key+'\n').encode('ascii')
            info=tarfile.TarInfo('secrets/node.key')
            info.size=len(data);info.mode=0o600
            archive.addfile(info,io.BytesIO(data))
    # The remote command never contains credentials, only fixed source and validated metadata.
    fields={k:job[k] for k in ('id','nodeId','targetIp','mode')}
    code=base64.b64encode(REMOTE.encode()).decode()
    command='sudo -n python3 -c '+shlex.quote('import base64;exec(base64.b64decode('+repr(code)+'))')+' '+shlex.quote(json.dumps(fields))
    check();out=transport.run(command,buffer.getvalue(),timeout=600);check()
    result=json.loads(out)
    if isinstance(result,dict) and set(result)=={'error'} and result['error'] in REMOTE_FAILURE_CODES:
        raise RemoteInstallError(result['error'])
    if set(result)!={'public_key','short_id','server_name','uuid'}:raise ValueError('INVALID_METADATA')
    return result

# Staging-only scoped cleanup. The remote helper independently checks the
# V2 owner identity and refuses any installed Xray commercial UUID/usage.
REMOTE_RESET=r'''
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
from agent.owned_reset import reset
# An outright read-only rejection MUST NOT quarantine a working node.
# Distinguish it from any exception after destructive work has started.
try:
 reset(job['nodeId'],job['targetIp'],apply=False)
except Exception:
 print(json.dumps({'status':'RESET_PREFLIGHT_BLOCKED'}))
 sys.exit(0)
status=reset(job['nodeId'],job['targetIp'],apply=True)
print(json.dumps({'status':status}))
'''
REMOTE_RESET="import json\nstage='RESET_REMOTE_FAILED'\ntry:\n"+textwrap.indent(REMOTE_RESET,'    ')+"\nexcept Exception:\n    print(json.dumps({'error':'RESET_BLOCKED'}))\n"

class RemoteCleanupError(ValueError):
    pass

def cleanup_node(transport,job,check):
    validate_job(job)
    if job.get('cleanup') is not True or job.get('diagnostic') is True:
        raise RemoteCleanupError('RESET_BLOCKED')
    buffer=io.BytesIO()
    with tarfile.open(fileobj=buffer,mode='w:') as archive:
        for path in sorted((REPO/'v2/node-agent/agent').glob('*.py')):
            data=path.read_bytes()
            info=tarfile.TarInfo('agent/'+path.name)
            info.size=len(data);info.mode=0o600
            archive.addfile(info,io.BytesIO(data))
    fields={k:job[k] for k in ('id','nodeId','targetIp')}
    code=base64.b64encode(REMOTE_RESET.encode()).decode()
    command='sudo -n python3 -c '+shlex.quote('import base64;exec(base64.b64decode('+repr(code)+'))')+' '+shlex.quote(json.dumps(fields))
    check();out=transport.run(command,buffer.getvalue(),timeout=180);check()
    try:result=json.loads(out)
    except (TypeError,ValueError):raise RemoteCleanupError('RESET_BLOCKED') from None
    if result=={'status':'RESET_PREFLIGHT_BLOCKED'}:
        raise RemoteCleanupError('RESET_PREFLIGHT_BLOCKED')
    if result!={'status':'RESET_COMPLETED'}:
        raise RemoteCleanupError('RESET_BLOCKED')
    return {'status':'RESET_COMPLETED'}

def safe_failure_code(exc,kind,stage='unknown'):
    """Only bounded, non-sensitive error codes leave the GitHub executor."""
    if isinstance(exc,(TimeoutError,socket.timeout)) or (isinstance(exc,OSError) and exc.errno==errno.ETIMEDOUT):
        return 'SSH_TIMEOUT'
    if isinstance(exc,ConnectionRefusedError) or (isinstance(exc,OSError) and exc.errno==errno.ECONNREFUSED):
        return 'SSH_REFUSED'
    if isinstance(exc,OSError) and exc.errno in (errno.EHOSTUNREACH,errno.ENETUNREACH):
        return 'SSH_UNREACHABLE'
    if kind=='probe':
        if isinstance(exc,paramiko.SSHException):return 'SSH_HANDSHAKE_FAILED'
        if isinstance(exc,ValueError) and str(exc)=='EXPIRED':return 'PROBE_EXPIRED'
        return 'SSH_PROBE_FAILED'
    if kind=='v2-install':
        if isinstance(exc,RemoteCleanupError):
            return 'RESET_PREFLIGHT_BLOCKED' if str(exc)=='RESET_PREFLIGHT_BLOCKED' else 'RESET_BLOCKED'
        if stage=='cleanup':return 'RESET_CLEANUP_FAILED'
        if isinstance(exc,RemoteInstallError) and str(exc) in REMOTE_FAILURE_CODES:
            return str(exc)
        if isinstance(exc,paramiko.AuthenticationException) or (
                isinstance(exc,ValueError) and str(exc)=='SSH_AUTH_FAILED'):
            return 'SSH_AUTH_FAILED'
        if isinstance(exc,ValueError) and str(exc)=='HOST_KEY_CHANGED':
            return 'HOST_KEY_CHANGED'
        if isinstance(exc,ValueError) and str(exc)=='INVALID_SSH_KEY':
            return 'INVALID_SSH_KEY'
        if isinstance(exc,ValueError) and str(exc)=='EXPIRED':
            return 'CREDENTIALS_EXPIRED'
        if stage=='diagnostic':return 'DIAG_REMOTE_FAILED'
        if stage=='credentials':return 'CREDENTIAL_DECRYPT_FAILED'
        if stage=='ssh':return 'SSH_LOGIN_FAILED'
        if stage=='remote':return 'REMOTE_INSTALL_FAILED'
        if stage=='report':return 'INSTALL_REPORT_FAILED'
    return 'INSTALLATION_FAILED'

def run_job(job,api,private_key,clock=time.time,network_mode='aws'):
    stop=threading.Event();lost=threading.Event();credentials={};stage='validate'
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
        if network_mode=='aws':ensure_network(job['targetIp'],job['port'])
        check()
        if job['kind']=='probe':
            fp=probe(job['targetIp'],job['port']);check()
            post('report',state='ready',details={'fingerprint':fp});return 'ready'
        stage='credentials'
        credentials=decrypt_credentials(job['encryptedCredentials'],private_key,int(clock()),job['credentialsExpireAt'])
        job['encryptedCredentials']=None
        stage='ssh'
        with SshTransport(job['targetIp'],job['port'],job['username'],job['hostFingerprint'],credentials) as transport:
            if job.get('cleanup') is True:
                stage='cleanup'
                cleanup_node(transport,job,check);check()
                stage='report'
                post('report',state='ready',safeCode='RESET_COMPLETED')
                return 'ready'
            if job.get('diagnostic') is True:
                stage='diagnostic'
                result_code=diagnose(transport,check,runtime=job.get('runtimeDiagnostic') is True,
                    start=job.get('startRuntime') is True)
                stage='report'
                post('report',state='ready',safeCode=result_code)
                return 'ready'
            stage='remote'
            node_key=None
            if job.get('enableRuntime') is True:
                # The runner already has the short-lived lease; never fetch
                # the master key or place the node secret in CLI arguments.
                reply=post('node-key',nodeId=job['nodeId'])
                if not isinstance(reply,dict) or not re.fullmatch(
                    r'[A-Za-z0-9_-]{43}',reply.get('nodeKey','')):
                    raise ValueError('NODE_PAIRING_FAILED')
                if reply.get('origin')!=ORIGIN:
                    raise ValueError('NODE_PAIRING_FAILED')
                node_key=reply['nodeKey']
            details=install(transport,job,check,node_key=node_key);check()
            node_key=None
        # Additional VPN exposure is allowed only after fresh-host preflight and installation.
        if job['mode']=='fresh' and network_mode=='aws':ensure_network(job['targetIp'],job['port'],extra_tcp_ports=(8443,))
        check()
        stage='report'
        post('report',state='ready',details=details);return 'ready'
    except Exception as exc:
        code=safe_failure_code(exc,job.get('kind'),stage)
        # Never log raw SSH errors, credentials, command output or server details.
        if job.get('kind')=='v2-install':
            print('V2_INSTALL_SAFE_ERROR: '+code,flush=True)
        try:post('report',state='failed',safeCode=code)
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
