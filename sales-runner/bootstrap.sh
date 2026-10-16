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
manifest={'sales-runner/bootstrap.py': '2eda5336362ecbe9e7f4a39aff0efb5da2337231e98c2a68e9ff9b9cab2137fb', 'sales-runner/installer.py': 'bf5ae3c7195a3919bdffa546bc2655e0c6efed1e788c34e94ce8923965bd43d0', 'sales-runner/artifacts.py': '90d0783a8566d504bca6ca3bc16f4fb0efe36616695ce6b5e94577c5641f69f0', 'sales-runner/ssh_transport.py': '2deae29b37657db6faeb89181632ffa10afc8b0016ad48cf56c38cf0fe9c0c6f', 'sales-runner/credential_envelope.py': '460576589df6fe3549dfc4a7d4f42bd663eb0d4f90fd5d96c3c5aeaaed0d075d', 'sales-runner/runner.py': '9761e16b65723817dac094447a50690a528df9b6f0036b26ef31fe70e9149eee', 'sales-node/agent.py': '91fec3b9f9e4373528b71aa035797f9d34a5f0e703f49335b1e1845f14a58c98', 'sales-node/xray.py': '9843f6059c1ba16d39a84d5fc773fe2f93ef13901187083086406ba82eff0084', 'sales-node/guard.py': '1b116deea04aab1b32cb326f6b2459a7ca9fcf94f9256d800d6c811ce5d63b1a', 'sales-node/policy.py': '143366e38f49edcfe22bb525053f0ea64e69bf3f6f555f4de324e8bc689475ac', 'sales-runner/templates/madar-sales-xray.service': 'b2e19c343efb1952a840b469ee5ba892fb4ba5ed73a13a5a997db7086d59452a', 'sales-runner/templates/madar-sales-node.service': 'e9a2296bee482feedba791dddda1b6729bdbd74903ac57d99dfff519dd2251dc', 'sales-runner/templates/madar-sales-watchdog.service': 'a6c1f82c4dee5179cf4f43a4383515a49c2617278939f3a5a8e43b218fda9563', 'sales-runner/templates/madar-sales-watchdog.timer': '89ab02334f6f8dc3e668b6be7fce81a0eaacff4517bcf8753a57953fa252edf4', 'sales-node/stats.py': '90c3d5ec52f057002441bf1897b51ab3dedad19ecfdee4013a815c646075557f', 'sales-node/quota.py': '0fb52d8279fa7083e4fa50f56b0a491ec9fca82a4c1b75502184bfa763bc2461', 'sales-node/quota_runtime.py': '0c87a9ab07d0d9839930bfc2f6604dc8e67ae7db7dccbe2b70acadfe2b0959aa', 'sales-node/update_owned.py': '6fd5517c8fd561aa99a9884747a8233f580a4e5217225d0c8650f49e3eacfe8c', 'sales-node/shared443.py': 'a356b376d2774e21e5c6f4fdb5062eb2ecaa82dd9edec104af3f05173715552c', 'sales-runner/aws_network.py': 'b3a69358d57804e69006c0158e8bfd303f9cf8ba773d8cff5559506e92947ddb'}
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
if [ "${2:-}" = --update ]; then
 exec "$ROOT/venv/bin/python" "$ROOT/sales-runner/bootstrap.py" --update
fi
exec "$ROOT/venv/bin/python" "$ROOT/sales-runner/bootstrap.py"
