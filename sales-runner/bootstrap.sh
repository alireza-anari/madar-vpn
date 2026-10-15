#!/bin/bash
set -euo pipefail
umask 022
export DEBIAN_FRONTEND=noninteractive
REF=${1:-}
[[ "$REF" =~ ^[0-9a-f]{40}$ ]] || { echo INVALID_SOURCE_REF; exit 1; }
[ "$(id -u)" = 0 ] || { echo ROOT_REQUIRED; exit 1; }
. /etc/os-release
[ "$ID" = ubuntu ] && { [ "$VERSION_ID" = 22.04 ] || [ "$VERSION_ID" = 24.04 ]; } || { echo UNSUPPORTED_UBUNTU; exit 1; }
ROOT=/opt/madar-sales-runner
if [ -e "$ROOT" ] && [ ! -f "$ROOT/.bootstrap-owned" ]; then echo EXISTING_DIRECTORY; exit 1; fi
if [ -e /etc/systemd/system/madar-sales-runner.service ] && [ ! -f "$ROOT/.bootstrap-owned" ]; then echo EXISTING_UNIT; exit 1; fi
if ! id madar-sales-runner >/dev/null 2>&1; then
 useradd --system --user-group --home-dir /nonexistent --shell /usr/sbin/nologin madar-sales-runner
fi
[ "$(id -u madar-sales-runner)" -lt 1000 ] || { echo EXISTING_USER; exit 1; }
mkdir -p "$ROOT"
chmod 755 "$ROOT"
touch "$ROOT/.bootstrap-owned"
export MADAR_BOOTSTRAP_REF="$REF"
python3 - <<'SOURCE_FETCH'
import hashlib,json,os,pathlib,re,urllib.request
ref=os.environ['MADAR_BOOTSTRAP_REF']
assert re.fullmatch('[0-9a-f]{40}',ref)
manifest={'sales-runner/bootstrap.py': '7c6470d3bf6f2df5692deca6b3111b02de3995693fb012e29cade4408f231f56', 'sales-runner/installer.py': 'a7225b808dea583edc2edaff688ddf8cc289362ff243d3b31c1ed11c61287e4d', 'sales-runner/artifacts.py': '90d0783a8566d504bca6ca3bc16f4fb0efe36616695ce6b5e94577c5641f69f0', 'sales-runner/ssh_transport.py': '2deae29b37657db6faeb89181632ffa10afc8b0016ad48cf56c38cf0fe9c0c6f', 'sales-runner/credential_envelope.py': '460576589df6fe3549dfc4a7d4f42bd663eb0d4f90fd5d96c3c5aeaaed0d075d', 'sales-runner/runner.py': '837bb1d0717c7451322ae49f683e782ff4be216e5b80075e8049b7b79cda0038', 'sales-node/agent.py': 'db70ce01fa75d3edd05dacc9f65da904327607366883776e0459fff874b5b4ea', 'sales-node/xray.py': 'be0860d0abccc0896427be92b3f502e2a9dced8c2648cd68c38bf3e4f76ae7d1', 'sales-node/guard.py': 'abbd60fcf6f06838a5a48d29fd1a7c18d721ea1794e10bdcd168c28eddf7edce', 'sales-node/policy.py': '1f79305244934ff4b08e06559cfa35bdcf594c673798b030fc54263a35cdad51', 'sales-runner/templates/madar-sales-xray.service': 'b2e19c343efb1952a840b469ee5ba892fb4ba5ed73a13a5a997db7086d59452a', 'sales-runner/templates/madar-sales-node.service': 'e9a2296bee482feedba791dddda1b6729bdbd74903ac57d99dfff519dd2251dc', 'sales-runner/templates/madar-sales-watchdog.service': 'a6c1f82c4dee5179cf4f43a4383515a49c2617278939f3a5a8e43b218fda9563', 'sales-runner/templates/madar-sales-watchdog.timer': '89ab02334f6f8dc3e668b6be7fce81a0eaacff4517bcf8753a57953fa252edf4'}
root=pathlib.Path('/opt/madar-sales-runner')
for name,digest in manifest.items():
 with urllib.request.urlopen('https://raw.githubusercontent.com/alireza-anari/madar-vpn/'+ref+'/'+name,timeout=30) as response:data=response.read(1048576)
 if hashlib.sha256(data).hexdigest()!=digest:raise SystemExit('SOURCE_CHECKSUM_MISMATCH')
 path=root/name;path.parent.mkdir(parents=True,exist_ok=True)
 temp=path.with_name(path.name+'.installing');temp.write_bytes(data);temp.chmod(0o644);temp.replace(path)
(root/'source-ref').write_text(ref+'\n')
SOURCE_FETCH
if ! python3 -m venv "$ROOT/venv"; then
 apt-get update -qq
 apt-get install -y --no-install-recommends python3-venv
 python3 -m venv "$ROOT/venv"
fi
"$ROOT/venv/bin/python" -m pip install --disable-pip-version-check paramiko==5.0.0 cryptography==50.0.2
exec "$ROOT/venv/bin/python" "$ROOT/sales-runner/bootstrap.py"
