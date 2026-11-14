"""Single-job V2 executor for GitHub Actions. Never reads the V1 runner key."""
import argparse
import hashlib
import hmac
import json
import logging
import os
import re

from cryptography.hazmat.primitives import serialization
from consumer import ORIGIN,run_job
from runner import Api

RUNNER_ID='v2-github-actions'
JOB_ID=re.compile(r'^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$')

def execute(job_id,env=os.environ):
    if not JOB_ID.fullmatch(job_id):
        raise ValueError('INVALID_JOB_ID')
    if env.get('MADAR_V2_URL')!=ORIGIN:
        raise ValueError('INVALID_WORKER_ORIGIN')
    secret=env.get('MADAR_V2_RUNNER_SERVICE_SECRET','')
    key=env.get('MADAR_V2_RUNNER_PRIVATE_KEY_PEM','')
    if len(secret)<32 or not key.startswith('-----BEGIN PRIVATE KEY-----'):
        raise ValueError('V2_ACTION_SECRETS_REQUIRED')
    private=serialization.load_pem_private_key(key.encode(),password=None)
    api=Api(ORIGIN,secret)
    signed=api.post('lease',{'runnerId':RUNNER_ID,'jobId':job_id})
    payload=signed['payload']
    expected=hmac.new(secret.encode(),payload.encode(),hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected,signed['signature']):
        raise ValueError('INVALID_JOB_SIGNATURE')
    job=json.loads(payload)
    if not isinstance(job,dict) or job.get('id')!=job_id or job.get('mode')!='fresh':
        raise ValueError('NO_MATCHING_V2_FRESH_JOB')
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
    except Exception:
        print('V2_EXECUTOR_FAILED: safe status only')
        raise SystemExit(1)

if __name__=='__main__':
    main()
