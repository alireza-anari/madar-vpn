import json,os,pathlib,socket,subprocess,tempfile

def render_config(settings,clients,now):
    quota=any('accountId' in c for c in clients)
    config={'log':{'loglevel':'none'},'inbounds':[{'listen':'0.0.0.0','port':settings.get('port',443),'protocol':'vless','settings':{'clients':[dict({'id':c['uuid'],'flow':'' if quota else 'xtls-rprx-vision'},**({'email':c['accountId'],'level':0} if quota else {})) for c in clients if c['validUntil']>now],'decryption':'none'},'streamSettings':{'network':'tcp','security':'reality','realitySettings':{'show':False,'dest':settings['sni']+':443','xver':0,'serverNames':[settings['sni']],'privateKey':settings['privateKey'],'shortIds':[settings['shortId']]}}}],'outbounds':[{'protocol':'freedom','tag':'direct'},{'protocol':'blackhole','tag':'blocked'}],'routing':{'rules':[{'type':'field','ip':['geoip:private'],'outboundTag':'blocked'}]}}
    if quota:
        config.update({'stats':{},'api':{'tag':'quota-api','services':['StatsService']},'policy':{'levels':{'0':{'statsUserUplink':True,'statsUserDownlink':True}}}})
        config['inbounds'].append({'listen':'127.0.0.1','port':settings.get('statsPort',10085),'protocol':'dokodemo-door','tag':'quota-api','settings':{'address':'127.0.0.1'}})
        config['routing']['rules'].insert(0,{'type':'field','inboundTag':['quota-api'],'outboundTag':'quota-api'})
    return config

def atomic_write(path,value):
    target=pathlib.Path(path);target.parent.mkdir(parents=True,exist_ok=True)
    fd,temp=tempfile.mkstemp(dir=target.parent)
    try:
        with os.fdopen(fd,'w') as stream:json.dump(value,stream);stream.flush();os.fsync(stream.fileno())
        os.chmod(temp,0o600);os.replace(temp,target)
    finally:
        if os.path.exists(temp):os.unlink(temp)

class Xray:
    def __init__(self,settings):self.settings=settings;self.base=pathlib.Path('/run/madar-sales-node');self.base.mkdir(parents=True,exist_ok=True);self.last_clients=None
    def stop(self):
        subprocess.run(['systemctl','stop','madar-sales-xray.service'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=15)
        self.last_clients=None
    def apply(self,policy,now):
        clients=[c for c in policy['clients'] if c['validUntil']>now]
        if not clients:self.stop();atomic_write(self.base/'authorization.json',{'expiresAt':policy['expiresAt'],'clients':[]});return True
        config=render_config(self.settings,clients,now)
        atomic_write(self.base/'candidate.json',config)
        subprocess.run(['/opt/madar-sales-node/xray','run','-test','-config',str(self.base/'candidate.json')],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=15)
        os.replace(self.base/'candidate.json',self.base/'xray.json')
        atomic_write(self.base/'authorization.json',{'expiresAt':min(policy['expiresAt'],min(c['validUntil'] for c in clients)),'clients':clients})
        if self.last_clients!=clients or not self.healthy():subprocess.run(['systemctl','restart','madar-sales-xray.service'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=15)
        self.last_clients=clients
        return self.healthy()
    def healthy(self):
        status=subprocess.run(['systemctl','is-active','--quiet','madar-sales-xray.service'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=5).returncode==0
        if not status:return False
        try:
            with socket.create_connection(('127.0.0.1',self.settings.get('port',443)),timeout=2):return True
        except OSError:return False
