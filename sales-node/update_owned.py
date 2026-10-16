"""Checksum-pinned owned-node upgrade. No SSH credentials, firewall or foreign services."""
import argparse,hashlib,json,os,pathlib,re,subprocess,sys,tempfile,urllib.request
FILES={'agent.py','policy.py','xray.py','guard.py','stats.py','quota.py','quota_runtime.py','shared443.py','update_owned.py'}

def validate_owned_update(root,etc,node_id):
    try:
        if root.is_symlink() or etc.is_symlink():raise ValueError()
        manifest=json.loads((root/'manifest.json').read_text());config=json.loads((etc/'config.json').read_text())
        if manifest['nodeId']!=node_id or config['nodeId']!=node_id or not manifest.get('jobId'):raise ValueError()
        if not all(config.get(k) for k in ('privateKey','nodeToken','policyKey')):raise ValueError()
        return config
    except Exception:raise ValueError('OWNERSHIP_MISMATCH') from None

def fetch(url):
    with urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'MadarSales/0.1'}),timeout=20) as r:
        data=r.read(1048577)
        if len(data)>1048576:raise ValueError('SOURCE_TOO_LARGE')
        return data

def preflight_quota_ports(root,config):
    import socket
    owned=set()
    if config.get('protocolVersion')==2:
        group=subprocess.run(['systemctl','show','madar-sales-node.service','--property=ControlGroup','--value'],check=True,capture_output=True,text=True,timeout=5).stdout.strip()
        if not group.startswith('/'):raise ValueError('UNIT_OWNERSHIP_MISMATCH')
        listeners=subprocess.run(['ss','-H','-ltnp'],check=True,capture_output=True,text=True,timeout=5).stdout
        for line in listeners.splitlines():
            fields=line.split()
            if len(fields)<5:continue
            try:port=int(fields[3].rsplit(':',1)[1])
            except (ValueError,IndexError):continue
            if not 20000<=port<22000:continue
            pids=set(re.findall(r'pid=(\d+)',line))
            if not pids:raise ValueError('QUOTA_PORT_CONFLICT')
            for pid in pids:
                executable=pathlib.Path('/proc/'+pid+'/exe').resolve()
                groups=pathlib.Path('/proc/'+pid+'/cgroup').read_text().splitlines()
                if executable!=(root/'xray').resolve() or not any(v.rsplit(':',1)[-1]==group or v.rsplit(':',1)[-1].startswith(group+'/') for v in groups):raise ValueError('QUOTA_PORT_CONFLICT')
            owned.add(port)
    for port in range(20000,22000):
        if port in owned:continue
        with socket.socket() as check:
            try:check.bind(('0.0.0.0' if port<21000 else '127.0.0.1',port))
            except OSError:raise ValueError('QUOTA_PORT_CONFLICT')

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--node-id',required=True);parser.add_argument('--source-ref',required=True);parser.add_argument('--manifest-sha256',required=True);parser.add_argument('--enable-quota',action='store_true');args=parser.parse_args()
    if os.getuid()!=0:raise ValueError('ROOT_REQUIRED')
    if not re.fullmatch('[a-f0-9]{40}',args.source_ref) or not re.fullmatch('[a-f0-9]{64}',args.manifest_sha256):raise ValueError('INVALID_SOURCE')
    root=pathlib.Path('/opt/madar-sales-node');etc=pathlib.Path('/etc/madar-sales-node');config=validate_owned_update(root,etc,args.node_id)
    unit=pathlib.Path('/etc/systemd/system/madar-sales-node.service').read_text()
    if 'ExecStart=/usr/bin/python3 /opt/madar-sales-node/agent.py' not in unit:raise ValueError('UNIT_OWNERSHIP_MISMATCH')
    state=pathlib.Path('/var/lib/madar-sales-node');database=state/'quota.sqlite'
    if config.get('protocolVersion')==2 and not database.is_file():raise ValueError('QUOTA_STATE_MISSING')
    base='https://raw.githubusercontent.com/alireza-anari/madar-vpn/'+args.source_ref+'/sales-node/'
    manifest=fetch(base+'source-manifest.json')
    if hashlib.sha256(manifest).hexdigest()!=args.manifest_sha256:raise ValueError('MANIFEST_CHECKSUM_MISMATCH')
    hashes=json.loads(manifest)
    if set(hashes)!=FILES:raise ValueError('INVALID_SOURCE_MANIFEST')
    files={name:fetch(base+name) for name in FILES}
    for name,data in files.items():
        if hashlib.sha256(data).hexdigest()!=hashes[name]:raise ValueError('SOURCE_CHECKSUM_MISMATCH')
        compile(data,name,'exec')
    # Reject foreign listeners before any service side effect. Owned v2 listeners are verified by executable and unit cgroup.
    if args.enable_quota:preflight_quota_ports(root,config)
    subprocess.run(['systemctl','stop','madar-sales-node.service'],check=True,timeout=20)
    for name,data in files.items():
        target=root/name;temp=target.with_name(name+'.updating');temp.write_bytes(data);temp.chmod(0o644);os.replace(temp,target)
    if args.enable_quota:
        if config.get('protocolVersion')!=2:
            sys.path.insert(0,str(root));from quota import QuotaStore
            QuotaStore(database).close()
        config['protocolVersion']=2
        target=etc/'config.json';temp=etc/'config.json.updating';temp.write_text(json.dumps(config));temp.chmod(0o600);os.replace(temp,target)
    owner=json.loads((root/'manifest.json').read_text());owner['sourceRef']=args.source_ref
    if config.get('protocolVersion')==2:owner['quotaInitialized']=True
    temp=root/'manifest.json.updating';temp.write_text(json.dumps(owner));temp.chmod(0o600);os.replace(temp,root/'manifest.json')
    pathlib.Path('/run/madar-sales-node/quota-heartbeat.json').unlink(missing_ok=True)
    subprocess.run(['systemctl','start','madar-sales-node.service'],check=True,timeout=20)
    print('OWNED_UPDATE_INSTALLED')
if __name__=='__main__':
    try:main()
    except Exception as e:
        # Never print exception contents containing configuration, tokens or URLs.
        print('UPDATE_FAILED:'+type(e).__name__);raise SystemExit(1)
