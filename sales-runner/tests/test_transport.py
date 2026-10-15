import base64,hashlib,io,json,time
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa,padding
from cryptography.hazmat.primitives import hashes,serialization
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from credential_envelope import decrypt_credentials
from ssh_transport import assert_public_target,verify_fingerprint

def test_envelope_roundtrip_and_expiry():
 key=rsa.generate_private_key(public_exponent=65537,key_size=3072);aes=AESGCM.generate_key(bit_length=256);iv=b'123456789012';b64=lambda x:base64.b64encode(x).decode()
 envelope={'v':1,'key':b64(key.public_key().encrypt(aes,padding.OAEP(mgf=padding.MGF1(hashes.SHA256()),algorithm=hashes.SHA256(),label=None))),'iv':b64(iv),'data':b64(AESGCM(aes).encrypt(iv,json.dumps({'method':'password','password':'canary'}).encode(),None))}
 assert decrypt_credentials(json.dumps(envelope),key,100,101)['password']=='canary'
 with pytest.raises(ValueError,match='CREDENTIALS_EXPIRED'):decrypt_credentials(json.dumps(envelope),key,101,101)
@pytest.mark.parametrize('target',['10.0.0.1','127.0.0.1','169.254.169.254','::ffff:10.0.0.1','example.com'])
def test_private_targets_blocked(target):
 with pytest.raises(ValueError):assert_public_target(target)
def test_changed_host_key_rejected():
 class Key:
  def asbytes(self):return b'host'
 fingerprint='SHA256:'+base64.b64encode(hashlib.sha256(b'host').digest()).decode().rstrip('=')
 verify_fingerprint(Key(),fingerprint)
 with pytest.raises(ValueError,match='HOST_KEY_CHANGED'):verify_fingerprint(Key(),'SHA256:wrong')
@pytest.mark.parametrize('method',['password','key'])
def test_real_ssh_transport_auth_and_secret_cleanup(method,monkeypatch):
 import socket,threading,paramiko
 import ssh_transport
 host=paramiko.RSAKey.generate(2048);client_key=paramiko.RSAKey.generate(2048);key_text=io.StringIO();client_key.write_private_key(key_text)
 accepted=[];closed=threading.Event()
 class Server(paramiko.ServerInterface):
  def check_auth_password(self,username,password):accepted.append(('password',username,password));return paramiko.AUTH_SUCCESSFUL if username=='ubuntu' and password=='test-pass' else paramiko.AUTH_FAILED
  def check_auth_publickey(self,username,key):accepted.append(('key',username));return paramiko.AUTH_SUCCESSFUL if key==client_key else paramiko.AUTH_FAILED
  def get_allowed_auths(self,username):return 'password,publickey'
  def check_channel_request(self,kind,chanid):return paramiko.OPEN_SUCCEEDED
  def check_channel_exec_request(self,channel,command):
   channel.send(b'OK');channel.send_exit_status(0);return True
 a,b=socket.socketpair()
 def serve():
  server=paramiko.Transport(b)
  try:server.add_server_key(host);server.start_server(server=Server());channel=server.accept(5);closed.wait(5)
  finally:server.close()
 thread=threading.Thread(target=serve);thread.start()
 monkeypatch.setattr(ssh_transport.socket,'create_connection',lambda *args,**kwargs:a)
 c={'method':method,'password':'test-pass'} if method=='password' else {'method':'key','key':key_text.getvalue()}
 try:
  with ssh_transport.SshTransport('51.21.199.245',22,'ubuntu',ssh_transport.fingerprint(host),c) as transport:assert transport.run('true')==b'OK'
  assert c=={};assert accepted[0][0]==method
 finally:closed.set();thread.join(6)
