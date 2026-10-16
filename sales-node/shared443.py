"""Share one REALITY 443 frontend while isolating managed traffic behind loopback workers."""
import copy, hashlib, hmac, json, os, pathlib, subprocess, uuid
from xray import render_config, atomic_write

API_TAG='madar-shared-api'

def bridge_uuid(key,port):
    if len(key)!=64 or not 20000<=port<=20999:raise ValueError('INVALID_BRIDGE')
    return str(uuid.UUID(bytes=hmac.new(bytes.fromhex(key),str(port).encode(),hashlib.sha256).digest()[:16],version=4))

def build_frontend(original,key,*,ports=range(20000,21000),api_port=19999):
    conf=copy.deepcopy(original)
    candidates=[i for i in conf.get('inbounds',[]) if i.get('port')==443 and i.get('protocol')=='vless' and i.get('streamSettings',{}).get('security')=='reality']
    if len(candidates)!=1 or not conf.get('outbounds') or conf.get('api'):raise ValueError('UNSUPPORTED_FRONTEND')
    if any(str(i.get('tag','')).startswith('madar-') for i in conf.get('inbounds',[])+conf.get('outbounds',[])):raise ValueError('RESERVED_TAG_CONFLICT')
    inbound=candidates[0]
    if any(str(c.get('email','')).startswith('madar-') for c in inbound.get('settings',{}).get('clients',[])):raise ValueError('RESERVED_USER_CONFLICT')
    # Untagged legacy inbounds are valid. Assign a tag without changing clients.
    tag=inbound.setdefault('tag','madar-shared-vless')
    if not tag:raise ValueError('UNTAGGED_FRONTEND')
    conf['api']={'tag':API_TAG,'services':['HandlerService']}
    conf.setdefault('inbounds',[]).append({'tag':API_TAG,'listen':'127.0.0.1','port':api_port,'protocol':'dokodemo-door','settings':{'address':'127.0.0.1'}})
    rules=[{'type':'field','inboundTag':[API_TAG],'outboundTag':API_TAG}]
    for port in ports:
        ident=bridge_uuid(key,port);name=f'madar-{port}'
        conf.setdefault('outbounds',[]).append({'tag':name,'protocol':'vless','settings':{'vnext':[{'address':'127.0.0.1','port':port,'users':[{'id':ident,'encryption':'none','flow':''}]}]},'streamSettings':{'network':'tcp','security':'none'},'mux':{'enabled':False}})
        rules.append({'type':'field','inboundTag':[tag],'user':[name],'outboundTag':name})
    routing=conf.setdefault('routing',{});routing['rules']=rules+routing.get('rules',[])
    return conf,{'bridgeKey':key,'frontendTag':tag,'frontendApi':f'127.0.0.1:{api_port}'}

def build_fresh_frontend(settings,*,ports=range(20000,21000),api_port=19999):
    if settings.get('port',443)!=443 or not settings.get('bridgeKey'):raise ValueError('INVALID_FRESH_FRONTEND')
    original=render_config({**settings,'port':443},[],0)
    frontend,shared=build_frontend(original,settings['bridgeKey'],ports=ports,api_port=api_port)
    return frontend,{**settings,**shared}

def backend_config(settings,client,now):
    local={**client,'uuid':bridge_uuid(settings['bridgeKey'],client['listenPort'])}
    conf=render_config({**settings,'port':client['listenPort'],'statsPort':client['listenPort']+1000},[local],now)
    inbound=conf['inbounds'][0];inbound['listen']='127.0.0.1';inbound['streamSettings']={'network':'tcp','security':'none'}
    conf['routing']['rules'][-1]['ip']=['0.0.0.0/8','10.0.0.0/8','127.0.0.0/8','169.254.0.0/16','172.16.0.0/12','192.168.0.0/16','::1/128','fc00::/7','fe80::/10']
    return conf

class SharedFrontend:
    def __init__(self,settings,binary):
        self.settings=settings;self.binary=binary
        self.pid=self.current_pid()
    def current_pid(self):
        service=self.settings.get('frontendService','xray.service')
        result=subprocess.run(['systemctl','show',service,'--property=MainPID','--value'],capture_output=True,text=True,check=True,timeout=2)
        pid=int(result.stdout.strip())
        if pid<=0:raise ValueError('FRONTEND_NOT_RUNNING')
        # PID reuse cannot conceal a restart.
        return (pid,pathlib.Path(f'/proc/{pid}/stat').read_text().rsplit(')',1)[1].split()[19])
    def check(self):
        if self.current_pid()!=self.pid:raise ValueError('FRONTEND_RESTARTED')
    def add(self,client,base):
        self.check()
        path=pathlib.Path(base)/(client['accountId']+'.frontend.json')
        atomic_write(path,{'inbounds':[{'tag':self.settings['frontendTag'],'port':443,'protocol':'vless','settings':{'decryption':'none','clients':[{'id':client['uuid'],'email':f"madar-{client['listenPort']}",'flow':'','level':0}]}}]})
        try:
            result=subprocess.run([self.binary,'api','adu','--server='+self.settings['frontendApi'],'-timeout','1',str(path)],check=True,capture_output=True,text=True,timeout=2)
            if 'Added 1 user(s) in total.' not in result.stdout:raise ValueError('FRONTEND_USER_NOT_ADDED')
        finally:path.unlink(missing_ok=True)
    def remove(self,client):
        subprocess.run([self.binary,'api','rmu','--server='+self.settings['frontendApi'],'-timeout','1','-tag='+self.settings['frontendTag'],f"madar-{client['listenPort']}"],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=2)

def start_owned_frontend(settings,binary,base):
    if settings.get('shared443') is not True or settings.get('frontendManaged') is not True:raise ValueError('FRONTEND_NOT_OWNED')
    base=pathlib.Path(base);base.mkdir(parents=True,exist_ok=True)
    frontend,runtime=build_fresh_frontend(settings)
    config_path=base/'xray.json';authorization=base/'authorization.json'
    # Remove prior startup authorization before changing the candidate so a failed test cannot authorize a restart.
    authorization.unlink(missing_ok=True)
    atomic_write(config_path,frontend)
    subprocess.run([binary,'run','-test','-c',str(config_path)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=15)
    atomic_write(authorization,{'mode':'shared-frontend','nodeId':settings['nodeId']})
    service=runtime.get('frontendService','madar-sales-xray.service')
    subprocess.run(['systemctl','restart',service],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=15)
    return SharedFrontend(runtime,binary)
