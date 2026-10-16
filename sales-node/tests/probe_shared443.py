"""Local real-Xray bridge probe. All credentials and listeners are temporary."""
import http.server,json,pathlib,socket,subprocess,sys,tempfile,threading,time,uuid
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]))
from shared443 import build_frontend,backend_config,SharedFrontend
from stats import read_counters
from probe_live_stats import port,wait_tls

def main(binary):
    processes=[];received={'personal':0,'managed':0};threads=[]
    with tempfile.TemporaryDirectory() as td:
        base=pathlib.Path(td);tls,front,api,p_proxy,m_proxy,target=[port() for _ in range(6)]
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_GET(self):
                self.send_response(200);self.end_headers()
                try:
                    while True:self.wfile.write(b'x'*8192);self.wfile.flush();time.sleep(.03)
                except OSError:pass
        httpd=http.server.ThreadingHTTPServer(('127.0.0.1',target),Handler)
        threading.Thread(target=httpd.serve_forever,daemon=True).start()
        def start(name,config):
            config['log']={'loglevel':'debug'}
            file=base/(name+'.json');file.write_text(json.dumps(config))
            subprocess.run([binary,'run','-test','-c',str(file)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            p=subprocess.Popen([binary,'run','-c',str(file)],stdout=(base/(name+'.log')).open('w'),stderr=subprocess.STDOUT);processes.append(p);return p
        try:
            subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(base/'key'),'-out',str(base/'cert'),'-subj','/CN=probe.example','-days','1'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            processes.append(subprocess.Popen(['openssl','s_server','-accept',f'127.0.0.1:{tls}','-cert',str(base/'cert'),'-key',str(base/'key'),'-tls1_3','-alpn','h2','-www','-quiet'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL));wait_tls(tls)
            keys=subprocess.check_output([binary,'x25519'],text=True).splitlines();private=keys[0].split(': ',1)[1];public=keys[1].split(': ',1)[1]
            personal=str(uuid.uuid4());managed=str(uuid.uuid4());account=str(uuid.uuid4());sid='1234567890abcdef'
            source={'inbounds':[{'port':443,'listen':'127.0.0.1','protocol':'vless','settings':{'clients':[{'id':personal,'flow':'xtls-rprx-vision'}],'decryption':'none'},'streamSettings':{'network':'raw','security':'reality','realitySettings':{'dest':f'127.0.0.1:{tls}','serverNames':['probe.example'],'privateKey':private,'shortIds':[sid]}}}],'outbounds':[{'tag':'original','protocol':'freedom'}]}
            config,settings=build_frontend(source,'a'*64,ports=range(20000,20001),api_port=api);config['inbounds'][0]['port']=front
            fp=start('frontend',config)
            local=backend_config({**settings,'sni':'probe.example','privateKey':private,'shortId':sid},{'accountId':account,'uuid':managed,'listenPort':20000,'validUntil':int(time.time())+300},int(time.time()))
            local['routing']['rules']=[r for r in local['routing']['rules'] if 'ip' not in r]
            bp=start('backend',local)
            deadline=time.monotonic()+5
            while True:
                try:
                    with socket.create_connection(('127.0.0.1',api),timeout=.1):break
                except OSError:
                    if time.monotonic()>deadline:raise RuntimeError('API_NOT_READY')
                    time.sleep(.05)
            bridge=object.__new__(SharedFrontend);bridge.settings=settings;bridge.binary=binary;bridge.pid=fp.pid;bridge.current_pid=lambda:fp.pid if fp.poll() is None else 0
            client={'uuid':managed,'accountId':account,'listenPort':20000}
            bridge.add(client,base)
            for name,ident,proxy in [('personal',personal,p_proxy),('managed',managed,m_proxy)]:
                start(name,{'inbounds':[{'listen':'127.0.0.1','port':proxy,'protocol':'http'}],'outbounds':[{'protocol':'vless','settings':{'vnext':[{'address':'127.0.0.1','port':front,'users':[{'id':ident,'encryption':'none','flow':'xtls-rprx-vision' if name=='personal' else ''}]}]},'streamSettings':{'network':'tcp','security':'reality','realitySettings':{'serverName':'probe.example','fingerprint':'chrome','publicKey':public,'shortId':sid}}}]})
                def consume(n=name,p=proxy):
                    deadline=time.monotonic()+4
                    while True:
                        try:s=socket.create_connection(('127.0.0.1',p),timeout=1);break
                        except OSError:
                            if time.monotonic()>deadline:return
                            time.sleep(.05)
                    try:
                        with s:
                            s.settimeout(30);s.sendall(f'GET http://127.0.0.1:{target}/ HTTP/1.1\r\nHost: localhost\r\n\r\n'.encode())
                            while True:
                                data=s.recv(65536)
                                if not data:break
                                received[n]+=len(data)
                    except OSError:pass
                t=threading.Thread(target=consume,daemon=True);t.start();threads.append(t)
            deadline=time.monotonic()+30
            while min(received.values())<100000:
                if time.monotonic()>deadline:raise RuntimeError('SHARED_TRANSFER_FAILED '+str(received))
                time.sleep(.1)
            counters=read_counters('127.0.0.1:21000',[account],binary);assert counters[account]>0
            bp.terminate();bp.wait(timeout=2);bridge.remove(client);time.sleep(.3)
            old=dict(received);time.sleep(.4)
            assert received['managed']==old['managed'],'managed stream still flowing'
            assert received['personal']>old['personal'],'personal stream interrupted'
            assert fp.poll() is None
            print(json.dumps({'result':'PASS','sharedRealityFrontend':True,'personalSurvivesManagedCutoff':True,'managedCounterPositive':True}))
        except Exception:
            for log in base.glob('*.log'):
                value=log.read_text()[-3000:]
                for secret in (private,public,personal,managed,account):value=value.replace(secret,'[redacted]')
                print(log.name,value)
            raise
        finally:
            for p in reversed(processes):
                if p.poll() is None:p.terminate()
            for p in processes:p.wait(timeout=5)
            httpd.shutdown();httpd.server_close()
if __name__=='__main__':main(sys.argv[1])
