import copy, importlib.util, json, pathlib, pytest

def module():
    path=pathlib.Path(__file__).parents[1]/'shared443.py'
    assert path.exists(), 'shared443 adapter is not implemented'
    spec=importlib.util.spec_from_file_location('shared443',path)
    m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m

def personal():
    return {'inbounds':[{'port':443,'protocol':'vless','settings':{'clients':[{'id':'11111111-1111-4111-8111-111111111111','flow':'xtls-rprx-vision'}],'decryption':'none'},'streamSettings':{'network':'raw','security':'reality','realitySettings':{'privateKey':'keep-secret','shortIds':['1234'],'serverNames':['example.com']}}}], 'outbounds':[{'protocol':'freedom','tag':'original'}]}

def test_frontend_preserves_personal_credential_and_transport():
    m=module();old=personal();before=copy.deepcopy(old)
    new,settings=m.build_frontend(old,'a'*64,ports=range(20000,20002))
    assert old==before
    assert new['inbounds'][0]['settings']==old['inbounds'][0]['settings']
    assert new['inbounds'][0]['streamSettings']==old['inbounds'][0]['streamSettings']
    assert new['outbounds'][0]==old['outbounds'][0]
    assert new['api']['services']==['HandlerService']
    api=new['inbounds'][-1];assert api['listen']=='127.0.0.1'
    for p in (20000,20001):
        out=next(x for x in new['outbounds'] if x.get('tag')==f'madar-{p}')
        assert out['settings']['vnext'][0]['address']=='127.0.0.1'
        assert out['settings']['vnext'][0]['port']==p
        assert out['settings']['vnext'][0]['users'][0]['id']==m.bridge_uuid('a'*64,p)
        rule=next(x for x in new['routing']['rules'] if x.get('user')==[f'madar-{p}'])
        assert rule['outboundTag']==f'madar-{p}'

def test_fresh_frontend_owns_public_443_and_keeps_bridges_loopback():
    m=module();settings={'bridgeKey':'a'*64,'sni':'www.cloudflare.com','privateKey':'private','shortId':'abcd','port':443,'frontendService':'madar-sales-xray.service'}
    frontend,runtime=m.build_fresh_frontend(settings,ports=range(20000,20002))
    public=[i for i in frontend['inbounds'] if i.get('port')==443]
    assert len(public)==1
    assert public[0]['listen']=='0.0.0.0'
    assert public[0]['protocol']=='vless'
    assert public[0]['streamSettings']['security']=='reality'
    assert public[0]['settings']['clients']==[]
    api=next(i for i in frontend['inbounds'] if i.get('tag')==m.API_TAG)
    assert api['listen']=='127.0.0.1' and api['port']==19999
    for p in (20000,20001):
        out=next(x for x in frontend['outbounds'] if x.get('tag')==f'madar-{p}')
        assert out['settings']['vnext'][0]['address']=='127.0.0.1'
    assert runtime['frontendService']=='madar-sales-xray.service'
    assert runtime['frontendApi']=='127.0.0.1:19999'

def test_start_owned_frontend_tests_config_writes_marker_and_restarts(tmp_path,monkeypatch):
    import subprocess
    m=module();calls=[]
    settings={'nodeId':'node','bridgeKey':'a'*64,'sni':'www.cloudflare.com','privateKey':'private','shortId':'abcd','port':443,'shared443':True,'frontendManaged':True,'frontendService':'madar-sales-xray.service'}
    def run(args,**kw):
        calls.append(args)
        if args[:3]==['systemctl','show','madar-sales-xray.service']:
            return subprocess.CompletedProcess(args,0,stdout='123\n',stderr='')
        return subprocess.CompletedProcess(args,0,stdout='Added 1 user(s) in total.' if 'adu' in args else '',stderr='')
    monkeypatch.setattr(subprocess,'run',run)
    original_read=pathlib.Path.read_text
    def read_text(path,*args,**kwargs):
        if str(path)=='/proc/123/stat':return '123 (x) S '+' '.join(str(i) for i in range(1,25))
        return original_read(path,*args,**kwargs)
    monkeypatch.setattr(pathlib.Path,'read_text',read_text)
    front=m.start_owned_frontend(settings,'/opt/madar-sales-node/xray',tmp_path)
    candidate=json.loads((tmp_path/'xray.json').read_text())
    public=next(i for i in candidate['inbounds'] if i.get('port')==443)
    assert public['settings']['clients']==[]
    assert json.loads((tmp_path/'authorization.json').read_text())=={'mode':'shared-frontend','nodeId':'node'}
    assert ['/opt/madar-sales-node/xray','run','-test','-c',str(tmp_path/'xray.json')] in calls
    assert ['systemctl','restart','madar-sales-xray.service'] in calls
    assert isinstance(front,m.SharedFrontend)
    # AccountProcess receives the original settings, not front.settings.
    assert settings['frontendTag']==public['tag']
    assert settings['frontendApi']=='127.0.0.1:19999'
    attached=m.SharedFrontend(settings,'/opt/madar-sales-node/xray')
    attached.add({'accountId':'account','uuid':'22222222-2222-4222-8222-222222222222','listenPort':20000},tmp_path)
    assert any('adu' in args for args in calls)

def test_existing_api_and_reserved_tags_are_rejected():
    m=module()
    for conf in ({**personal(),'api':{'tag':'existing'}},{**personal(),'outbounds':[{'tag':'madar-20000','protocol':'freedom'}]}):
        with pytest.raises(ValueError):m.build_frontend(conf,'a'*64)

def test_backend_only_loopback_and_counts_managed_account():
    m=module();client={'uuid':'22222222-2222-4222-8222-222222222222','accountId':'account','listenPort':20000,'validUntil':9999999999}
    c=m.backend_config({'bridgeKey':'a'*64,'sni':'example.com','privateKey':'unused','shortId':'abcd'},client,100)
    assert c['inbounds'][0]['listen']=='127.0.0.1'
    assert c['inbounds'][0]['streamSettings']['security']=='none'
    assert c['inbounds'][0]['settings']['clients'][0]['id']!=client['uuid']
    assert c['inbounds'][0]['settings']['clients'][0]['email']=='account'

def test_backend_bridge_secret_is_not_public_uuid_and_is_port_scoped():
    m=module()
    assert m.bridge_uuid('a'*64,20000)!=m.bridge_uuid('a'*64,20001)
    assert m.bridge_uuid('a'*64,20000)!=m.bridge_uuid('b'*64,20000)
    with pytest.raises(ValueError):m.bridge_uuid('a'*64,443)

def test_api_zero_exit_does_not_count_as_success_when_no_user_added(tmp_path,monkeypatch):
 import subprocess
 m=module();front=object.__new__(m.SharedFrontend);front.settings={'frontendTag':'in','frontendApi':'127.0.0.1:19999'};front.binary='xray';front.check=lambda:None
 monkeypatch.setattr(subprocess,'run',lambda *a,**k:subprocess.CompletedProcess(a,0,stdout='Added 0 user(s) in total.',stderr=''))
 with pytest.raises(ValueError,match='FRONTEND_USER_NOT_ADDED'):front.add({'accountId':'a','uuid':'u','listenPort':20000},tmp_path)
 assert not list(tmp_path.iterdir())

def test_frontend_restart_is_not_treated_as_healthy():
 m=module();front=object.__new__(m.SharedFrontend);front.pid=(1,'first');front.current_pid=lambda:(1,'reused-pid')
 with pytest.raises(ValueError,match='FRONTEND_RESTARTED'):front.check()

def test_frontend_service_is_configurable_for_fresh_and_defaults_for_personal(monkeypatch):
    import subprocess
    m=module();calls=[]
    monkeypatch.setattr(subprocess,'run',lambda args,**kw:(calls.append(args) or subprocess.CompletedProcess(args,0,stdout='123\n',stderr='')))
    monkeypatch.setattr(pathlib.Path,'read_text',lambda self:'123 (x) S '+' '.join(str(i) for i in range(1,25)))
    fresh=object.__new__(m.SharedFrontend);fresh.settings={'frontendService':'madar-sales-xray.service'};fresh.binary='xray'
    assert fresh.current_pid()[0]==123
    assert calls[-1][2]=='madar-sales-xray.service'
    personal_front=object.__new__(m.SharedFrontend);personal_front.settings={};personal_front.binary='xray'
    assert personal_front.current_pid()[0]==123
    assert calls[-1][2]=='xray.service'


def test_shared_frontend_pid_probe_is_amortized_across_active_accounts(monkeypatch):
    import subprocess
    m=module()
    clock=[100.0];main_pid=[123];calls=[];alive=[True]
    monkeypatch.setattr(m.time,'monotonic',lambda:clock[0])
    def systemctl(args,**kwargs):
        calls.append(args)
        return subprocess.CompletedProcess(args,0,stdout=str(main_pid[0])+'\\n',stderr='')
    def procstat(path):
        assert path.as_posix()==f'/proc/{123}/stat'
        if not alive[0]:raise FileNotFoundError(str(path))
        return '123 (xray) S '+' '.join(str(i) for i in range(1,25))
    monkeypatch.setattr(m.subprocess,'run',systemctl)
    monkeypatch.setattr(pathlib.Path,'read_text',procstat)
    settings={'frontendService':'madar-amortization-test.service'}
    clients=[m.SharedFrontend(settings,'xray') for _ in range(40)]
    for client in clients:client.check()
    # 80 checks, but only one heavyweight systemctl invocation.
    assert len(calls)==1
    assert all(c.pid==(123,'19') for c in clients)

    # Even when MainPID comes from cache, liveness is never assumed.
    alive[0]=False
    with pytest.raises(FileNotFoundError):clients[0].check()
    assert len(calls)==1

    # A service restart after the short cache window is detected.
    alive[0]=True
    clock[0]+=.251
    main_pid[0]=456
    monkeypatch.setattr(pathlib.Path,'read_text',lambda p:'456 (xray) S '+' '.join(str(i) for i in range(1,25)))
    with pytest.raises(ValueError,match='FRONTEND_RESTARTED'):clients[0].check()
    assert len(calls)==2


def test_shared_frontend_zombie_is_never_healthy_inside_pid_cache(monkeypatch):
    import subprocess
    m=module();clock=[42.0];state=['S'];calls=[]
    monkeypatch.setattr(m.time,'monotonic',lambda:clock[0])
    monkeypatch.setattr(m.subprocess,'run',lambda args,**kw:(calls.append(args) or subprocess.CompletedProcess(args,0,stdout='888\\n',stderr='')))
    monkeypatch.setattr(pathlib.Path,'read_text',lambda p:'888 (xray) '+state[0]+' '+' '.join(str(i) for i in range(1,25)))
    front=m.SharedFrontend({'frontendService':'madar-zombie-test.service'},'xray')
    state[0]='Z'
    with pytest.raises(ValueError,match='FRONTEND_NOT_RUNNING'):front.check()
    assert len(calls)==1


def test_shared_frontend_systemctl_failures_are_not_cached(monkeypatch):
    import subprocess
    m=module();clock=[1.0];results=[0,444];calls=[]
    monkeypatch.setattr(m.time,'monotonic',lambda:clock[0])
    def service(args,**kwargs):
        calls.append(args)
        return subprocess.CompletedProcess(args,0,stdout=str(results.pop(0))+'\\n',stderr='')
    monkeypatch.setattr(m.subprocess,'run',service)
    monkeypatch.setattr(pathlib.Path,'read_text',lambda p:'444 (xray) S '+' '.join(str(i) for i in range(1,25)))
    settings={'frontendService':'madar-stopped-test.service'}
    with pytest.raises(ValueError,match='FRONTEND_NOT_RUNNING'):m.SharedFrontend(settings,'xray')
    front=m.SharedFrontend(settings,'xray')
    assert front.pid[0]==444
    assert len(calls)==2
