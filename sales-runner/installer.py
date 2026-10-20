"""Install only our namespaced files; never alter SSH, firewall or existing services."""
import base64,io,json,pathlib,secrets,tarfile
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
from cryptography.hazmat.primitives import serialization
from artifacts import download,verify_artifact,VERSION
BASE=pathlib.Path(__file__).resolve().parent
DEFAULT_REALITY_SNI='www.cloudflare.com'
PREFLIGHT=r'''
import json,pathlib,os,shutil,socket,subprocess,re
release={}
for line in pathlib.Path('/etc/os-release').read_text().splitlines():
 if '=' in line:
  k,v=line.split('=',1);release[k]=v.strip('"')
owner=None
try:owner=json.loads(pathlib.Path('/opt/madar-sales-node/manifest.json').read_text())
except Exception:pass
units=subprocess.run(['systemctl','list-unit-files','--no-legend','--no-pager'],capture_output=True,text=True,check=True).stdout
conflict=any(line.split()[0].startswith(('madar-','xray','v2ray','sing-box')) and not line.split()[0].startswith('madar-sales-') for line in units.splitlines() if line.split())
conflict=conflict or any(pathlib.Path(p).exists() for p in ['/etc/xray','/usr/local/etc/xray','/etc/madar-node-agent','/usr/local/bin/xray'])
sock=socket.socket();busy=False
try:sock.bind(('0.0.0.0',443))
except OSError:busy=True
finally:sock.close()
port_owned=False
if busy and owner:
 try:
  pid=int(subprocess.run(['systemctl','show','madar-sales-xray.service','--property=MainPID','--value'],capture_output=True,text=True,check=True).stdout.strip())
  listeners=subprocess.run(['ss','-H','-ltnp','sport = :443'],capture_output=True,text=True,check=True).stdout.splitlines()
  port_owned=pid>0 and pathlib.Path('/proc/'+str(pid)+'/exe').resolve()==pathlib.Path('/opt/madar-sales-node/xray') and bool(listeners) and all(set(re.findall(r'pid=(\d+)',line))=={str(pid)} for line in listeners)
 except Exception:pass
quota_busy=False
for port in range(20000,22000):
 with socket.socket() as probe:
  try:probe.bind(('0.0.0.0' if port<21000 else '127.0.0.1',port))
  except OSError:quota_busy=True;break
print(json.dumps({'quotaPortsBusy':quota_busy,'os':release.get('ID'),'version':release.get('VERSION_ID'),'arch':os.uname().machine,'root':os.getuid()==0,'disk':shutil.disk_usage('/opt').free,'conflict':conflict,'portBusy':busy,'portOwned':port_owned,'owner':owner}))
'''
APPLY=r'''
import io,json,pathlib,sys,tarfile,os,subprocess
job_id=sys.argv[1]
root=pathlib.Path('/opt/madar-sales-node');etc=pathlib.Path('/etc/madar-sales-node')
allowed={'manifest.json','config.json','xray','geoip.dat','geosite.dat','agent.py','policy.py','xray.py','guard.py','stats.py','quota.py','quota_runtime.py','shared443.py','update_owned.py','recovery_guard.py','madar-sales-recovery.service','madar-sales-recovery.timer','madar-sales-node.service','madar-sales-xray.service','madar-sales-watchdog.service','madar-sales-watchdog.timer'}
if root.exists():
 try:owner=json.loads((root/'manifest.json').read_text())
 except Exception:raise SystemExit(2)
 if owner.get('jobId')!=job_id:raise SystemExit(2)
was_quota_initialized=bool(root.exists() and owner.get('quotaInitialized')) if 'owner' in locals() else False
if was_quota_initialized and not pathlib.Path('/var/lib/madar-sales-node/quota.sqlite').is_file():raise SystemExit(4)
root.mkdir(mode=0o700,exist_ok=True);etc.mkdir(mode=0o700,exist_ok=True)
archive=tarfile.open(fileobj=io.BytesIO(sys.stdin.buffer.read(120*1024*1024)),mode='r:')
entries={}
for member in archive.getmembers():
 if not member.isfile() or member.name not in allowed or member.size>100*1024*1024:raise SystemExit(3)
 entries[member.name]=archive.extractfile(member).read()
manifest=json.loads(entries['manifest.json'])
if manifest['jobId']!=job_id:raise SystemExit(3)
if was_quota_initialized:
 manifest['quotaInitialized']=True;entries['manifest.json']=json.dumps(manifest).encode()
# Manifest first makes interrupted installation reconcilable and protects other ownership.
ordered=['manifest.json']+[k for k in entries if k!='manifest.json']
for name in ordered:
 target=etc/'config.json' if name=='config.json' else pathlib.Path('/etc/systemd/system')/name if name.endswith(('.service','.timer')) else root/name
 if name=='config.json' and target.exists():continue
 if name=='xray' and target.exists() and target.read_bytes()==entries[name]:continue
 temp=target.with_name(target.name+'.installing');temp.write_bytes(entries[name]);os.chmod(temp,0o755 if name=='xray' else 0o600 if name in ('config.json','manifest.json') else 0o644);os.replace(temp,target)
config_path=etc/'config.json'
if config_path.exists() and json.loads(config_path.read_text()).get('protocolVersion')==2:
 state=pathlib.Path('/var/lib/madar-sales-node/quota.sqlite')
 if was_quota_initialized and not state.is_file():raise SystemExit(4)
 sys.path.insert(0,str(root));from quota import QuotaStore
 QuotaStore(state).close()
 manifest['quotaInitialized']=True
 temp=root/'manifest.json.installing';temp.write_text(json.dumps(manifest));temp.chmod(0o600);os.replace(temp,root/'manifest.json')
subprocess.run(['systemctl','daemon-reload'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
subprocess.run(['systemctl','enable','--now','madar-sales-node.service','madar-sales-watchdog.timer','madar-sales-recovery.timer'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
print('INSTALLED')
'''
def root_command(script,job_id=None):
    # Script is developer-owned; variable job ID strictly hex UUID. Credentials never in argv.
    import re
    if job_id is not None and not re.fullmatch(r'[a-f0-9-]{36}',job_id):raise ValueError('INVALID_JOB')
    encoded=base64.b64encode(script.encode()).decode()
    return "sudo -n python3 -c \"import base64;exec(base64.b64decode('"+encoded+"'))\""+(' '+job_id if job_id else '')

def owned_recovery(owner,job_id,node_id):return isinstance(owner,dict) and owner.get('jobId')==job_id and owner.get('nodeId')==node_id

def validate_preflight(info,job_id):
    if info['os']!='ubuntu' or info['version'] not in ('22.04','24.04'):raise ValueError('UNSUPPORTED_UBUNTU')
    if not info['root']:raise ValueError('SUDO_REQUIRED')
    if info['disk']<512*1024*1024:raise ValueError('INSUFFICIENT_DISK')
    owned=isinstance(info.get('owner'),dict) and info['owner'].get('jobId')==job_id
    if info['conflict'] or info.get('owner') and not owned:raise ValueError('EXISTING_SERVICE')
    if info['portBusy'] and not (owned and info.get('portOwned') is True):raise ValueError('PORT_CONFLICT')
    return {**info,'owned':owned}

def preflight(transport,job_id):
    try:info=json.loads(transport.run(root_command(PREFLIGHT)))
    except Exception:raise ValueError('SUDO_REQUIRED') from None
    return validate_preflight(info,job_id)

def package(files):
    out=io.BytesIO()
    with tarfile.open(fileobj=out,mode='w') as archive:
        for name,data in files.items():
            member=tarfile.TarInfo(name);member.size=len(data);member.mode=0o600;archive.addfile(member,io.BytesIO(data))
    return out.getvalue()

def configure_protocol(config,job):
    version=job.get('protocolVersion',1)
    if type(version) is not int or version not in (1,2):raise ValueError('INVALID_PROTOCOL_VERSION')
    if version==2:
        return {**config,'protocolVersion':2,'shared443':True,'frontendManaged':True,'frontendService':'madar-sales-xray.service','bridgeKey':config['policyKey'],'port':443}
    return config

def validate_protocol_recovery(config,version):
    if version==2 and (config.get('protocolVersion')!=2 or config.get('shared443') is not True):raise ValueError('PROTOCOL_UPGRADE_REQUIRED')
    return config

def install(transport,job,api,check=lambda:None):
    info=preflight(transport,job['id']);check()
    if info['owned']:
        config=json.loads(transport.run(root_command("import pathlib; p=pathlib.Path('/etc/madar-sales-node/config.json');print(p.read_text() if p.exists() else 'null')")))
        if config is not None and config['nodeId']!=job['nodeId']:raise ValueError('EXISTING_SERVICE')
    else:config=None
    if config is not None:validate_protocol_recovery(config,job.get('protocolVersion',1))
    if config is None:
        private=X25519PrivateKey.generate();encode=lambda data:base64.urlsafe_b64encode(data).decode().rstrip('=')
        config={'baseUrl':api.base,'nodeId':job['nodeId'],'nodeToken':secrets.token_urlsafe(32),'policyKey':secrets.token_hex(32),'privateKey':encode(private.private_bytes(serialization.Encoding.Raw,serialization.PrivateFormat.Raw,serialization.NoEncryption())),'publicKey':encode(private.public_key().public_bytes(serialization.Encoding.Raw,serialization.PublicFormat.Raw)),'shortId':secrets.token_hex(8),'sni':DEFAULT_REALITY_SNI,'port':443}
    config=configure_protocol(config,job)
    if config.get('protocolVersion')==2 and info.get('quotaPortsBusy'):raise ValueError('PORT_CONFLICT')
    files=download(info['arch'],job['artifactVersion']);check()
    for name in ['agent.py','policy.py','xray.py','guard.py','stats.py','quota.py','quota_runtime.py','shared443.py','update_owned.py','recovery_guard.py']:files[name]=(BASE.parent/'sales-node'/name).read_bytes()
    for path in (BASE/'templates').iterdir():files[path.name]=path.read_bytes()
    files['config.json']=json.dumps(config).encode();files['manifest.json']=json.dumps({'jobId':job['id'],'nodeId':job['nodeId'],'version':VERSION}).encode()
    api.post('register',{'id':job['id'],'leaseId':job['leaseId'],'nodeToken':config['nodeToken'],'policyKey':config['policyKey'],'publicKey':config['publicKey'],'shortId':config['shortId'],'sni':config['sni']})
    api.post('report',{'id':job['id'],'leaseId':job['leaseId'],'state':'installing','safeCode':'INSTALLING'})
    check();transport.run(root_command(APPLY,job['id']),package(files),timeout=120);check()
    api.post('report',{'id':job['id'],'leaseId':job['leaseId'],'state':'verifying','safeCode':'VERIFYING'})
    transport.run('sudo -n systemctl is-active --quiet madar-sales-node.service madar-sales-watchdog.timer',timeout=10)
    return {'installed':True}

ROLLBACK=r'''
import json,pathlib,shutil,subprocess,sys
root=pathlib.Path('/opt/madar-sales-node');owner=json.loads((root/'manifest.json').read_text())
if owner.get('jobId')!=sys.argv[1]:raise SystemExit(2)
units=['madar-sales-node.service','madar-sales-xray.service','madar-sales-watchdog.timer','madar-sales-watchdog.service']
subprocess.run(['systemctl','stop',*units],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
subprocess.run(['systemctl','disable','madar-sales-node.service','madar-sales-watchdog.timer'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
for unit in units:
 p=pathlib.Path('/etc/systemd/system')/unit
 if p.exists():p.unlink()
for p in ['/run/madar-sales-node','/etc/madar-sales-node','/opt/madar-sales-node']:
 if pathlib.Path(p).is_dir():shutil.rmtree(p)
subprocess.run(['systemctl','daemon-reload'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
'''
def rollback(transport,job_id):return transport.run(root_command(ROLLBACK,job_id),timeout=30)
