"""Polling runner. Run only on an approved dedicated execution host."""
import argparse,base64,hashlib,hmac,json,logging,os,threading,time,urllib.request
from cryptography.hazmat.primitives import serialization
from credential_envelope import decrypt_credentials
from ssh_transport import SshTransport,probe

class Api:
    def __init__(self,base,secret):
        if not base.startswith('https://'):raise ValueError('HTTPS_REQUIRED')
        self.base=base.rstrip('/');self.secret=secret
    def post(self,path,body):
        req=urllib.request.Request(self.base+'/api/runner/'+path,data=json.dumps(body).encode(),headers={'Authorization':'Bearer '+self.secret,'Content-Type':'application/json','User-Agent':'MadarSales/0.1'})
        with urllib.request.urlopen(req,timeout=15) as response:return json.loads(response.read(65536))
    def lease(self,runner_id):
        envelope=self.post('lease',{'runnerId':runner_id});payload=envelope['payload'];expected=hmac.new(self.secret.encode(),payload.encode(),hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected,envelope['signature']):raise ValueError('INVALID_JOB_SIGNATURE')
        return json.loads(payload)

def run_job(job,api,private_key,clock=time.time):
    job_id=job['id'];lease_id=job['leaseId'];stop=threading.Event();lease_lost=threading.Event()
    def report(state,code,details=None):return api.post('report',{'id':job_id,'leaseId':lease_id,'state':state,'safeCode':code,'details':details or {}})
    def renew():
        while not stop.wait(30):
            try:api.post('renew',{'id':job_id,'leaseId':lease_id})
            except Exception:lease_lost.set();return
    def check():
        if lease_lost.is_set():raise ValueError('LEASE_EXPIRED')
    renewer=threading.Thread(target=renew,daemon=True);renewer.start()
    credentials={}
    try:
        if job['kind']=='probe':report('ready','OK',{'fingerprint':probe(job['targetIp'],job['port'])});return 'ready'
        credentials=decrypt_credentials(job['encryptedCredentials'],private_key,int(clock()),job['credentialsExpireAt']);job['encryptedCredentials']=None
        with SshTransport(job['targetIp'],job['port'],job['username'],job['hostFingerprint'],credentials) as transport:
            from installer import install
            report('preflight','PREFLIGHT');result=install(transport,job,api,check)
            check();report('ready','INSTALLED',result)
        return 'ready'
    except Exception as error:
        allowed={'CREDENTIALS_EXPIRED','HOST_KEY_CHANGED','INVALID_TARGET','INVALID_SSH_KEY','SSH_AUTH_FAILED','UNSUPPORTED_UBUNTU','EXISTING_SERVICE','PORT_CONFLICT','SUDO_REQUIRED','CHECKSUM_MISMATCH','LEASE_EXPIRED','SSH_COMMAND_TIMEOUT','INSUFFICIENT_DISK','ARTIFACT_NOT_PINNED'}
        code=str(error) if str(error) in allowed else 'INSTALLATION_FAILED'
        try:report('failed',code)
        except Exception:pass
        return 'failed'
    finally:
        credentials.clear();job['encryptedCredentials']=None;stop.set();renewer.join(timeout=1)

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--config',required=True);args=parser.parse_args()
    # Config path only in argv; secrets reside in a mode-0600 file.
    if os.stat(args.config).st_mode & 0o077:raise SystemExit('CONFIG_PERMISSIONS')
    config=json.load(open(args.config));private=serialization.load_pem_private_key(open(config['privateKeyPath'],'rb').read(),password=None)
    api=Api(config['baseUrl'],config['serviceSecret'])
    logging.getLogger('paramiko').disabled=True
    while True:
        try:
            job=api.lease(config['runnerId'])
            if job:run_job(job,api,private)
        except Exception:pass
        time.sleep(3)
if __name__=='__main__':main()
