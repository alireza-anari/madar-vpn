"""Interactive activation; never accept bot token as a command argument."""
import argparse,base64,getpass,json,os,pathlib,re,secrets,subprocess,tempfile,urllib.request
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

def write_private(path,data):
 fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 with os.fdopen(fd,'wb') as stream:stream.write(data)

def prepare_secrets(directory,base_url,admin_id,bot_token):
 directory=pathlib.Path(directory);directory.mkdir(mode=0o700,parents=True,exist_ok=True)
 if not base_url.startswith('https://') or not re.fullmatch(r'[0-9]+',admin_id):raise ValueError('INVALID_SETUP')
 key_path=directory/'runner-private.pem';config_path=directory/'runner.json'
 if key_path.exists():
  if key_path.stat().st_mode & 0o077:raise ValueError('KEY_PERMISSIONS')
  key=serialization.load_pem_private_key(key_path.read_bytes(),password=None)
 else:
  key=rsa.generate_private_key(public_exponent=65537,key_size=3072)
  write_private(key_path,key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()))
 if config_path.exists():
  if config_path.stat().st_mode & 0o077:raise ValueError('CONFIG_PERMISSIONS')
  config=json.loads(config_path.read_text())
  if config['baseUrl']!=base_url.rstrip('/'):raise ValueError('CONFIG_ORIGIN_CHANGED')
 else:
  config={'baseUrl':base_url.rstrip('/'),'serviceSecret':secrets.token_urlsafe(48),'policySigningSecret':secrets.token_urlsafe(48),'webhookSecret':secrets.token_urlsafe(48),'runnerId':'sales-runner-1','privateKeyPath':str(key_path.resolve())}
  write_private(config_path,json.dumps(config).encode())
 numbers=key.public_key().public_numbers();b64=lambda n:base64.urlsafe_b64encode(n.to_bytes((n.bit_length()+7)//8,'big')).decode().rstrip('=')
 public={'kty':'RSA','n':b64(numbers.n),'e':b64(numbers.e),'alg':'RSA-OAEP-256','ext':True,'key_ops':['encrypt']}
 return {'publicKey':public,'workerSecrets':{'BOT_TOKEN':bot_token,'TELEGRAM_WEBHOOK_SECRET':config['webhookSecret'],'RUNNER_SERVICE_SECRET':config['serviceSecret'],'POLICY_SIGNING_SECRET':config['policySigningSecret']},'config':config}

def telegram(token,method,data):
 req=urllib.request.Request('https://api.telegram.org/bot'+token+'/'+method,data=json.dumps(data).encode(),headers={'Content-Type':'application/json'})
 try:
  with urllib.request.urlopen(req,timeout=15) as response:result=json.loads(response.read(65536))
  if not result.get('ok'):raise ValueError()
  return result['result']
 except Exception:raise ValueError('TELEGRAM_ACTIVATION_FAILED') from None

def main():
 p=argparse.ArgumentParser();p.add_argument('--base-url',required=True);p.add_argument('--admin-id',required=True);p.add_argument('--config-dir',required=True);p.add_argument('--worker-dir',required=True);args=p.parse_args()
 token=getpass.getpass('Telegram bot token (hidden): ')
 if not telegram(token,'getMe',{}).get('is_bot'):raise SystemExit('BOT_IDENTITY_INVALID')
 result=prepare_secrets(args.config_dir,args.base_url,args.admin_id,token)
 temp=None
 try:
  fd,temp=tempfile.mkstemp(prefix='sales-secrets-',dir=args.config_dir)
  with os.fdopen(fd,'w') as stream:json.dump(result['workerSecrets'],stream)
  # Redirect all Wrangler diagnostics: token or signed URLs must never reach output.
  r=subprocess.run(['pnpm','exec','wrangler','secret','bulk',temp],cwd=args.worker_dir,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  if r.returncode:raise ValueError('CLOUDFLARE_SECRET_SETUP_FAILED')
  public=json.dumps(result['publicKey'],separators=(',',':'))
  r=subprocess.run(['pnpm','exec','wrangler','deploy','--keep-vars','--experimental-auto-create=false','--var','ADMIN_TELEGRAM_IDS:'+args.admin_id,'--var','PUBLIC_BASE_URL:'+args.base_url.rstrip('/'),'--var','RUNNER_PUBLIC_KEY:'+public],cwd=args.worker_dir,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  if r.returncode:raise ValueError('CLOUDFLARE_ACTIVATION_DEPLOY_FAILED')
  telegram(token,'setWebhook',{'url':args.base_url.rstrip('/')+'/webhook','secret_token':result['workerSecrets']['TELEGRAM_WEBHOOK_SECRET'],'allowed_updates':['message','callback_query'],'drop_pending_updates':False})
  print('Activation configured. Start the bot and verify the admin menu. Runner field acceptance is still required.')
 finally:
  if temp and os.path.exists(temp):os.unlink(temp)
if __name__=='__main__':
 try:main()
 except Exception as e:raise SystemExit(str(e) if str(e) in ('TELEGRAM_ACTIVATION_FAILED','CLOUDFLARE_SECRET_SETUP_FAILED','CLOUDFLARE_ACTIVATION_DEPLOY_FAILED','KEY_PERMISSIONS','CONFIG_PERMISSIONS','INVALID_SETUP','CONFIG_ORIGIN_CHANGED') else 'ACTIVATION_FAILED') from None
