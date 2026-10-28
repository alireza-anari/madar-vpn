import json,pathlib
from quota_runtime import meter_authorized

def test_meter_must_be_recent_and_authorized(tmp_path):
    p=tmp_path/'heartbeat';p.write_text(json.dumps({'expiresAt':200,'sampledAt':100}))
    assert meter_authorized(p,102)
    assert not meter_authorized(p,106)
    assert not meter_authorized(p,201)
    p.write_text('bad');assert not meter_authorized(p,100)

def test_meter_cuts_exhausted_account_while_other_account_keeps_transferring(tmp_path,monkeypatch):
    import quota_runtime as runtime
    from quota import QuotaStore
    path=tmp_path/'quota.sqlite';QuotaStore(path).close();stops=[];samples={};ticks=[0]
    class Process:
        def __init__(self,config,client,base):self.client=client;self.generation='process-'+client['accountId'];samples[client['accountId']]=0
        def sample(self):
            ident=self.client['accountId'];samples[ident]+=30;return samples[ident]
        def stop(self):stops.append((self.client['accountId'],ticks[0]))
    monkeypatch.setattr(runtime.time,'time',lambda:100+ticks[0])
    controller=runtime.QuotaRuntime({'policyKey':'test','nodeId':'node'},lambda *args:None,lambda envelope,*args:envelope,base=tmp_path/'run',database=path,process_factory=Process)
    controller.network=lambda:None
    clients=[{'accountId':a,'quotaEpoch':1,'quotaBytes':cap,'usedBytes':0,'validUntil':1000,'generation':a+':1','listenPort':20000+i} for i,(a,cap) in enumerate([('a',50),('b',1000)])]
    controller.incoming.put(('policy',{'version':2,'revision':1,'expiresAt':400,'clients':clients}))
    def advance(delay):
        ticks[0]+=1
        if ticks[0]==3:controller.stopping.set()
    monkeypatch.setattr(runtime.time,'sleep',advance);controller.run()
    assert ('a',1) in stops
    assert ('b',1) not in stops and ('b',3) in stops and samples['b']==120
    store=QuotaStore(path);assert store.remaining('a')==0;store.close()

def test_missing_or_empty_database_never_reinitializes_quota(tmp_path):
    import pytest
    from quota_runtime import QuotaRuntime
    for file in (tmp_path/'missing',tmp_path/'empty'):
        if file.name=='empty':file.touch()
        with pytest.raises(Exception):QuotaRuntime({},None,None,base=tmp_path/'run',database=file)

def test_failed_meter_commit_stops_all_children_without_refreshing_liveness(tmp_path,monkeypatch):
    import pytest,quota_runtime as runtime
    from quota import QuotaStore
    path=tmp_path/'q';QuotaStore(path).close();stopped=[]
    class Process:
        def __init__(self,config,client,base):self.generation='p';self.client=client
        def sample(self):return 20
        def stop(self):stopped.append(self.client['accountId'])
    controller=runtime.QuotaRuntime({'policyKey':'k','nodeId':'n'},None,lambda envelope,*args:envelope,base=tmp_path/'run',database=path,process_factory=Process);controller.network=lambda:None
    client={'accountId':'a','quotaEpoch':1,'quotaBytes':100,'usedBytes':0,'validUntil':int(__import__('time').time())+100,'generation':'a:1','listenPort':20000}
    controller.incoming.put(('policy',{'version':2,'revision':1,'expiresAt':int(__import__('time').time())+300,'clients':[client]}))
    real=controller.store.observe
    def disk_error(ident,generation,counter,now):
        if counter:raise OSError('disk failure')
        return real(ident,generation,counter,now)
    monkeypatch.setattr(controller.store,'observe',disk_error)
    monkeypatch.setattr(controller.store,'block',lambda *args:(_ for _ in ()).throw(OSError('disk failure')))
    with pytest.raises(OSError):controller.run()
    assert stopped==['a']

def test_watchdog_stops_entire_quota_service_when_meter_hangs(monkeypatch):
    import agent,pathlib,subprocess
    monkeypatch.setattr(pathlib.Path,'exists',lambda self:True)
    monkeypatch.setattr(pathlib.Path,'read_text',lambda self:json.dumps({'expiresAt':300,'sampledAt':100}))
    calls=[];monkeypatch.setattr(subprocess,'run',lambda args,**kw:calls.append(args))
    assert not agent.watchdog(105)
    assert calls==[['systemctl','stop','madar-sales-node.service']]

def test_new_account_startup_failure_does_not_stop_healthy_sibling(tmp_path,monkeypatch):
    import quota_runtime as runtime
    from quota import QuotaStore
    path=tmp_path/'q';QuotaStore(path).close();ticks=[0];stops=[];healthy=[]
    class Process:
        def __init__(self,config,client,base):
            if client['accountId']=='b':raise ValueError('XRAY_NOT_READY')
            self.generation='p';self.total=0
        def sample(self):self.total+=10;return self.total
        def stop(self):stops.append(ticks[0])
    monkeypatch.setattr(runtime.time,'time',lambda:100+ticks[0])
    c=runtime.QuotaRuntime({'policyKey':'k','nodeId':'n'},None,lambda p,*args:p,base=tmp_path/'run',database=path,process_factory=Process);c.network=lambda:None
    clients=[{'accountId':a,'quotaEpoch':1,'quotaBytes':1000,'usedBytes':0,'validUntil':1000,'generation':a+':1','listenPort':20000+i} for i,a in enumerate(['a','b'])]
    c.incoming.put(('policy',{'version':2,'revision':1,'expiresAt':400,'clients':clients}))
    def advance(delay):
        healthy.append(c.store.allowed('a',100+ticks[0]));ticks[0]+=1
        if ticks[0]==3:c.stopping.set()
    monkeypatch.setattr(runtime.time,'sleep',advance);c.run()
    assert healthy==[True,True,True] and stops==[3]

def test_shared_frontend_factory_selects_owned_for_fresh_and_attaches_personal(monkeypatch):
    import quota_runtime as runtime,shared443
    calls=[]
    class Frontend:pass
    monkeypatch.setattr(shared443,'start_owned_frontend',lambda settings,binary,base:(calls.append(('owned',settings.get('frontendManaged'))) or Frontend()))
    monkeypatch.setattr(shared443,'SharedFrontend',lambda settings,binary:(calls.append(('attach',settings.get('frontendManaged'))) or Frontend()))
    assert isinstance(runtime.shared_frontend({'shared443':True,'frontendManaged':True},'xray',pathlib.Path('/tmp')),Frontend)
    assert isinstance(runtime.shared_frontend({'shared443':True},'xray',pathlib.Path('/tmp')),Frontend)
    assert calls==[('owned',True),('attach',None)]

def test_shared443_capability_requires_live_frontend(tmp_path):
    from quota import QuotaStore
    from quota_runtime import QuotaRuntime
    path=tmp_path/'q';QuotaStore(path).close()
    class Frontend:
        live=True
        def check(self):
            if not self.live:raise ValueError('FRONTEND_DOWN')
    frontend=Frontend()
    c=QuotaRuntime({'policyKey':'k','nodeId':'n','shared443':True},None,lambda p,*args:p,base=tmp_path/'run',database=path,frontend_factory=lambda *args:frontend)
    assert 'shared-443' in c.capabilities()
    frontend.live=False
    assert 'shared-443' not in c.capabilities()
    c.store.close()

def test_shared443_failure_forces_ack_unhealthy(tmp_path):
    import threading
    from quota import QuotaStore
    from quota_runtime import QuotaRuntime
    path=tmp_path/'q';QuotaStore(path).close();calls=[]
    class Frontend:
        def check(self):raise ValueError('FRONTEND_DOWN')
    c=QuotaRuntime({'policyKey':'k','nodeId':'n','shared443':True},None,lambda p,*args:p,base=tmp_path/'run',database=path,frontend_factory=lambda *args:Frontend())
    def request(config,route,data=None):
        if route=='ack-v2':calls.append(data);c.stopping.set()
        return {}
    c.request=request;c.outgoing.put((1,True,[]))
    thread=threading.Thread(target=c.network);thread.start();thread.join(2)
    assert calls and calls[0]['healthy'] is False
    assert 'shared-443' not in calls[0]['capabilities']
    c.store.close()

def test_dead_shared_frontend_stops_and_blocks_workers_before_next_tick(tmp_path,monkeypatch):
    import quota_runtime as runtime
    from quota import QuotaStore
    path=tmp_path/'q';QuotaStore(path).close();stopped=[];observed=[]
    class Frontend:
        def check(self):raise ValueError('FRONTEND_DOWN')
    class Process:
        def __init__(self,config,client,base):self.generation='p';self.client=client
        def sample(self):return 1
        def stop(self):stopped.append(self.client['accountId'])
    c=runtime.QuotaRuntime({'policyKey':'k','nodeId':'n','shared443':True},None,lambda p,*args:p,base=tmp_path/'run',database=path,process_factory=Process,frontend_factory=lambda *args:Frontend());c.network=lambda:None
    client={'accountId':'a','quotaEpoch':1,'quotaBytes':1000,'usedBytes':0,'validUntil':1000,'generation':'a:1','listenPort':20000}
    c.incoming.put(('policy',{'version':2,'revision':1,'expiresAt':400,'clients':[client]}))
    monkeypatch.setattr(runtime.time,'time',lambda:100)
    def advance(delay):
        observed.append((list(stopped),c.store.allowed('a',100),c.healthy));c.stopping.set()
    monkeypatch.setattr(runtime.time,'sleep',advance);c.run()
    assert observed==[(['a'],False,False)]

def test_empty_desired_set_cannot_hide_dead_shared_frontend(tmp_path,monkeypatch):
    import quota_runtime as runtime
    from quota import QuotaStore
    path=tmp_path/'q';QuotaStore(path).close();observed=[]
    class Frontend:
        def check(self):raise ValueError('FRONTEND_DOWN')
    c=runtime.QuotaRuntime({'policyKey':'k','nodeId':'n','shared443':True},None,lambda p,*args:p,base=tmp_path/'run',database=path,frontend_factory=lambda *args:Frontend());c.network=lambda:None
    c.incoming.put(('policy',{'version':2,'revision':1,'expiresAt':400,'clients':[]}))
    monkeypatch.setattr(runtime.time,'time',lambda:100)
    def advance(delay):observed.append(c.healthy);c.stopping.set()
    monkeypatch.setattr(runtime.time,'sleep',advance);c.run()
    assert observed==[False]

def test_quota_heartbeat_is_armed_before_fresh_frontend_start(tmp_path):
    import time
    from quota import QuotaStore
    from quota_runtime import QuotaRuntime,meter_authorized
    path=tmp_path/'q';QuotaStore(path).close();seen=[];base=tmp_path/'run'
    class Frontend:
        def check(self):return None
    def factory(*args):
        heartbeat=base/'quota-heartbeat.json'
        seen.append(heartbeat.exists() and meter_authorized(heartbeat,int(time.time())))
        return Frontend()
    c=QuotaRuntime({'policyKey':'k','nodeId':'n','shared443':True,'frontendManaged':True},None,lambda p,*args:p,base=base,database=path,frontend_factory=factory)
    assert seen==[True]
    c.store.close()


def test_transient_stats_failure_recovers_without_revoking_account(monkeypatch):
    import quota_runtime as runtime
    from types import SimpleNamespace
    p=object.__new__(runtime.AccountProcess)
    p.client={'accountId':'a'};p.api=21000;p.binary='xray';p.seen=True;p.frontend=None
    p.process=SimpleNamespace(poll=lambda:None)
    calls=[]
    def flaky_stats(*args,**kwargs):
        calls.append(kwargs)
        if len(calls)==1:raise ValueError('transient stats response')
        return {'a':73}
    monkeypatch.setattr(runtime,'read_counters',flaky_stats)
    monkeypatch.setattr(runtime.time,'sleep',lambda delay:None)
    assert p.sample()==73
    assert len(calls)==2
    assert p.seen is True


def test_persistent_stats_failure_still_fails_closed(monkeypatch):
    import pytest,quota_runtime as runtime
    from types import SimpleNamespace
    p=object.__new__(runtime.AccountProcess)
    p.client={'accountId':'a'};p.api=21000;p.binary='xray';p.seen=True;p.frontend=None
    p.process=SimpleNamespace(poll=lambda:None)
    queries=[]
    def failed(*args,**kwargs):
        queries.append(1)
        raise ValueError('bad counters')
    monkeypatch.setattr(runtime,'read_counters',failed)
    monkeypatch.setattr(runtime.time,'sleep',lambda delay:None)
    with pytest.raises(ValueError,match='STATS_UNAVAILABLE'):p.sample()
    assert len(queries)==2


def test_stats_retry_cannot_hide_process_exit(monkeypatch):
    import pytest,quota_runtime as runtime
    p=object.__new__(runtime.AccountProcess)
    p.client={'accountId':'a'};p.api=21000;p.binary='xray';p.seen=True;p.frontend=None
    polls=[]
    class Process:
        def poll(self):
            polls.append(1)
            return None if len(polls)==1 else 1
    p.process=Process()
    queries=[]
    def failed(*args,**kwargs):
        queries.append(1)
        raise ValueError('bad counters')
    monkeypatch.setattr(runtime,'read_counters',failed)
    monkeypatch.setattr(runtime.time,'sleep',lambda delay:None)
    with pytest.raises(ValueError,match='XRAY_EXITED'):p.sample()
    assert len(queries)==1


def test_stats_retry_cannot_hide_shared_frontend_restart(monkeypatch):
    import pytest,quota_runtime as runtime
    from types import SimpleNamespace
    p=object.__new__(runtime.AccountProcess)
    p.client={'accountId':'a'};p.api=21000;p.binary='xray';p.seen=True
    p.process=SimpleNamespace(poll=lambda:None)
    class Frontend:
        def check(self):raise ValueError('FRONTEND_RESTARTED')
    p.frontend=Frontend()
    monkeypatch.setattr(runtime,'read_counters',lambda *args,**kwargs:None)
    with pytest.raises(ValueError,match='FRONTEND_RESTARTED'):p.sample()
