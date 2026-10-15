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
