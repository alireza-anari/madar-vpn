"""Real-Xray acceptance for a fresh zero-user REALITY frontend with one managed bridge."""
import http.server,json,pathlib,socket,subprocess,sys,tempfile,threading,time,uuid
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]))
from shared443 import build_fresh_frontend,backend_config,SharedFrontend
from stats import read_counters
from probe_live_stats import port,wait_tls

def main(binary):
    processes=[];received=[0]
    with tempfile.TemporaryDirectory() as td:
        base=pathlib.Path(td);tls,front,api,proxy,target=[port() for _ in range(5)]
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
            file=base/(name+'.json');file.write_text(json.dumps(config))
            subprocess.run([binary,'run','-test','-c',str(file)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            p=subprocess.Popen([binary,'run','-c',str(file)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);processes.append(p);return p
        private=public=managed=account=''
        try:
            subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(base/'key'),'-out',str(base/'cert'),'-subj','/CN=probe.example','-days','1'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            processes.append(subprocess.Popen(['openssl','s_server','-accept',f'127.0.0.1:{tls}','-cert',str(base/'cert'),'-key',str(base/'key'),'-tls1_3','-alpn','h2','-www','-quiet'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL));wait_tls(tls)
            keys=subprocess.check_output([binary,'x25519'],text=True).splitlines();private=keys[0].split(': ',1)[1];public=keys[1].split(': ',1)[1]
            managed=str(uuid.uuid4());account=str(uuid.uuid4());sid='1234567890abcdef'
            settings={'nodeId':'probe','bridgeKey':'a'*64,'sni':'probe.example','privateKey':private,'shortId':sid,'port':443,'frontendManaged':True,'frontendService':'madar-sales-xray.service'}
            config,runtime=build_fresh_frontend(settings,ports=range(20000,20001),api_port=api)
            public_inbound=next(i for i in config['inbounds'] if i.get('port')==443)
            assert public_inbound['settings']['clients']==[]
            public_inbound['port']=front;public_inbound['streamSettings']['realitySettings']['dest']=f'127.0.0.1:{tls}'
            fp=start('fresh-frontend',config)
            local=backend_config(runtime,{'accountId':account,'uuid':managed,'listenPort':20000,'validUntil':int(time.time())+300},int(time.time()))
            local['routing']['rules']=[r for r in local['routing']['rules'] if 'ip' not in r]
            bp=start('backend',local)
            deadline=time.monotonic()+5
            while True:
                try:
                    with socket.create_connection(('127.0.0.1',api),timeout=.1):break
                except OSError:
                    if time.monotonic()>deadline:raise RuntimeError('API_NOT_READY')
                    time.sleep(.05)
            bridge=object.__new__(SharedFrontend);bridge.settings=runtime;bridge.binary=binary;bridge.pid=fp.pid;bridge.current_pid=lambda:fp.pid if fp.poll() is None else 0
            client={'uuid':managed,'accountId':account,'listenPort':20000};bridge.add(client,base)
            cp=start('client',{'inbounds':[{'listen':'127.0.0.1','port':proxy,'protocol':'http'}],'outbounds':[{'protocol':'vless','settings':{'vnext':[{'address':'127.0.0.1','port':front,'users':[{'id':managed,'encryption':'none','flow':''}]}]},'streamSettings':{'network':'tcp','security':'reality','realitySettings':{'serverName':'probe.example','fingerprint':'chrome','publicKey':public,'shortId':sid}}}]})
            def consume():
                deadline=time.monotonic()+5
                while True:
                    try:s=socket.create_connection(('127.0.0.1',proxy),timeout=1);break
                    except OSError:
                        if time.monotonic()>deadline:return
                        time.sleep(.05)
                try:
                    with s:
                        s.settimeout(20);s.sendall(f'GET http://127.0.0.1:{target}/ HTTP/1.1\r\nHost: localhost\r\n\r\n'.encode())
                        while True:
                            data=s.recv(65536)
                            if not data:break
                            received[0]+=len(data)
                except OSError:pass
            thread=threading.Thread(target=consume,daemon=True);thread.start()
            deadline=time.monotonic()+20
            while received[0]<100000:
                if time.monotonic()>deadline:raise RuntimeError('FRESH_SHARED_TRANSFER_FAILED')
                time.sleep(.1)
            counters=read_counters('127.0.0.1:21000',[account],binary);assert counters[account]>0
            bp.terminate();bp.wait(timeout=2);bridge.remove(client);before=received[0];time.sleep(.4)
            assert received[0]==before and fp.poll() is None and cp.poll() is None
            print(json.dumps({'result':'PASS','freshZeroUserFrontend':True,'dynamicManagedUser':True,'managedCounterPositive':True,'frontendSurvivesCutoff':True}))
        finally:
            for p in reversed(processes):
                if p.poll() is None:p.terminate()
            for p in processes:p.wait(timeout=5)
            httpd.shutdown();httpd.server_close()
if __name__=='__main__':main(sys.argv[1])
