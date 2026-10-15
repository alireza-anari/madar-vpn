import hashlib,json,pytest
from installer import validate_preflight,verify_artifact,owned_recovery

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
