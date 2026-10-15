import json,stat
from setup import prepare_secrets

def test_setup_persists_runner_key_without_bot_token(tmp_path):
 result=prepare_secrets(tmp_path,'https://bot.example','9','test-bot-secret')
 assert result['workerSecrets']['BOT_TOKEN']=='test-bot-secret'
 assert result['publicKey']['kty']=='RSA'
 private=tmp_path/'runner-private.pem';config=tmp_path/'runner.json'
 assert stat.S_IMODE(private.stat().st_mode)==0o600
 assert stat.S_IMODE(config.stat().st_mode)==0o600
 assert 'test-bot-secret' not in config.read_text()
 assert prepare_secrets(tmp_path,'https://bot.example','9','changed')['workerSecrets']['RUNNER_SERVICE_SECRET']==result['workerSecrets']['RUNNER_SERVICE_SECRET']
