import importlib.util,pathlib,pytest

def module():
 p=pathlib.Path(__file__).parents[1]/'install_personal.py'
 assert p.exists(),'personal adoption installer is missing'
 s=importlib.util.spec_from_file_location('install_personal',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m

def test_install_requires_exact_personal_identity():
 m=module()
 with pytest.raises(ValueError):m.validate_identity('i-02e7b7226304276f9')
 assert m.validate_identity('i-002a965e30ef88b2f') is None

def test_manifest_does_not_allow_unpinned_files():
 m=module()
 with pytest.raises(ValueError):m.validate_sources({'agent.py':b'changed'},{'agent.py':'0'*64})

def test_replace_preserves_readability_for_existing_service_user(tmp_path):
 m=module();p=tmp_path/'config.json';p.write_text('old');p.chmod(0o640)
 m.replace_config(p,b'new')
 assert p.read_text()=='new' and p.stat().st_mode&0o777==0o640

def test_rollback_restores_atomically_after_persisted_deadline(tmp_path,monkeypatch):
 import subprocess
 m=module();live=tmp_path/'config.json';live.write_text('new');live.chmod(0o640)
 backup=tmp_path/'backup';backup.write_text('original')
 pending=tmp_path/'deadline';pending.write_text('{"expiresAt":1}')
 script=m.rollback_program(backup,live.stat()).replace('/usr/local/etc/xray/config.json',str(live)).replace('/opt/madar-sales-node/adoption-deadline.json',str(pending))
 monkeypatch.setattr(subprocess,'run',lambda *a,**k:None)
 exec(compile(script,'rollback','exec'),{})
 assert live.read_text()=='original' and live.stat().st_mode&0o777==0o640
 assert not pending.exists()

def test_failed_atomic_rollback_keeps_working_config(tmp_path,monkeypatch):
 import os,subprocess
 m=module();live=tmp_path/'config.json';live.write_text('working')
 backup=tmp_path/'backup';backup.write_text('old')
 pending=tmp_path/'deadline';pending.write_text('{"expiresAt":1}')
 script=m.rollback_program(backup,live.stat()).replace('/usr/local/etc/xray/config.json',str(live)).replace('/opt/madar-sales-node/adoption-deadline.json',str(pending))
 monkeypatch.setattr(subprocess,'run',lambda *a,**k:None)
 monkeypatch.setattr(os,'replace',lambda *a:(_ for _ in ()).throw(OSError('disk failure')))
 with pytest.raises(OSError):exec(compile(script,'rollback','exec'),{})
 assert live.read_text()=='working' and pending.exists()

def test_candidate_preserves_original_group_not_copying_process_group(tmp_path):
 import os
 m=module();source=tmp_path/'config.json';source.write_text('{}');source.chmod(0o640)
 if os.geteuid()!=0:pytest.skip('requires chown to a distinct service group')
 try:os.chown(source,0,60000)
 except OSError:pytest.skip("service gid not mapped in executor namespace")
 candidate=m.prepare_candidate(source,b'{"inbounds":[]}')
 assert candidate.stat().st_gid==60000
 assert candidate.stat().st_uid==source.stat().st_uid
 assert candidate.stat().st_mode&0o777==0o640
 assert source.read_text()=='{}'


def test_candidate_retains_source_permissions_without_changing_source(tmp_path):
 m=module();source=tmp_path/'config.json';source.write_text('{}');source.chmod(0o640)
 candidate=m.prepare_candidate(source,b'{"inbounds":[]}')
 assert candidate.stat().st_uid==source.stat().st_uid
 assert candidate.stat().st_gid==source.stat().st_gid
 assert candidate.stat().st_mode&0o777==0o640
 assert source.read_text()=='{}'
