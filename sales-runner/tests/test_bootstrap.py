import json,stat
from pathlib import Path
from bootstrap import prepare_identity, install_config, render_service
import pytest

def test_identity_is_private_stable_and_never_uploads_private_key(tmp_path):
 first=prepare_identity(tmp_path)
 second=prepare_identity(tmp_path)
 assert first==second
 assert first['publicKey']['kty']=='RSA'
 assert len(first['fingerprint'])==64
 assert 'PRIVATE' not in json.dumps(first)
 assert stat.S_IMODE((tmp_path/'runner-private.pem').stat().st_mode)==0o600

def test_config_binds_key_and_origin_and_rejects_changed_identity(tmp_path):
 identity=prepare_identity(tmp_path)
 payload={'baseUrl':'https://bot.example','serviceSecret':'canary-secret','runnerId':'sales-runner-1','fingerprint':identity['fingerprint']}
 install_config(tmp_path,payload,'https://bot.example')
 config=json.loads((tmp_path/'runner.json').read_text())
 assert config['privateKeyPath']==str((tmp_path/'runner-private.pem').resolve())
 assert stat.S_IMODE((tmp_path/'runner.json').stat().st_mode)==0o600
 with pytest.raises(ValueError):install_config(tmp_path,{**payload,'fingerprint':'wrong'},'https://bot.example')
 with pytest.raises(ValueError):install_config(tmp_path,{**payload,'baseUrl':'https://evil.example'},'https://bot.example')

def test_service_is_separate_and_runs_unprivileged():
 service=render_service()
 assert 'User=madar-sales-runner' in service
 assert 'Restart=always' in service
 assert 'runner.json' in service
 assert 'BOT_TOKEN' not in service

def test_bootstrap_http_identifies_the_service(monkeypatch):
 import bootstrap,io
 def open_request(req,**kwargs):
  assert req.get_header('User-agent')=='MadarSales/0.1'
  return io.BytesIO(b'{"pending":true}')
 monkeypatch.setattr(bootstrap.urllib.request,'urlopen',open_request)
 assert bootstrap.request('pair',{'publicKey':{}})=={'pending':True}

def test_owned_runner_update_preserves_identity_and_never_pairs(tmp_path,monkeypatch):
 from bootstrap import restart_owned_runner
 import bootstrap
 config=tmp_path/'config';config.mkdir(mode=0o700);prepare_identity(config)
 (config/'runner.json').write_text(json.dumps({'baseUrl':'https://bot.example','serviceSecret':'same-secret','runnerId':'r','privateKeyPath':str(config/'runner-private.pem')}));(config/'runner.json').chmod(0o600)
 root=tmp_path/'root';root.mkdir();(root/'.bootstrap-owned').touch();unit=tmp_path/'runner.service';unit.write_text(render_service())
 before={p.name:p.read_bytes() for p in config.iterdir()};calls=[]
 monkeypatch.setattr(bootstrap.subprocess,'run',lambda args,**kw:calls.append(args))
 monkeypatch.setattr(bootstrap,'request',lambda *args:(_ for _ in ()).throw(AssertionError('must not pair')))
 restart_owned_runner(root,config,unit)
 assert before=={p.name:p.read_bytes() for p in config.iterdir()}
 assert ['systemctl','restart','madar-sales-runner.service'] in calls
