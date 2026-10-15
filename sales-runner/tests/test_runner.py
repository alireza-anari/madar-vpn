import json,pytest
from runner import run_job

def test_expired_credentials_report_failure_without_transport_or_secret(monkeypatch):
 calls=[]
 class Api:
  def post(self,path,body):calls.append((path,body));return {}
 job={'id':'j','leaseId':'l','kind':'install','encryptedCredentials':'secret-canary','credentialsExpireAt':99}
 assert run_job(job,Api(),None,clock=lambda:100)=='failed'
 assert calls[0][1]['safeCode']=='CREDENTIALS_EXPIRED'
 assert 'secret-canary' not in json.dumps(calls)
 assert job['encryptedCredentials'] is None

def test_runner_http_identifies_the_service(monkeypatch):
 import runner,io
 def open_request(req,**kwargs):
  assert req.get_header('User-agent')=='MadarSales/0.1'
  assert req.get_header('Authorization')=='Bearer test-secret'
  return io.BytesIO(b'{}')
 monkeypatch.setattr(runner.urllib.request,'urlopen',open_request)
 assert runner.Api('https://bot.example','test-secret').post('lease',{})=={}
