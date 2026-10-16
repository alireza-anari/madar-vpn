"""Use the runner's temporary EC2 role; never accept or persist AWS access keys."""
import datetime,hashlib,hmac,ipaddress,json,re,urllib.parse,urllib.request,urllib.error,xml.etree.ElementTree as ET
NS={'e':'http://ec2.amazonaws.com/doc/2016-11-15/'}
class AwsNetworkError(ValueError):pass

def metadata(path,token=None,method='GET'):
 headers={'X-aws-ec2-metadata-token':token} if token else {'X-aws-ec2-metadata-token-ttl-seconds':'60'}
 req=urllib.request.Request('http://169.254.169.254/latest/'+path,headers=headers,method=method)
 # IMDS credentials must never traverse an environment proxy.
 with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req,timeout=3) as r:return r.read(16384).decode()

def identity():
 try:
  token=metadata('api/token',method='PUT')
  doc=json.loads(metadata('dynamic/instance-identity/document',token))
  role=metadata('meta-data/iam/security-credentials/',token).strip()
  if not re.fullmatch(r'[A-Za-z0-9+=,.@_-]{1,128}',role):raise ValueError()
  credentials=json.loads(metadata('meta-data/iam/security-credentials/'+role,token))
  source=str(ipaddress.IPv4Address(metadata('meta-data/public-ipv4',token).strip()))+'/32'
  return doc['region'],source,credentials
 except Exception:raise AwsNetworkError('AWS_ROLE_UNAVAILABLE') from None

def signed_request(region,credentials,params,now=None):
 if region!='eu-north-1':raise AwsNetworkError('AWS_REGION_UNSUPPORTED')
 now=now or datetime.datetime.now(datetime.timezone.utc)
 stamp=now.strftime('%Y%m%dT%H%M%SZ');day=stamp[:8];host='ec2.'+region+'.amazonaws.com'
 data=urllib.parse.urlencode({'Version':'2016-11-15',**params}).encode()
 headers={'content-type':'application/x-www-form-urlencoded; charset=utf-8','host':host,'x-amz-date':stamp,'x-amz-security-token':credentials['Token']}
 names=';'.join(sorted(headers));canonical=''.join(k+':'+headers[k].strip()+'\n' for k in sorted(headers))
 request='POST\n/\n\n'+canonical+'\n'+names+'\n'+hashlib.sha256(data).hexdigest()
 scope=day+'/'+region+'/ec2/aws4_request'
 string='AWS4-HMAC-SHA256\n'+stamp+'\n'+scope+'\n'+hashlib.sha256(request.encode()).hexdigest()
 key=('AWS4'+credentials['SecretAccessKey']).encode()
 for part in [day,region,'ec2','aws4_request']:key=hmac.new(key,part.encode(),hashlib.sha256).digest()
 signature=hmac.new(key,string.encode(),hashlib.sha256).hexdigest()
 headers['Authorization']='AWS4-HMAC-SHA256 Credential='+credentials['AccessKeyId']+'/'+scope+', SignedHeaders='+names+', Signature='+signature
 return urllib.request.Request('https://'+host+'/',data=data,headers=headers,method='POST')

def call(region,credentials,params):
 try:
  with urllib.request.urlopen(signed_request(region,credentials,params),timeout=15) as r:return ET.fromstring(r.read(2*1024*1024))
 except urllib.error.HTTPError as e:
  try:code=next((n.text for n in ET.fromstring(e.read(16384)).iter() if n.tag.rsplit('}',1)[-1]=='Code'),'')
  except Exception:code=''
  if code=='InvalidPermission.Duplicate':return None
  raise AwsNetworkError('AWS_NETWORK_PERMISSION_DENIED' if code in ('UnauthorizedOperation','AuthFailure','AccessDenied') else 'AWS_NETWORK_FAILED') from None
 except Exception:raise AwsNetworkError('AWS_NETWORK_FAILED') from None

def ensure_network(target,ssh_port,api=call,load_identity=identity):
 """Only modify a security group attached to the exact running target IP."""
 ip=str(ipaddress.IPv4Address(target)) if ':' not in target else None
 if not ip:return False
 region,source,credentials=load_identity()
 response=api(region,credentials,{'Action':'DescribeInstances','Filter.1.Name':'ip-address','Filter.1.Value.1':ip,'Filter.2.Name':'instance-state-name','Filter.2.Value.1':'running'})
 instances=response.findall('e:reservationSet/e:item/e:instancesSet/e:item',NS)
 matches=[i for i in instances if i.findtext('e:ipAddress',namespaces=NS)==ip]
 if not matches:return False
 if len(matches)!=1:raise AwsNetworkError('AWS_TARGET_AMBIGUOUS')
 groups=matches[0].findall('e:groupSet/e:item/e:groupId',NS)
 if not groups:raise AwsNetworkError('AWS_NETWORK_FAILED')
 group=groups[0].text
 if not re.fullmatch(r'sg-[a-f0-9]+',group or ''):raise AwsNetworkError('AWS_NETWORK_FAILED')
 for start,end,cidr in [(ssh_port,ssh_port,source),(443,443,'0.0.0.0/0')]:
  api(region,credentials,{'Action':'AuthorizeSecurityGroupIngress','GroupId':group,'IpPermissions.1.IpProtocol':'tcp','IpPermissions.1.FromPort':str(start),'IpPermissions.1.ToPort':str(end),'IpPermissions.1.IpRanges.1.CidrIp':cidr,'IpPermissions.1.IpRanges.1.Description':'Madar automatic enrollment'})
 return True
