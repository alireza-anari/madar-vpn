"""Explicit adoption of this owner's Personal instance. Run only after a verified backup.

Source downloads are pinned by commit and manifest. No SSH, firewall, or Xray unit
changes. An armed rollback timer restores the frontend unless the owner confirms.
"""
import argparse,base64,hashlib,json,os,pathlib,re,secrets,shutil,socket,subprocess,sys,tempfile,time,urllib.request
ROOT=pathlib.Path('/opt/madar-sales-node')
ETC=pathlib.Path('/etc/madar-sales-node')
FRONT=pathlib.Path('/usr/local/etc/xray/config.json')
BASE='https://madar-sales-bot.alirezaanari117.workers.dev'
INSTANCE='i-002a965e30ef88b2f'
CREATED=False
REGISTERED=False
FILES=['agent.py','policy.py','xray.py','guard.py','stats.py','quota.py','quota_runtime.py','shared443.py']

def validate_identity(ident):
    if ident!=INSTANCE:raise ValueError('WRONG_INSTANCE')

def validate_sources(files,manifest):
    if not files or any(manifest.get(name)!=hashlib.sha256(data).hexdigest() for name,data in files.items()):raise ValueError('SOURCE_CHECKSUM_MISMATCH')

def fetch(url,*,method='GET',headers=None,data=None,limit=1048576):
    req=urllib.request.Request(url,method=method,headers={'User-Agent':'MadarSales/0.2',**(headers or {})},data=data)
    with urllib.request.urlopen(req,timeout=15) as response:
        value=response.read(limit+1)
        if len(value)>limit:raise ValueError('RESPONSE_TOO_LARGE')
        return value

def run(args,**kw):return subprocess.run(args,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=15,**kw)

def replace_config(path,data):
    path=pathlib.Path(path)
    if path.is_symlink():raise ValueError('CONFIG_SYMLINK')
    stat=path.stat();fd,name=tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd,'wb') as stream:stream.write(data);stream.flush();os.fsync(stream.fileno())
        os.chown(name,stat.st_uid,stat.st_gid);shutil.copystat(path,name);os.replace(name,path)
    finally:
        if os.path.exists(name):os.unlink(name)

def prepare_candidate(source,data):
    source=pathlib.Path(source);target=source.with_name('madar-candidate.json')
    if target.exists() or target.is_symlink():raise ValueError('CANDIDATE_FILE_EXISTS')
    stat=source.stat()
    try:
        shutil.copy2(source,target)
        # copy2 preserves mode/xattrs, but explicitly does NOT preserve owner/group.
        os.chown(target,stat.st_uid,stat.st_gid)
        replace_config(target,data)
        return target
    except Exception:
        target.unlink(missing_ok=True);raise

def private_json(path,value):
    path=pathlib.Path(path);path.write_text(json.dumps(value));path.chmod(0o600)

def rollback_program(backup,stat):
    return '''import json,os,pathlib,subprocess,sys,tempfile,time
pending=pathlib.Path('/opt/madar-sales-node/adoption-deadline.json')
if '--force' not in sys.argv:
 if not pending.exists():raise SystemExit(0)
 if int(time.time())<json.loads(pending.read_text())['expiresAt']:raise SystemExit(0)
subprocess.run(['systemctl','stop','madar-sales-node.service','madar-sales-watchdog.timer'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
subprocess.run(['systemctl','disable','madar-sales-node.service','madar-sales-watchdog.timer'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
p=pathlib.Path('/usr/local/etc/xray/config.json');data=pathlib.Path(%r).read_bytes()
fd,name=tempfile.mkstemp(dir=p.parent)
try:
 with os.fdopen(fd,'wb') as out:out.write(data);out.flush();os.fsync(out.fileno())
 os.chown(name,%d,%d);os.chmod(name,%d);os.replace(name,p)
finally:
 if os.path.exists(name):os.unlink(name)
subprocess.run(['systemctl','restart','xray.service'],check=True)
pending.unlink(missing_ok=True)
subprocess.run(['systemctl','disable','--now','madar-personal-rollback.timer'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
print('PERSONAL_RESTORED')
'''%(str(backup),stat.st_uid,stat.st_gid,stat.st_mode&0o777)

def main():
    global CREATED,REGISTERED
    p=argparse.ArgumentParser();p.add_argument('--source-ref',required=True);p.add_argument('--manifest-sha256',required=True);p.add_argument('--grant',required=True);args=p.parse_args()
    if os.geteuid()!=0:raise ValueError('ROOT_REQUIRED')
    if not re.fullmatch('[a-f0-9]{40}',args.source_ref) or not re.fullmatch('[a-f0-9]{64}',args.manifest_sha256) or not re.fullmatch('[a-f0-9]{64}',args.grant):raise ValueError('INVALID_ARGUMENT')
    token=fetch('http://169.254.169.254/latest/api/token',method='PUT',headers={'X-aws-ec2-metadata-token-ttl-seconds':'60'}).decode()
    headers={'X-aws-ec2-metadata-token':token}
    validate_identity(fetch('http://169.254.169.254/latest/meta-data/instance-id',headers=headers).decode())
    public_ip=fetch('http://169.254.169.254/latest/meta-data/public-ipv4',headers=headers).decode().strip()
    if ROOT.exists() or ETC.exists():raise ValueError('ALREADY_STAGED_DO_NOT_REINSTALL')
    if FRONT.is_symlink():raise ValueError('CONFIG_SYMLINK')
    run(['systemctl','is-active','--quiet','xray.service'])
    binary='/usr/local/bin/xray'
    version=subprocess.check_output([binary,'version'],text=True,timeout=5)
    if not version.startswith('Xray 26.3.27 '):raise ValueError('UNSUPPORTED_XRAY_VERSION')
    unit=subprocess.check_output(['systemctl','show','xray.service','--property=ExecStart','--value'],text=True,timeout=5)
    if 'argv[]=/usr/local/bin/xray run -c /usr/local/etc/xray/config.json ;' not in unit:raise ValueError('UNSUPPORTED_SERVICE_COMMAND')
    for name in ('madar-sales-node.service','madar-sales-watchdog.service','madar-sales-watchdog.timer','madar-personal-rollback.service','madar-personal-rollback.timer'):
        if (pathlib.Path('/etc/systemd/system')/name).exists():raise ValueError('SERVICE_ALREADY_EXISTS')
    original=FRONT.read_bytes();conf=json.loads(original)
    for port in range(19999,22000):
        with socket.socket() as probe:
            try:probe.bind(('127.0.0.1',port))
            except OSError:raise ValueError('LOCAL_PORT_CONFLICT')
    source=f'https://raw.githubusercontent.com/alireza-anari/madar-vpn/{args.source_ref}/sales-node/'
    raw=fetch(source+'personal-source-manifest.json')
    if hashlib.sha256(raw).hexdigest()!=args.manifest_sha256:raise ValueError('MANIFEST_CHECKSUM_MISMATCH')
    manifest=json.loads(raw);files={name:fetch(source+name) for name in FILES};validate_sources(files,manifest)
    # Preparation does not alter the running frontend or its unit.
    ROOT.mkdir(mode=0o700);CREATED=True;ETC.mkdir(mode=0o700)
    for name,data in files.items():(ROOT/name).write_bytes(data)
    shutil.copy2(binary,ROOT/'xray');(ROOT/'xray').chmod(0o700)
    sys.path.insert(0,str(ROOT));from shared443 import build_frontend
    from quota import QuotaStore
    frontend,shared=build_frontend(conf,secrets.token_hex(32))
    inbound=next(i for i in conf['inbounds'] if i.get('port')==443)
    reality=inbound['streamSettings']['realitySettings'];sni=reality['serverNames'][0]
    sid=next((v for v in reality['shortIds'] if re.fullmatch(r'(?:[a-f0-9]{2}){1,8}',v)),None)
    if not sid:raise ValueError('SUPPORTED_EXISTING_SHORT_ID_REQUIRED')
    key=base64.urlsafe_b64decode(reality['privateKey']+'=')
    if len(key)!=32:raise ValueError('INVALID_EXISTING_KEY')
    public=subprocess.check_output(['openssl','pkey','-inform','DER','-pubout','-outform','DER'],input=bytes.fromhex('302e020100300506032b656e04220420')+key,stderr=subprocess.DEVNULL,timeout=5)[-32:]
    config={**shared,'baseUrl':BASE,'protocolVersion':2,'shared443':True,'nodeId':'','nodeToken':secrets.token_urlsafe(32),'policyKey':secrets.token_hex(32),'privateKey':reality['privateKey'],'publicKey':base64.urlsafe_b64encode(public).decode().rstrip('='),'shortId':sid,'sni':sni,'port':443}
    private_json(ETC/'config.json',config)
    candidate=ROOT/'frontend.json';private_json(candidate,frontend)
    # Test under existing service user, with a temporary file readable by that user.
    check=prepare_candidate(FRONT,json.dumps(frontend).encode())
    try:
        try:run(['runuser','-u','xray','--','test','-r',str(check)])
        except subprocess.CalledProcessError:raise ValueError('CANDIDATE_NOT_READABLE_BY_XRAY') from None
        try:run(['runuser','-u','xray','--',binary,'run','-test','-c',str(check)])
        except subprocess.CalledProcessError:raise ValueError('CANDIDATE_CONFIG_TEST_FAILED') from None
    finally:check.unlink(missing_ok=True)
    register={'publicIp':public_ip,'nodeToken':config['nodeToken'],'policyKey':config['policyKey'],'publicKey':config['publicKey'],'shortId':sid,'sni':sni,'instanceId':INSTANCE}
    result=json.loads(fetch(BASE+'/api/adoption/register',method='POST',headers={'Authorization':'Bearer '+args.grant,'Content-Type':'application/json'},data=json.dumps(register).encode()))
    REGISTERED=True
    config['nodeId']=result['nodeId'];private_json(ETC/'config.json',config)
    QuotaStore(pathlib.Path('/var/lib/madar-sales-node/quota.sqlite')).close()
    private_json(ROOT/'manifest.json',{'jobId':config['nodeId'],'nodeId':config['nodeId'],'version':'personal-shared443','quotaInitialized':True,'sourceRef':args.source_ref})
    backup=pathlib.Path('/root')/('madar-personal-adoption-'+time.strftime('%Y%m%d-%H%M%S'));backup.mkdir(mode=0o700)
    shutil.copy2(FRONT,backup/'config.json');stat=FRONT.stat()
    rollback=ROOT/'rollback-personal.py'
    deadline=ROOT/'adoption-deadline.json';private_json(deadline,{'expiresAt':int(time.time())+600})
    rollback.write_text(rollback_program(backup/'config.json',stat));rollback.chmod(0o700)
    confirm=ROOT/'confirm-personal.sh';confirm.write_text('#!/bin/bash\nset -eu\nsystemctl is-active --quiet xray.service madar-sales-node.service\nrm -f /opt/madar-sales-node/adoption-deadline.json\nsystemctl disable --now madar-personal-rollback.timer\necho PERSONAL_ADOPTION_CONFIRMED\n');confirm.chmod(0o700)
    unit='''[Unit]
Description=Madar Sales Node Agent (shared existing443)
After=network-online.target xray.service
Wants=network-online.target
[Service]
Type=simple
WorkingDirectory=/opt/madar-sales-node
ExecStart=/usr/bin/python3 /opt/madar-sales-node/agent.py
Restart=always
RestartSec=5
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
[Install]
WantedBy=multi-user.target
'''
    watchdog='''[Unit]
Description=Check Madar quota meter
[Service]
Type=oneshot
ExecStart=/usr/bin/python3 /opt/madar-sales-node/agent.py --watchdog
'''
    timer='''[Unit]
Description=Check Madar quota meter every second
[Timer]
OnBootSec=1
OnUnitActiveSec=1
AccuracySec=1
Unit=madar-sales-watchdog.service
[Install]
WantedBy=timers.target
'''
    for name,data in [('madar-sales-node.service',unit),('madar-sales-watchdog.service',watchdog),('madar-sales-watchdog.timer',timer)]:
        path=pathlib.Path('/etc/systemd/system')/name
        if path.exists():raise ValueError('SERVICE_ALREADY_EXISTS')
        path.write_text(data);path.chmod(0o644)
    (pathlib.Path('/etc/systemd/system')/'madar-personal-rollback.service').write_text('[Unit]\nDescription=Restore unconfirmed Personal adoption\n[Service]\nType=oneshot\nExecStart=/usr/bin/python3 /opt/madar-sales-node/rollback-personal.py\n')
    (pathlib.Path('/etc/systemd/system')/'madar-personal-rollback.timer').write_text('[Unit]\nDescription=Check persistent Personal adoption deadline\n[Timer]\nOnBootSec=15s\nOnUnitActiveSec=15s\nAccuracySec=1s\nUnit=madar-personal-rollback.service\n[Install]\nWantedBy=timers.target\n')
    run(['systemctl','daemon-reload'])
    run(['systemctl','enable','--now','madar-personal-rollback.timer'])
    try:
        replace_config(FRONT,json.dumps(frontend).encode())
        run(['systemctl','restart','xray.service'])
        run(['systemctl','is-active','--quiet','xray.service'])
        run(['systemctl','enable','--now','madar-sales-node.service','madar-sales-watchdog.timer'])
        print('PERSONAL_STAGED: original credentials preserved; rollback armed for 10 minutes.')
        print('After verifying your existing Personal connection, run: sudo /opt/madar-sales-node/confirm-personal.sh')
    except Exception:
        run(['/usr/bin/python3',str(rollback),'--force']);raise

if __name__=='__main__':
    try:main()
    except Exception as error:
        # Never print exception messages containing a request URL, key or config.
        if CREATED and not REGISTERED:
            shutil.rmtree(ROOT,ignore_errors=True);shutil.rmtree(ETC,ignore_errors=True)
        code=str(error) if isinstance(error,ValueError) and re.fullmatch('[A-Z_]+',str(error)) else type(error).__name__
        print('PERSONAL_ADOPTION_FAILED:',code);sys.exit(1)
