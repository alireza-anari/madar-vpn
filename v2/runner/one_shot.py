"""Single-job V2 executor for GitHub Actions. Never reads the V1 runner key."""
import argparse
import hashlib
import hmac
import json
import logging
import os
import re
import urllib.error
from cryptography.exceptions import UnsupportedAlgorithm

from cryptography.hazmat.primitives import serialization
from consumer import ORIGIN,run_job
from runner import Api

RUNNER_ID='v2-github-actions'
JOB_ID=re.compile(r'^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$')

def load_private_key(pem):
    if not isinstance(pem,str) or not pem.strip():
        raise ValueError('PRIVATE_KEY_MISSING')
    try:
        private=serialization.load_pem_private_key(pem.encode(),password=None)
    except (ValueError,TypeError,UnsupportedAlgorithm):
        raise ValueError('PRIVATE_KEY_INVALID') from None
    if not hasattr(private,'decrypt'):
        raise ValueError('PRIVATE_KEY_NOT_RSA')
    return private

def execute(job_id,env=os.environ):
    if not JOB_ID.fullmatch(job_id):
        raise ValueError('INVALID_JOB_ID')
    if env.get('MADAR_V2_URL')!=ORIGIN:
        raise ValueError('INVALID_WORKER_ORIGIN')
    secret=env.get('MADAR_V2_RUNNER_SERVICE_SECRET','')
    if len(secret)<32:
        raise ValueError('RUNNER_SERVICE_SECRET_MISSING')
    private=load_private_key(env.get('MADAR_V2_RUNNER_PRIVATE_KEY_PEM',''))
    api=Api(ORIGIN,secret)
    try:
        signed=api.post('lease',{'runnerId':RUNNER_ID,'jobId':job_id})
    except urllib.error.HTTPError as exc:
        if exc.code==401:raise ValueError('RUNNER_SERVICE_SECRET_MISMATCH') from None
        raise ValueError('WORKER_HTTP_ERROR') from None
    except (urllib.error.URLError,TimeoutError):
        raise ValueError('WORKER_UNREACHABLE') from None
    payload=signed['payload']
    expected=hmac.new(secret.encode(),payload.encode(),hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected,signed['signature']):
        raise ValueError('INVALID_JOB_SIGNATURE')
    job=json.loads(payload)
    if job is None:raise ValueError('JOB_NOT_AVAILABLE')
    if not isinstance(job,dict) or job.get('id')!=job_id or job.get('mode')!='fresh':
        raise ValueError('INVALID_JOB_PAYLOAD')
    # GitHub-hosted runners have no EC2 instance role: never attempt to
    # mutate a security group or rely on AWS metadata.
    return run_job(job,api,private,network_mode='none')

def main():
    p=argparse.ArgumentParser()
    p.add_argument('--job-id',required=True)
    args=p.parse_args()
    logging.getLogger('paramiko').disabled=True
    try:
        state=execute(args.job_id)
        if state!='ready':
            raise ValueError('V2_JOB_FAILED')
        print('V2_JOB_REPORTED')
    except Exception as exc:
        known={'PRIVATE_KEY_MISSING','PRIVATE_KEY_INVALID','PRIVATE_KEY_NOT_RSA',
            'RUNNER_SERVICE_SECRET_MISSING','RUNNER_SERVICE_SECRET_MISMATCH',
            'WORKER_HTTP_ERROR','WORKER_UNREACHABLE','JOB_NOT_AVAILABLE',
            'INVALID_JOB_PAYLOAD','INVALID_JOB_SIGNATURE','V2_JOB_FAILED',
            'INVALID_WORKER_ORIGIN','INVALID_JOB_ID'}
        code=str(exc)
        print('V2_EXECUTOR_FAILED: '+(code if code in known else 'UNCLASSIFIED'))
        raise SystemExit(1)

if __name__=='__main__':
    main()
