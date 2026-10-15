"""SSH host identity is verified before credentials are used."""
import base64,hashlib,hmac,io,ipaddress,socket,paramiko

def assert_public_target(target):
    try:ip=ipaddress.ip_address(target)
    except ValueError:raise ValueError('INVALID_TARGET') from None
    if not ip.is_global or ip.is_multicast or getattr(ip,'ipv4_mapped',None):raise ValueError('INVALID_TARGET')
    return str(ip)

def fingerprint(key):return 'SHA256:'+base64.b64encode(hashlib.sha256(key.asbytes()).digest()).decode().rstrip('=')
def verify_fingerprint(key,expected):
    if not hmac.compare_digest(fingerprint(key),expected):raise ValueError('HOST_KEY_CHANGED')

def probe(target,port):
    ip=assert_public_target(target)
    with socket.create_connection((ip,port),timeout=10) as sock:
        transport=paramiko.Transport(sock)
        try:transport.start_client(timeout=10);return fingerprint(transport.get_remote_server_key())
        finally:transport.close()

class SshTransport:
    def __init__(self,target,port,username,expected,credentials):
        self.target=assert_public_target(target);self.port=port;self.username=username;self.expected=expected;self.credentials=credentials;self.transport=None
    def __enter__(self):
        sock=socket.create_connection((self.target,self.port),timeout=10)
        transport=paramiko.Transport(sock)
        self.transport=transport
        try:
            transport.start_client(timeout=10)
            verify_fingerprint(transport.get_remote_server_key(),self.expected)
            c=self.credentials
            if c['method']=='password':transport.auth_password(self.username,c['password'],fallback=False)
            else:
                key=None
                for cls in (paramiko.Ed25519Key,paramiko.ECDSAKey,paramiko.RSAKey):
                    try:key=cls.from_private_key(io.StringIO(c['key']),password=c.get('passphrase') or None);break
                    except (paramiko.SSHException,ValueError):continue
                if key is None:raise ValueError('INVALID_SSH_KEY')
                transport.auth_publickey(self.username,key)
            self.credentials.clear()
            if not transport.is_authenticated():raise ValueError('SSH_AUTH_FAILED')
            return self
        except Exception:
            self.credentials.clear();transport.close();raise
    def __exit__(self,*_):
        self.credentials.clear()
        if self.transport:self.transport.close()
    def run(self,command,stdin_data=b'',timeout=30):
        channel=self.transport.open_session(timeout=timeout);channel.settimeout(timeout)
        try:
            channel.exec_command(command.removeprefix('sudo -n ') if self.username=='root' else command)
            if stdin_data:channel.sendall(stdin_data)
            channel.shutdown_write()
            out=bytearray();err=bytearray()
            import time
            deadline=time.monotonic()+timeout
            while True:
                if time.monotonic()>deadline:raise ValueError('SSH_COMMAND_TIMEOUT')
                if channel.recv_ready():out.extend(channel.recv(32768))
                if channel.recv_stderr_ready():err.extend(channel.recv_stderr(32768))
                if len(out)>1048576 or len(err)>65536:raise ValueError('SSH_OUTPUT_LIMIT')
                if channel.exit_status_ready() and not channel.recv_ready() and not channel.recv_stderr_ready():break
                time.sleep(.01)
            code=channel.recv_exit_status()
            if code:raise ValueError('REMOTE_COMMAND_FAILED')
            return bytes(out)
        finally:channel.close()
