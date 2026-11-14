import importlib.util
import pathlib
import sys
import socket
import unittest
import hashlib
import hmac
import json
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parent))
import one_shot
from unittest.mock import patch

HERE=pathlib.Path(__file__).resolve().parent
sys.path.insert(0,str(HERE.parents[1]/'sales-runner'))
spec=importlib.util.spec_from_file_location('v2_runner',HERE/'consumer.py')
consumer=importlib.util.module_from_spec(spec)
spec.loader.exec_module(consumer)

class Api:
    def __init__(self):self.reports=[]
    def post(self,path,payload):self.reports.append((path,payload));return {'ok':True}

class RunnerTests(unittest.TestCase):
    def test_probe_job_does_not_require_private_key(self):
        secret='s'*48
        job={'id':'12345678-1234-4123-8123-123456789012','mode':'fresh','kind':'probe'}
        payload=json.dumps(job,separators=(',',':'))
        signature=hmac.new(secret.encode(),payload.encode(),hashlib.sha256).hexdigest()
        env={'MADAR_V2_URL':one_shot.ORIGIN,'MADAR_V2_RUNNER_SERVICE_SECRET':secret}
        with patch.object(one_shot,'Api') as api_class, patch.object(one_shot,'run_job',return_value='ready') as run:
            api=api_class.return_value
            api.post.return_value={'payload':payload,'signature':signature}
            self.assertEqual(one_shot.execute(job['id'],env),'ready')
            run.assert_called_once_with(job,api,None,network_mode='none')

    def test_install_job_requires_private_key_only_after_signed_lease(self):
        secret='s'*48
        job={'id':'12345678-1234-4123-8123-123456789012','mode':'fresh','kind':'v2-install'}
        payload=json.dumps(job,separators=(',',':'))
        signature=hmac.new(secret.encode(),payload.encode(),hashlib.sha256).hexdigest()
        env={'MADAR_V2_URL':one_shot.ORIGIN,'MADAR_V2_RUNNER_SERVICE_SECRET':secret}
        with patch.object(one_shot,'Api') as api_class, patch.object(one_shot,'run_job') as run:
            api=api_class.return_value
            api.post.return_value={'payload':payload,'signature':signature}
            with self.assertRaisesRegex(ValueError,'PRIVATE_KEY_MISSING'):
                one_shot.execute(job['id'],env)
            api.post.assert_called_once()
            run.assert_not_called()

    def test_private_key_loader_accepts_pkcs8_and_pkcs1_pem(self):
        key=rsa.generate_private_key(public_exponent=65537,key_size=2048)
        pkcs8=key.private_bytes(serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,serialization.NoEncryption()).decode()
        pkcs1=key.private_bytes(serialization.Encoding.PEM,
            serialization.PrivateFormat.TraditionalOpenSSL,serialization.NoEncryption()).decode()
        self.assertTrue(hasattr(one_shot.load_private_key(pkcs8),'decrypt'))
        self.assertTrue(hasattr(one_shot.load_private_key(pkcs1),'decrypt'))
        with self.assertRaisesRegex(ValueError,'PRIVATE_KEY_MISSING'):
            one_shot.load_private_key('')
        with self.assertRaisesRegex(ValueError,'PRIVATE_KEY_INVALID'):
            one_shot.load_private_key('not a private key')
    def job(self,kind='v2-install'):
        return dict(id='12345678-1234-4123-8123-123456789012',leaseId='lease',kind=kind,
                    nodeId='test-node01',targetIp='8.8.8.8',mode='fresh',port=22,username='root',
                    hostFingerprint='SHA256:'+'a'*43,credentialsExpireAt=200,encryptedCredentials='ciphertext')
    def test_expired_credentials_never_connect_and_clear_envelope(self):
        job=self.job();api=Api()
        with patch.object(consumer,'SshTransport',side_effect=AssertionError('SSH must not run')):
            self.assertEqual(consumer.run_job(job,api,None,clock=lambda:201),'failed')
        self.assertIsNone(job['encryptedCredentials'])
        self.assertEqual(api.reports[-1][1]['state'],'failed')
    def test_probe_never_decrypts_or_authenticates(self):
        job=self.job('probe');api=Api()
        with patch.object(consumer,'ensure_network',return_value=False),patch.object(consumer,'probe',return_value='SHA256:'+'a'*43),patch.object(consumer,'decrypt_credentials',side_effect=AssertionError('No decrypt')):
            self.assertEqual(consumer.run_job(job,api,None,clock=lambda:100),'ready')
        self.assertEqual(api.reports[-1][1]['details']['fingerprint'],'SHA256:'+'a'*43)
    def test_install_uses_shared_transport_and_sanitizes_failures(self):
        job=self.job();api=Api();secret={'method':'password','password':'canary'}
        with patch.object(consumer,'ensure_network',return_value=False),patch.object(consumer,'decrypt_credentials',return_value=secret),patch.object(consumer,'SshTransport') as ssh,patch.object(consumer,'install',side_effect=RuntimeError('canary')):
            self.assertEqual(consumer.run_job(job,api,None,clock=lambda:100),'failed')
            self.assertEqual(ssh.call_args.args[:4],('8.8.8.8',22,'root','SHA256:'+'a'*43))
        self.assertEqual(secret,{})
        self.assertNotIn('canary',str(api.reports))
    def test_refuses_v1_job_and_nonisolated_configuration(self):
        job=self.job('install');api=Api()
        with patch.object(consumer,'SshTransport',side_effect=AssertionError('No SSH')):
            self.assertEqual(consumer.run_job(job,api,None,clock=lambda:100),'failed')
        for base in ['https://madar-sales-bot.alirezaanari117.workers.dev','http://localhost']:
            with self.assertRaises(ValueError):consumer.validate_config({'baseUrl':base})

class SafeProbeFailureTests(unittest.TestCase):
    def test_timeout_is_explicit_and_no_exception_message_is_emitted(self):
        api=Api()
        job={'id':'12345678-1234-4123-8123-123456789012','leaseId':'lease','kind':'probe',
             'nodeId':'test-aws01','targetIp':'8.8.8.8','mode':'fresh','port':22,
             'username':'ubuntu','credentialsExpireAt':200,'encryptedCredentials':None}
        with patch.object(consumer,'probe',side_effect=socket.timeout('sensitive diagnostic')):
            self.assertEqual(consumer.run_job(job,api,None,clock=lambda:100,network_mode='none'),'failed')
        self.assertEqual(api.reports[-1][1]['safeCode'],'SSH_TIMEOUT')
        self.assertNotIn('sensitive diagnostic',repr(api.reports))
    def test_safe_probe_classification(self):
        import errno,socket,paramiko
        examples=[(socket.timeout('hidden'),'SSH_TIMEOUT'),
           (ConnectionRefusedError(errno.ECONNREFUSED,'hidden'),'SSH_REFUSED'),
           (OSError(errno.ENETUNREACH,'hidden'),'SSH_UNREACHABLE'),
           (paramiko.SSHException('hidden'),'SSH_HANDSHAKE_FAILED'),
           (RuntimeError('secret value'),'SSH_PROBE_FAILED')]
        for exc,code in examples:
            self.assertEqual(consumer.safe_failure_code(exc,'probe'),code)
            self.assertEqual(consumer.safe_failure_code(exc,'v2-install'),code if code in ('SSH_TIMEOUT','SSH_REFUSED','SSH_UNREACHABLE') else 'INSTALLATION_FAILED')

if __name__=='__main__':unittest.main()

class SafeInstallFailureTests(unittest.TestCase):
    def test_remote_preparation_failure_returns_only_a_safe_stage(self):
        import contextlib, io, os, types
        output=io.StringIO()
        previous=os.umask(0o077)
        self.addCleanup(os.umask,previous)
        with patch('sys.argv',['remote',json.dumps({'id':'test'})]), \
             patch.dict(sys.modules,{'fcntl':types.SimpleNamespace()}), \
             patch('builtins.open',side_effect=OSError('canary-password')), \
             contextlib.redirect_stdout(output):
            exec(consumer.REMOTE,{})
        self.assertEqual(json.loads(output.getvalue()),{'error':'REMOTE_PACKAGE_FAILED'})
        self.assertNotIn('canary',output.getvalue())

    def test_remote_stage_failure_survives_without_untrusted_output(self):
        class Transport:
            def run(self,*args,**kwargs):return b'{"error":"REMOTE_DUAL_FAILED"}'
        with self.assertRaises(ValueError) as failure:
            consumer.install(Transport(),RunnerTests().job(),lambda:None)
        self.assertEqual(consumer.safe_failure_code(failure.exception,'v2-install','remote'),'REMOTE_DUAL_FAILED')

    def test_ssh_password_auth_failure_is_safe(self):
        import paramiko
        self.assertEqual(consumer.safe_failure_code(paramiko.AuthenticationException('secret'),'v2-install','ssh'),'SSH_AUTH_FAILED')
    def test_installation_stages_without_sensitive_exception_content(self):
        examples={'credentials':'CREDENTIAL_DECRYPT_FAILED','ssh':'SSH_LOGIN_FAILED','remote':'REMOTE_INSTALL_FAILED','report':'INSTALL_REPORT_FAILED'}
        for stage,code in examples.items():
            self.assertEqual(consumer.safe_failure_code(RuntimeError('secret password'),'v2-install',stage),code)
    def test_report_installs_safe_failure_without_leaking_raw_exception(self):
        api=Api()
        job={'id':'12345678-1234-4123-8123-123456789012','leaseId':'lease','kind':'v2-install',
             'nodeId':'test-abc01','targetIp':'8.8.8.8','mode':'fresh','port':22,
             'username':'root','credentialsExpireAt':200,'encryptedCredentials':'ciphertext',
             'hostFingerprint':'SHA256:'+'a'*43}
        with patch.object(consumer,'decrypt_credentials',return_value={'method':'password','password':'canary'}),patch.object(consumer,'SshTransport',side_effect=__import__('paramiko').AuthenticationException('canary')):
            self.assertEqual(consumer.run_job(job,api,None,clock=lambda:100,network_mode='none'),'failed')
        self.assertEqual(api.reports[-1][1]['safeCode'],'SSH_AUTH_FAILED')
        self.assertNotIn('canary',str(api.reports))

class ReadOnlyDiagnosisTests(unittest.TestCase):
    def test_diagnose_never_executes_install(self):
        job={'id':'12345678-1234-4123-8123-123456789012','leaseId':'lease',
             'kind':'v2-install','diagnostic':True,'nodeId':'test-webdade2',
             'targetIp':'8.8.8.8','mode':'fresh','port':22,'username':'root',
             'hostFingerprint':'SHA256:'+'a'*43,'credentialsExpireAt':200,
             'encryptedCredentials':'ciphertext'}
        api=Api()
        with patch.object(consumer,'decrypt_credentials',return_value={'method':'password','password':'SECRET'}),\
             patch.object(consumer,'SshTransport') as ssh,\
             patch.object(consumer,'install',side_effect=AssertionError('installation forbidden')) as install:
            ssh.return_value.__enter__.return_value.run.return_value=b'{"code":"DIAG_PORT_443_BUSY"}'
            self.assertEqual(consumer.run_job(job,api,None,clock=lambda:100,network_mode='none'),'ready')
            install.assert_not_called()
        self.assertEqual(api.reports[-1][1]['safeCode'],'DIAG_PORT_443_BUSY')
        self.assertEqual(api.reports[-1][1]['state'],'ready')
        self.assertNotIn('SECRET',str(api.reports))
    def test_diagnostic_output_is_strictly_allowlisted(self):
        class Transport:
            def __init__(self,out):self.out=out
            def run(self,cmd,timeout=0):
                self.command=cmd
                return self.out
        for raw in [b'{"code":"DIAG_PRECHECK_OK"}',b'{"code":"DIAG_EXISTING_VPN"}']:
            tr=Transport(raw)
            self.assertIn(consumer.diagnose(tr,lambda:None),consumer.DIAG_CODES)
            self.assertIn('python3 -c',tr.command)
        for raw in [b'{"code":"arbitrary error"}',b'{"code":"DIAG_PRECHECK_OK","secret":"x"}',b'not-json']:
            with self.assertRaises((ValueError,TypeError)):
                consumer.diagnose(Transport(raw),lambda:None)
