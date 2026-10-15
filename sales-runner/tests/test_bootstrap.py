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
