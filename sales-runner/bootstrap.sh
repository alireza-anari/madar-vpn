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
manifest={'sales-runner/bootstrap.py': '2eda5336362ecbe9e7f4a39aff0efb5da2337231e98c2a68e9ff9b9cab2137fb', 'sales-runner/installer.py': 'f9c63e72bdd64eb673ef3e138917b4988a82d824e49ffd20c733533cb0b22729', 'sales-runner/wss_ipcert.py': 'bd5a37ba597082323248bfa2d3fc949b96ad57832d767c037c42109ded0c0007', 'sales-runner/artifacts.py': '90d0783a8566d504bca6ca3bc16f4fb0efe36616695ce6b5e94577c5641f69f0', 'sales-runner/ssh_transport.py': '2deae29b37657db6faeb89181632ffa10afc8b0016ad48cf56c38cf0fe9c0c6f', 'sales-runner/credential_envelope.py': '460576589df6fe3549dfc4a7d4f42bd663eb0d4f90fd5d96c3c5aeaaed0d075d', 'sales-runner/runner.py': '9761e16b65723817dac094447a50690a528df9b6f0036b26ef31fe70e9149eee', 'sales-node/agent.py': 'c2c74d50542b749c842cf1378efc06563d3968158b36ea525513cd849a880cc1', 'sales-node/xray.py': '9843f6059c1ba16d39a84d5fc773fe2f93ef13901187083086406ba82eff0084', 'sales-node/guard.py': '1b116deea04aab1b32cb326f6b2459a7ca9fcf94f9256d800d6c811ce5d63b1a', 'sales-node/policy.py': '5da7bed0eb45a36edbe63ffcadf01ccf1b8571a33a6e119b78ca34e86186aa60', 'sales-runner/templates/madar-sales-xray.service': 'b2e19c343efb1952a840b469ee5ba892fb4ba5ed73a13a5a997db7086d59452a', 'sales-runner/templates/madar-sales-node.service': '0116aedf3a7e39c7ba639ee8a7351977a23703250b340dddf4ab680630fd4452', 'sales-runner/templates/madar-sales-watchdog.service': '355fa950ff33b8abdb03281d343885bc5d07b9ac0a3e6530b2797dfdfd0110d5', 'sales-runner/templates/madar-sales-watchdog.timer': '89ab02334f6f8dc3e668b6be7fce81a0eaacff4517bcf8753a57953fa252edf4', 'sales-node/stats.py': '90c3d5ec52f057002441bf1897b51ab3dedad19ecfdee4013a815c646075557f', 'sales-node/quota.py': '4dbc6dbb9cff20a0b341190469cdcf22371256cf79cb904c44e37d1285a2dfaa', 'sales-node/quota_runtime.py': '4345f0819f281f32ec1a3fc8dcda770602c51d394ecc973cc84ee945db0e2359', 'sales-node/update_owned.py': '115cb8fb987fd9db92e814eb15036a42b8755e43021ed4836d909f5965d908ff', 'sales-node/reality_alt.py': '882ef89630900721793f5dcefd8280e116b9ae16f8f44f3d23e5b4940f992993', 'sales-node/ws_fallback.py': '51efd47b0b0514af5f39efd3c20045f07794997d85374668ed90aafee9921c9e', 'sales-node/shared443.py': '4dab8b822c54cee385f58f3293a2288f9d23a50f0f0f90c034f88bc25007083e', 'sales-runner/aws_network.py': '3e588aea6a7aba1c4d4d73f80118cd2bfc32dbf1f68199cdc0c42137d1159d6d'}
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
