import copy, importlib.util, pathlib, pytest

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
