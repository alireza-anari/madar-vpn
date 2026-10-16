import hashlib,json,pytest
import installer
from installer import validate_preflight,verify_artifact,owned_recovery,configure_protocol

def info(**changes):
 base={'os':'ubuntu','version':'24.04','arch':'x86_64','root':True,'disk':2000000000,'conflict':False,'portBusy':False,'owner':None};return {**base,**changes}
@pytest.mark.parametrize('changes,code',[({'version':'20.04'},'UNSUPPORTED_UBUNTU'),({'root':False},'SUDO_REQUIRED'),({'conflict':True},'EXISTING_SERVICE'),({'portBusy':True},'PORT_CONFLICT'),({'disk':1},'INSUFFICIENT_DISK')])
def test_preflight_stops_before_install(changes,code):
 with pytest.raises(ValueError,match=code):validate_preflight(info(**changes),'job')
def test_recovery_requires_matching_owned_manifest():
 assert owned_recovery({'jobId':'job','nodeId':'node'},'job','node')
 assert not owned_recovery({'jobId':'other','nodeId':'node'},'job','node')
 assert validate_preflight(info(owner={'jobId':'job'},portBusy=True,portOwned=True),'job')['owned']
def test_checksum_mismatch_never_extracts():
 with pytest.raises(ValueError,match='CHECKSUM_MISMATCH'):verify_artifact(b'bad','0'*64)
 assert verify_artifact(b'ok',hashlib.sha256(b'ok').hexdigest())==b'ok'

def test_owned_manifest_does_not_authorize_an_unrelated_port_listener():
 with pytest.raises(ValueError,match='PORT_CONFLICT'):
  validate_preflight(info(owner={'jobId':'job'},portBusy=True,portOwned=False),'job')

def test_owned_xray_listener_can_reconcile():
 assert validate_preflight(info(owner={'jobId':'job'},portBusy=True,portOwned=True),'job')['owned']

def test_recovery_keeps_running_xray_inode(tmp_path):
 from installer import APPLY,package
 from unittest.mock import patch
 import io,pathlib,subprocess,sys
 root=tmp_path/'opt/madar-sales-node';root.mkdir(parents=True)
 (tmp_path/'etc/madar-sales-node').mkdir(parents=True)
 (tmp_path/'etc/systemd/system').mkdir(parents=True)
 (root/'manifest.json').write_text('{"jobId":"job"}')
 binary=root/'xray';binary.write_bytes(b'pinned-binary');inode=binary.stat().st_ino
 real_path=pathlib.Path
 def redirected(value):
  return tmp_path/str(value).lstrip('/') if str(value).startswith(('/opt/','/etc/')) else real_path(value)
 class Input:
  buffer=io.BytesIO(package({'manifest.json':b'{"jobId":"job"}','xray':b'pinned-binary'}))
 with patch.object(pathlib,'Path',side_effect=redirected),patch.object(subprocess,'run'),patch.object(sys,'argv',['apply','job']),patch.object(sys,'stdin',Input()):
  exec(APPLY,{})
 assert binary.stat().st_ino==inode

def test_new_config_follows_signed_job_protocol_without_changing_existing_keys():
 original={'nodeId':'node','privateKey':'same-private','nodeToken':'same-token','policyKey':'same-policy'}
 assert configure_protocol(original,{'protocolVersion':2})=={**original,'protocolVersion':2}
 assert configure_protocol(original,{})==original
 with pytest.raises(ValueError):configure_protocol(original,{'protocolVersion':3})

def test_protocol_v2_fresh_config_uses_shared_443_cloudflare():
 assert getattr(installer,'DEFAULT_REALITY_SNI',None)=='www.cloudflare.com'
 original={'policyKey':'a'*64,'sni':'www.cloudflare.com','port':443}
 result=configure_protocol(original,{'protocolVersion':2})
 assert original=={'policyKey':'a'*64,'sni':'www.cloudflare.com','port':443}
 assert result['protocolVersion']==2
 assert result['shared443'] is True
 assert result['frontendManaged'] is True
 assert result['frontendService']=='madar-sales-xray.service'
 assert result['bridgeKey']=='a'*64
 assert result['port']==443
 assert result['sni']=='www.cloudflare.com'

def test_protocol_v2_recovery_requires_shared_443_contract():
 validator=getattr(installer,'validate_protocol_recovery',None)
 assert validator is not None
 with pytest.raises(ValueError,match='PROTOCOL_UPGRADE_REQUIRED'):
  validator({'protocolVersion':2,'shared443':False},2)
 existing={'protocolVersion':2,'shared443':True,'frontendManaged':True,'frontendService':'madar-sales-xray.service','bridgeKey':'a'*64,'nodeId':'node','privateKey':'same-private','nodeToken':'same-token','policyKey':'a'*64,'port':443,'sni':'www.cloudflare.com'}
 assert validator(existing,2) is existing

def test_quota_install_initializes_durable_state_before_starting_agent(tmp_path):
 from installer import APPLY,package,BASE
 from unittest.mock import patch
 import io,pathlib,subprocess,sys,sqlite3
 (tmp_path/'etc/systemd/system').mkdir(parents=True);(tmp_path/'opt').mkdir()
 config={'nodeId':'node','protocolVersion':2,'privateKey':'unchanged','nodeToken':'same-token'}
 archive=package({'manifest.json':b'{"jobId":"job","nodeId":"node"}','config.json':json.dumps(config).encode(),'quota.py':(BASE.parent/'sales-node/quota.py').read_bytes()})
 real_path=pathlib.Path
 def redirected(value):return tmp_path/str(value).lstrip('/') if str(value).startswith(('/opt/','/etc/','/var/')) else real_path(value)
 state=tmp_path/'var/lib/madar-sales-node/quota.sqlite'
 def run(args,**kw):
  if 'enable' in args:assert state.is_file()
 class Input:buffer=io.BytesIO(archive)
 original_modules=dict(sys.modules)
 try:
  with patch.object(pathlib,'Path',side_effect=redirected),patch.object(subprocess,'run',side_effect=run),patch.object(sys,'argv',['apply','job']),patch.object(sys,'stdin',Input()):exec(APPLY,{})
 finally:
  if 'quota' not in original_modules:sys.modules.pop('quota',None)
 assert json.loads((tmp_path/'etc/madar-sales-node/config.json').read_text())==config
 with sqlite3.connect(state) as db:assert db.execute('SELECT revision FROM meta').fetchone()[0]==0
 assert json.loads((tmp_path/'opt/madar-sales-node/manifest.json').read_text())['quotaInitialized'] is True
