import importlib.util,pathlib

def test_tls_readiness_waits_for_destination_instead_of_racing_startup(monkeypatch):
    path=pathlib.Path(__file__).with_name('probe_live_stats.py');spec=importlib.util.spec_from_file_location('probe',path);probe=importlib.util.module_from_spec(spec);spec.loader.exec_module(probe)
    attempts=[]
    class Connection:
        def __enter__(self):return self
        def __exit__(self,*args):pass
        def version(self):return 'TLSv1.3'
    class Context:
        def wrap_socket(self,*args,**kw):return Connection()
    def connect(*args,**kw):
        attempts.append(1)
        if len(attempts)<3:raise ConnectionRefusedError()
        return Connection()
    monkeypatch.setattr(probe.socket,'create_connection',connect);monkeypatch.setattr(probe.time,'sleep',lambda delay:None)
    probe.wait_tls(12345,context=Context())
    assert len(attempts)==3
