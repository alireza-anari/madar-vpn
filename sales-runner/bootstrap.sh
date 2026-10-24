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
manifest={'sales-runner/bootstrap.py': '2eda5336362ecbe9e7f4a39aff0efb5da2337231e98c2a68e9ff9b9cab2137fb', 'sales-runner/installer.py': 'bf5ae3c7195a3919bdffa546bc2655e0c6efed1e788c34e94ce8923965bd43d0', 'sales-runner/artifacts.py': '90d0783a8566d504bca6ca3bc16f4fb0efe36616695ce6b5e94577c5641f69f0', 'sales-runner/ssh_transport.py': '2deae29b37657db6faeb89181632ffa10afc8b0016ad48cf56c38cf0fe9c0c6f', 'sales-runner/credential_envelope.py': '460576589df6fe3549dfc4a7d4f42bd663eb0d4f90fd5d96c3c5aeaaed0d075d', 'sales-runner/runner.py': '9761e16b65723817dac094447a50690a528df9b6f0036b26ef31fe70e9149eee', 'sales-node/agent.py': 'c2c74d50542b749c842cf1378efc06563d3968158b36ea525513cd849a880cc1', 'sales-node/xray.py': '9843f6059c1ba16d39a84d5fc773fe2f93ef13901187083086406ba82eff0084', 'sales-node/guard.py': '1b116deea04aab1b32cb326f6b2459a7ca9fcf94f9256d800d6c811ce5d63b1a', 'sales-node/policy.py': '143366e38f49edcfe22bb525053f0ea64e69bf3f6f555f4de324e8bc689475ac', 'sales-runner/templates/madar-sales-xray.service': 'b2e19c343efb1952a840b469ee5ba892fb4ba5ed73a13a5a997db7086d59452a', 'sales-runner/templates/madar-sales-node.service': '0116aedf3a7e39c7ba639ee8a7351977a23703250b340dddf4ab680630fd4452', 'sales-runner/templates/madar-sales-watchdog.service': '355fa950ff33b8abdb03281d343885bc5d07b9ac0a3e6530b2797dfdfd0110d5', 'sales-runner/templates/madar-sales-watchdog.timer': '89ab02334f6f8dc3e668b6be7fce81a0eaacff4517bcf8753a57953fa252edf4', 'sales-node/stats.py': '90c3d5ec52f057002441bf1897b51ab3dedad19ecfdee4013a815c646075557f', 'sales-node/quota.py': '4dbc6dbb9cff20a0b341190469cdcf22371256cf79cb904c44e37d1285a2dfaa', 'sales-node/quota_runtime.py': 'ea61c69ffb89ae21107fe6e1981d611f5279fcab59f937cc6a33592d4616d6fe', 'sales-node/update_owned.py': '60eabfffa4c1aa69318c987750f3378db826ac01975b85350ceb7eefddeb6ff9', 'sales-node/shared443.py': 'e934b7ac0dd51c82b6ed93890075498ea89abfcd5f58710982bb77de5d3b87fb', 'sales-runner/aws_network.py': '44a0ccf976ee662b67b2112901f00b5c62aed4af8d5bc5144df16042fb986e13'}
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
