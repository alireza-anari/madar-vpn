import datetime,urllib.parse,xml.etree.ElementTree as ET,pytest
from aws_network import ensure_network,signed_request,AwsNetworkError
CREDS={'AccessKeyId':'AKIDTEST','SecretAccessKey':'test-secret','Token':'temporary-token'}
def response(ip='8.8.8.8'):
 return ET.fromstring(f'<DescribeInstancesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/"><reservationSet><item><instancesSet><item><ipAddress>{ip}</ipAddress><groupSet><item><groupId>sg-123abc</groupId></item></groupSet></item></instancesSet></item></reservationSet></DescribeInstancesResponse>')
def test_exact_target_opens_only_required_ports_and_limits_ssh_to_runner():
 calls=[]
 def api(region,credentials,params):calls.append(params);return response()
 assert ensure_network('8.8.8.8',22,api,lambda:('eu-north-1','56.228.6.3/32',CREDS))
 assert [p['IpPermissions.1.FromPort'] for p in calls[1:]]==['22','443','20000']
 assert calls[1]['IpPermissions.1.IpRanges.1.CidrIp']=='56.228.6.3/32'
 assert all(p['GroupId']=='sg-123abc' for p in calls[1:])
 calls.clear()
 assert not ensure_network('1.1.1.1',22,api,lambda:('eu-north-1','56.228.6.3/32',CREDS))
 assert len(calls)==1

def test_sigv4_signs_session_token_and_post_body():
 request=signed_request('eu-north-1',CREDS,{'Action':'DescribeInstances'},datetime.datetime(2026,10,16,tzinfo=datetime.timezone.utc))
 assert request.full_url=='https://ec2.eu-north-1.amazonaws.com/'
 assert 'x-amz-security-token' in request.get_header('Authorization')
 assert request.get_header('X-amz-security-token')=='temporary-token'
 assert urllib.parse.parse_qs(request.data.decode())['Action']==['DescribeInstances']
 assert 'test-secret' not in str(request.headers)
 with pytest.raises(AwsNetworkError,match='AWS_REGION_UNSUPPORTED'):signed_request('us-east-1',CREDS,{})

def test_duplicate_rule_and_permission_error_are_safe(monkeypatch):
 import aws_network,io,urllib.error
 def duplicate(req,**kwargs):raise urllib.error.HTTPError(req.full_url,400,'bad',{},io.BytesIO(b'<Response xmlns="urn:aws"><Errors><Error><Code>InvalidPermission.Duplicate</Code></Error></Errors></Response>'))
 monkeypatch.setattr(aws_network.urllib.request,'urlopen',duplicate)
 assert aws_network.call('eu-north-1',CREDS,{'Action':'AuthorizeSecurityGroupIngress'}) is None
 def denied(req,**kwargs):raise urllib.error.HTTPError(req.full_url,403,'bad',{},io.BytesIO(b'<Response><Errors><Error><Code>UnauthorizedOperation</Code></Error></Errors></Response>'))
 monkeypatch.setattr(aws_network.urllib.request,'urlopen',denied)
 with pytest.raises(AwsNetworkError,match='AWS_NETWORK_PERMISSION_DENIED'):aws_network.call('eu-north-1',CREDS,{})

def test_unavailable_role_does_not_expose_metadata_errors(monkeypatch):
 import aws_network
 def bad(*a,**k):raise RuntimeError('credential-canary')
 monkeypatch.setattr(aws_network,'metadata',bad)
 with pytest.raises(AwsNetworkError,match='^AWS_ROLE_UNAVAILABLE$'):aws_network.identity()

def test_runner_configures_network_before_ssh_probe(monkeypatch):
 import aws_network,runner
 calls=[]
 monkeypatch.setattr(aws_network,'ensure_network',lambda ip,port:calls.append('network') or True)
 monkeypatch.setattr(runner,'probe',lambda ip,port:calls.append('ssh') or 'SHA256:test')
 class Api:
  def post(self,path,body):calls.append(body['safeCode']);return {}
 job={'id':'j','leaseId':'l','kind':'probe','targetIp':'8.8.8.8','port':22}
 assert runner.run_job(job,Api(),None)=='ready'
 assert calls==['network','ssh','AWS_NETWORK_READY']
