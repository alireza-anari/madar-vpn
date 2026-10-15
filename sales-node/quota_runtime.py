"""Independent per-account Xray workers: stopping one terminates only its streams."""
import concurrent.futures,json,pathlib,queue,subprocess,threading,time,uuid
from quota import QuotaStore
from stats import read_counters
from xray import render_config,atomic_write

def meter_authorized(path,now):
    try:
        h=json.loads(pathlib.Path(path).read_text());return h['expiresAt']>now and 0<=now-h['sampledAt']<=4
    except Exception:return False

class AccountProcess:
    def __init__(self,settings,client,base,binary='/opt/madar-sales-node/xray'):
        self.client=client;self.generation=uuid.uuid4().hex;self.api=client['listenPort']+1000;self.seen=False
        config=render_config({**settings,'port':client['listenPort'],'statsPort':self.api},[client],int(time.time()))
        self.path=base/(client['accountId']+'.json');atomic_write(self.path,config)
        subprocess.run([binary,'run','-test','-c',str(self.path)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=True,timeout=3)
        self.process=subprocess.Popen([binary,'run','-c',str(self.path)],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        self.binary=binary
        deadline=time.monotonic()+1
        while True:
            try:
                import socket
                with socket.create_connection(('127.0.0.1',self.api),timeout=.1):break
            except OSError:
                if self.process.poll() is not None or time.monotonic()>=deadline:self.stop();raise ValueError('XRAY_NOT_READY')
                time.sleep(.05)
    def sample(self):
        if self.process.poll() is not None:raise ValueError('XRAY_EXITED')
        try:
            values=read_counters(f'127.0.0.1:{self.api}',[self.client['accountId']],self.binary,allow_unregistered=not self.seen)
            if values is None:return 0
            self.seen=True;return values[self.client['accountId']]
        except Exception:raise ValueError('STATS_UNAVAILABLE') from None
    def stop(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:self.process.wait(timeout=2)
            except subprocess.TimeoutExpired:self.process.kill();self.process.wait(timeout=2)
        self.path.unlink(missing_ok=True)

class QuotaRuntime:
    def __init__(self,config,request,verify,*,base=None,database=None,process_factory=AccountProcess):
        self.config=config;self.request=request;self.verify=verify;self.base=pathlib.Path(base or '/run/madar-sales-node');self.base.mkdir(parents=True,exist_ok=True)
        database=pathlib.Path(database or '/var/lib/madar-sales-node/quota.sqlite')
        self.process_factory=process_factory
        if not database.is_file():raise ValueError('QUOTA_STATE_MISSING')
        import sqlite3
        with sqlite3.connect(str(database)) as existing:existing.execute('SELECT revision FROM meta WHERE id=1').fetchone()
        self.store=QuotaStore(database);self.processes={};self.policy=None;self.revision=0
        self.incoming=queue.Queue();self.outgoing=queue.Queue(maxsize=1);self.stopping=threading.Event();self.healthy=False
        atomic_write(self.base/'quota-heartbeat.json',{'expiresAt':int(time.time())+5,'sampledAt':int(time.time())})
    def network(self):
        while not self.stopping.is_set():
            try:
                try:message=self.outgoing.get(timeout=.1)
                except queue.Empty:message=None
                if message:
                    revision,healthy,reports=message
                    if revision:self.request(self.config,'ack-v2',{'revision':revision,'healthy':healthy,'capabilities':['quota-v2','per-account-process']})
                    if reports:
                        self.request(self.config,'quota-reports',{'reports':reports})
                        self.incoming.put(('reports',[(r['accountId'],r['sequence']) for r in reports]))
                envelope=self.request(self.config,'policy-v2');self.incoming.put(('policy',envelope))
            except Exception:pass
            self.stopping.wait(3)
    def stop_account(self,ident,ambiguous=False):
        process=self.processes.pop(ident,None)
        if process:process.stop()
        if ambiguous:
            try:self.store.block(ident)
            except Exception:
                # Stop every child even when storage is failing. Never refresh liveness on error.
                self.healthy=False
                raise
    def run(self):
        threading.Thread(target=self.network,daemon=True).start()
        try:
            while not self.stopping.is_set():
                started=time.monotonic();now=int(time.time())
                try:
                    while True:
                        kind,value=self.incoming.get_nowait()
                        if kind=='reports':
                            for ident,seq in value:self.store.ack_report(ident,seq)
                        else:
                            policy=self.verify(value,self.config['policyKey'],self.config['nodeId'],now,self.revision-1)
                            if policy.get('version')!=2:raise ValueError('QUOTA_POLICY_REQUIRED')
                            self.store.reconcile_policy(policy,now);self.policy=policy;self.revision=policy['revision']
                except queue.Empty:pass
                if not self.policy or self.policy['expiresAt']<=now:
                    for ident in list(self.processes):self.stop_account(ident,True)
                    self.healthy=False
                else:
                    desired={c['accountId']:c for c in self.policy['clients']}
                    for ident in list(self.processes):
                        if ident not in desired or not self.store.allowed(ident,now):self.stop_account(ident,True)
                    for ident,client in desired.items():
                        if ident not in self.processes and self.store.allowed(ident,now):
                            # A fresh local generation is allowed only for accounts never observed.
                            row=self.store.db.execute('SELECT process_generation FROM accounts WHERE id=?',(ident,)).fetchone()
                            if row['process_generation'] is not None:self.store.block(ident);continue
                            try:process=self.process_factory(self.config,client,self.base)
                            except Exception:
                                self.store.block(ident)
                                continue
                            try:self.store.observe(ident,process.generation,0,now)
                            except Exception:process.stop();raise
                            self.processes[ident]=process
                    self.healthy=all(ident in self.processes for ident in desired)
                    # Queries run in parallel; the 2-second bounded CLI cannot serialize 10-user liveness.
                    with concurrent.futures.ThreadPoolExecutor(max_workers=32) as pool:
                        jobs={pool.submit(p.sample):ident for ident,p in self.processes.items()}
                        for future,ident in jobs.items():
                            try:
                                self.store.observe(ident,self.processes[ident].generation,future.result(),int(time.time()))
                                if not self.store.allowed(ident,int(time.time())):self.stop_account(ident)
                            except Exception:self.stop_account(ident,True);self.healthy=False
                    self.healthy=self.healthy and all(ident in self.processes for ident in desired)
                    # Existing processes use original config expiry only as metadata; local signed policy controls time.
                    atomic_write(self.base/'quota-heartbeat.json',{'expiresAt':self.policy['expiresAt'],'sampledAt':int(time.time())})
                message=(self.revision,self.healthy,self.store.pending_reports()[:100])
                try:self.outgoing.get_nowait()
                except queue.Empty:pass
                self.outgoing.put_nowait(message)
                time.sleep(max(0,1-(time.monotonic()-started)))
        finally:
            self.stopping.set()
            for ident in list(self.processes):
                try:self.stop_account(ident,True)
                except Exception:pass
            self.store.close()
