import hashlib,hmac,json,pytest
from policy import verify_policy

def envelope(revision=1,expires=400):
 payload=json.dumps({'nodeId':'n','revision':revision,'expiresAt':expires,'clients':[]},separators=(',',':'))
 return {'payload':payload,'signature':hmac.new(b'key',payload.encode(),hashlib.sha256).hexdigest()}
def test_policy_rejects_expiry_replay_wrong_identity_and_signature():
 assert verify_policy(envelope(),'key','n',100,0)['revision']==1
 for e,key,node,now,revision in [(envelope(),'key','n',400,0),(envelope(),'key','n',100,1),(envelope(),'wrong','n',100,0),(envelope(),'key','other',100,0)]:
  with pytest.raises(ValueError):verify_policy(e,key,node,now,revision)
def test_render_omits_expired_clients_and_watchdog_rejects_missing_authorization(monkeypatch):
 from xray import render_config
 from agent import watchdog
 settings={'sni':'www.microsoft.com','privateKey':'a'*43,'shortId':'1234567890abcdef'}
 c=render_config(settings,[{'uuid':'11111111-1111-4111-8111-111111111111','validUntil':100}],100)
 assert c['inbounds'][0]['settings']['clients']==[]
 calls=[]
 import subprocess,pathlib
 monkeypatch.setattr(pathlib.Path,'read_text',lambda self:json.dumps({'expiresAt':100,'clients':[]}))
 monkeypatch.setattr(subprocess,'run',lambda args,**kw:calls.append(args))
 assert watchdog(100) is False;assert calls==[['systemctl','stop','madar-sales-xray.service']]
