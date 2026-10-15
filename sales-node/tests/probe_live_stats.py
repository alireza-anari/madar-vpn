"""Real pinned Xray open-stream probe; test keys/configs remain temporary."""
import argparse,json,pathlib,socket,subprocess,sys,tempfile,threading,time,uuid
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]))
from stats import read_counters

def port():
    with socket.socket() as s:s.bind(('127.0.0.1',0));return s.getsockname()[1]
def wait_tls(port,context=None):
    import ssl
    context=context or ssl._create_unverified_context();deadline=time.monotonic()+5
    while True:
        try:
            with context.wrap_socket(socket.create_connection(('127.0.0.1',port),timeout=.3),server_hostname='probe.example') as connection:
                if connection.version()!='TLSv1.3':raise ValueError('TLS13_REQUIRED')
                return
        except OSError:
            if time.monotonic()>=deadline:raise RuntimeError('TLS_DESTINATION_NOT_READY') from None
            time.sleep(.05)

def main(binary):
    processes=[]
    with tempfile.TemporaryDirectory() as td:
        base=pathlib.Path(td);tls,server,api,proxy,download=([int(sys.argv[2])+i for i in range(5)] if len(sys.argv)>2 else [port() for _ in range(5)])
        if len({tls,server,api,proxy,download})!=5:raise RuntimeError("PROBE_PORT_COLLISION")
        subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(base/'key.pem'),'-out',str(base/'cert.pem'),'-subj','/CN=probe.example','-days','1'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=True)
        keylines=subprocess.check_output([binary,'x25519'],text=True).splitlines();private=keylines[0].split(': ',1)[1];public=keylines[1].split(': ',1)[1]
        ident=str(uuid.uuid4());sid='1234567890abcdef'
        serverconfig={'log':{'loglevel':'debug'},'stats':{},'api':{'tag':'api','services':['StatsService']},'policy':{'levels':{'0':{'statsUserUplink':True,'statsUserDownlink':True}}},'inbounds':[{'listen':'127.0.0.1','port':server,'protocol':'vless','settings':{'clients':[{'id':ident,'email':'probe','level':0,'flow':''}],'decryption':'none'},'streamSettings':{'network':'tcp','security':'reality','realitySettings':{'dest':f'127.0.0.1:{tls}','serverNames':['probe.example'],'privateKey':private,'shortIds':[sid]}}},{'listen':'127.0.0.1','port':api,'protocol':'dokodemo-door','tag':'api','settings':{'address':'127.0.0.1'}}],'outbounds':[{'protocol':'freedom'}],'routing':{'rules':[{'type':'field','inboundTag':['api'],'outboundTag':'api'}]}}
        clientconfig={'log':{'loglevel':'debug'},'inbounds':[{'listen':'127.0.0.1','port':proxy,'protocol':'http'}],'outbounds':[{'protocol':'vless','settings':{'vnext':[{'address':'127.0.0.1','port':server,'users':[{'id':ident,'encryption':'none','flow':''}]}]},'streamSettings':{'network':'tcp','security':'reality','realitySettings':{'serverName':'probe.example','fingerprint':'chrome','publicKey':public,'shortId':sid}}}]}
        listener=socket.socket();listener.bind(('127.0.0.1',download));listener.listen();stop=threading.Event();received=[0]
        def serve():
            conn,_=listener.accept()
            try:
                conn.recv(4096);conn.sendall(b'HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\n\r\n')
                while not stop.is_set():conn.sendall(b'x'*32768);time.sleep(.02)
            except OSError:pass
            finally:conn.close()
        def consume():
            try:
                with socket.create_connection(('127.0.0.1',proxy)) as s:
                    s.sendall(f'GET http://127.0.0.1:{download}/ HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n'.encode());s.settimeout(20)
                    while not stop.is_set():
                        chunk=s.recv(65536)
                        if not chunk:break
                        received[0]+=len(chunk)
            except OSError:pass
        try:
            processes.append(subprocess.Popen(['openssl','s_server','-accept',f'127.0.0.1:{tls}','-cert',str(base/'cert.pem'),'-key',str(base/'key.pem'),'-tls1_3','-alpn','h2','-www','-quiet'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL))
            for name,config in [('server',serverconfig),('client',clientconfig)]:
                file=base/(name+'.json');file.write_text(json.dumps(config));processes.append(subprocess.Popen([binary,'run','-c',str(file)],stdout=(base/(name+'.log')).open('w'),stderr=subprocess.STDOUT))
            wait_tls(tls)
            time.sleep(.6);threading.Thread(target=serve,daemon=True).start();threading.Thread(target=consume,daemon=True).start()
            ready=time.monotonic()+10
            while True:
                try:
                    if read_counters(f'127.0.0.1:{api}',['probe'],binary)['probe']>0:break
                except ValueError:pass
                if time.monotonic()>ready:raise RuntimeError('TRANSFER_NOT_READY')
                time.sleep(.1)
            values=[]
            for _ in range(4):time.sleep(.6);values.append(read_counters(f'127.0.0.1:{api}',['probe'],binary)['probe'])
            assert all(b>a for a,b in zip(values,values[1:])),values
            assert not stop.is_set() and received[0]>100000
            from quota import QuotaStore
            store=QuotaStore(base/'quota.sqlite');store.reconcile_policy({'revision':1,'clients':[{'accountId':'probe','quotaEpoch':1,'quotaBytes':values[-1]-1,'usedBytes':0,'validUntil':int(time.time())+300,'generation':'probe:1'}]},int(time.time()))
            store.observe('probe','process',0,int(time.time()));store.observe('probe','process',values[-1],int(time.time()))
            assert not store.allowed('probe',int(time.time()))
            observed=time.monotonic();processes[1].terminate();processes[1].wait(timeout=2);time.sleep(.2);after=received[0];time.sleep(.3);assert received[0]==after
            cutoff=time.monotonic()-observed;assert cutoff<5;store.close()
            print(json.dumps({'version':'26.3.27','transport':'VLESS/REALITY flow empty','openStreamTotals':values,'receivedBytes':received[0],'apiBind':'127.0.0.1','existingStreamCutoffSeconds':round(cutoff,3),'result':'PASS'}))
        except Exception:
            print('process states:',[p.poll() for p in processes], 'received:',received[0])
            for f in base.glob('*.log'):
                message=f.read_text()[-4000:]
                for secret in (ident,private,public):message=message.replace(secret,'[redacted]')
                print(f.name,message)
            raise
        finally:
            stop.set();listener.close()
            for p in reversed(processes):p.terminate()
            for p in processes:p.wait(timeout=5)
if __name__=='__main__':main(sys.argv[1])
