import hashlib,io,urllib.request,zipfile
VERSION='26.3.27'
ARTIFACTS={
 'x86_64':('Xray-linux-64.zip','23cd9af937744d97776ee35ecad4972cf4b2109d1e0fe6be9930467608f7c8ae'),
 'aarch64':('Xray-linux-arm64-v8a.zip','4d30283ae614e3057f730f67cd088a42be6fdf91f8639d82cb69e48cde80413c'),
}
def verify_artifact(data,expected):
 if hashlib.sha256(data).hexdigest()!=expected:raise ValueError('CHECKSUM_MISMATCH')
 return data
def download(arch,version):
 if version!=VERSION or arch not in ARTIFACTS:raise ValueError('ARTIFACT_NOT_PINNED')
 name,digest=ARTIFACTS[arch]
 with urllib.request.urlopen(f'https://github.com/XTLS/Xray-core/releases/download/v{VERSION}/{name}',timeout=120) as r:data=r.read(100*1024*1024+1)
 if len(data)>100*1024*1024:raise ValueError('ARTIFACT_TOO_LARGE')
 verify_artifact(data,digest)
 with zipfile.ZipFile(io.BytesIO(data)) as archive:return {name:archive.read(name) for name in ['xray','geoip.dat','geosite.dat']}
