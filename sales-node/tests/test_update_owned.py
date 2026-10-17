import json,pytest
from update_owned import validate_owned_update

def test_update_requires_matching_ownership_and_keeps_identity(tmp_path):
    root=tmp_path/'root';etc=tmp_path/'etc';root.mkdir();etc.mkdir();(root/'manifest.json').write_text(json.dumps({'nodeId':'node','jobId':'job'}));config={'nodeId':'node','privateKey':'private','nodeToken':'secret','policyKey':'key'};(etc/'config.json').write_text(json.dumps(config))
    assert validate_owned_update(root,etc,'node')==config
    with pytest.raises(ValueError):validate_owned_update(root,etc,'other')
    (root/'manifest.json').unlink()
    with pytest.raises(ValueError):validate_owned_update(root,etc,'node')

def test_rejected_port_preflight_never_stops_existing_service(tmp_path,monkeypatch):
    import update_owned as updater,hashlib,pathlib,sys
    root=tmp_path/'opt/madar-sales-node';etc=tmp_path/'etc/madar-sales-node';root.mkdir(parents=True);etc.mkdir(parents=True)
    (root/'manifest.json').write_text(json.dumps({'nodeId':'node','jobId':'job'}));config={'nodeId':'node','privateKey':'private','nodeToken':'secret','policyKey':'key'};(etc/'config.json').write_text(json.dumps(config))
    unit=tmp_path/'etc/systemd/system/madar-sales-node.service';unit.parent.mkdir(parents=True);unit.write_text('ExecStart=/usr/bin/python3 /opt/madar-sales-node/agent.py')
    data=b'x=1\n';manifest=json.dumps({n:hashlib.sha256(data).hexdigest() for n in updater.FILES}).encode()
    real_path=pathlib.Path
    def redirected(value):return tmp_path/str(value).lstrip('/') if str(value).startswith(('/opt/','/etc/','/var/','/run/')) else real_path(value)
    monkeypatch.setattr(updater.pathlib,'Path',redirected);monkeypatch.setattr(updater.os,'getuid',lambda:0)
    monkeypatch.setattr(updater,'fetch',lambda url:manifest if url.endswith('source-manifest.json') else data)
    monkeypatch.setattr(sys,'argv',['update','--node-id','node','--source-ref','a'*40,'--manifest-sha256',hashlib.sha256(manifest).hexdigest(),'--enable-quota'])
    import socket
    class Busy:
        def __enter__(self):return self
        def __exit__(self,*args):pass
        def bind(self,*args):raise OSError('occupied')
    monkeypatch.setattr(socket,'socket',lambda *args:Busy())
    calls=[];monkeypatch.setattr(updater.subprocess,'run',lambda args,**kw:calls.append(args))
    with pytest.raises(ValueError,match='QUOTA_PORT_CONFLICT'):updater.main()
    assert not any('stop' in command for command in calls)
    assert json.loads((etc/'config.json').read_text())==config

def test_owned_unit_sources_require_existing_markers_and_pinned_templates(tmp_path,monkeypatch):
    import update_owned as updater,pathlib
    unit_root=tmp_path/'systemd';unit_root.mkdir()
    (unit_root/'madar-sales-node.service').write_text('[Service]\nExecStart=/usr/bin/python3 /opt/madar-sales-node/agent.py\n')
    (unit_root/'madar-sales-watchdog.service').write_text('[Service]\nExecStart=/usr/bin/python3 /opt/madar-sales-node/agent.py --watchdog\n')
    templates=pathlib.Path(__file__).parents[2]/'sales-runner'/'templates'
    monkeypatch.setattr(updater,'fetch',lambda url:(templates/url.rsplit('/',1)[-1]).read_bytes())
    units=updater.load_owned_units('a'*40,unit_root)
    assert units['madar-sales-node.service']==(templates/'madar-sales-node.service').read_bytes()
    assert units['madar-sales-watchdog.service']==(templates/'madar-sales-watchdog.service').read_bytes()
    (unit_root/'madar-sales-watchdog.service').write_text('[Service]\nExecStart=/bin/false\n')
    with pytest.raises(ValueError,match='UNIT_OWNERSHIP_MISMATCH'):updater.load_owned_units('a'*40,unit_root)
