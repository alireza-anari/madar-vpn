#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "$GITHUB_ACTIONS" != "true" || "$RUNNER_ENVIRONMENT" != "github-hosted" ]]; then
 echo "Refusing smoke outside ephemeral GitHub-hosted runner" >&2
 exit 1
fi
cleanup() {
 sudo systemctl disable --now madar-v2-runtime.service madar-v2-runtime-watchdog.timer madar-v2-runtime-network.timer >/dev/null 2>&1 || true
 sudo systemctl stop madar-v2-runtime-network.service >/dev/null 2>&1 || true
 sudo rm -f /etc/systemd/system/madar-v2-runtime.service /etc/systemd/system/madar-v2-runtime-watchdog.service /etc/systemd/system/madar-v2-runtime-watchdog.timer /etc/systemd/system/madar-v2-runtime-network.service /etc/systemd/system/madar-v2-runtime-network.timer
 sudo systemctl disable --now madar-v2-xray.service >/dev/null 2>&1 || true
 sudo systemctl disable --now madar-v2-caddy.service >/dev/null 2>&1 || true
 sudo rm -f /etc/systemd/system/madar-v2-xray.service /etc/systemd/system/madar-v2-caddy.service
 sudo rm -rf -- /etc/systemd/system/madar-v2-xray.service.d
 sudo systemctl daemon-reload >/dev/null 2>&1 || true
 sudo rm -rf -- /etc/madar-v2 /opt/madar-v2 /var/lib/madar-v2
 sudo userdel madar-v2-xray >/dev/null 2>&1 || true
 sudo userdel madar-v2-caddy >/dev/null 2>&1 || true
}
trap cleanup EXIT
# Test-only placeholder, NOT an externally accepted VPS origin.
python3 - <<'PY'
import pathlib,subprocess,sys,uuid
sys.path.insert(0,str(pathlib.Path('../runner').resolve()))
from consumer import install
class LocalTransport:
    def run(self,command,stdin_data=b'',timeout=30):
        # Exact SSH command and package, on this ephemeral CI host only.
        result=subprocess.run(command,shell=True,input=stdin_data,capture_output=True,timeout=timeout,check=True)
        return result.stdout
job=dict(id=str(uuid.uuid4()),nodeId='test-ci-native',targetIp='8.8.4.4',
         mode='fresh',port=22,username='root',kind='v2-install')
try:
    import base64
    # Disposable, non-production HKDF-shaped node key. The Worker is not used.
    test_key=base64.urlsafe_b64encode(bytes([73])*32).rstrip(b'=').decode()
    result=install(LocalTransport(),job,lambda:None,node_key=test_key)
except Exception:
    # CI has no server/user credentials. Surface the fixed ReconcileError
    # chain on the disposable host, never enable this on a user VPS.
    subprocess.run(['sudo','python3','-c',"from agent.fresh_dual import enable; enable('test-ci-native','8.8.4.4')"],check=False)
    raise
assert set(result)=={'public_key','short_id','server_name','uuid'}
print('Verified exact remote package/bootstrap/dual/metadata flow; no client credentials logged')
PY
sudo systemctl is-active --quiet madar-v2-xray.service
sudo systemctl is-active --quiet madar-v2-runtime.service
sudo systemctl is-enabled --quiet madar-v2-runtime-watchdog.timer
sudo systemctl is-enabled --quiet madar-v2-runtime-network.timer
test "$(sudo stat -c '%a' /etc/madar-v2/node.key)" = "600"
sudo test -f /opt/madar-v2/runtime/agent/runtime.py
sudo python3 - <<'PY'
import json,pathlib,subprocess,sys,tempfile
sys.path.insert(0,'/opt/madar-v2/runtime')
from agent.account_policy import compile_dual_account_config
root=pathlib.Path('/etc/madar-v2')
secrets=json.loads((root/'local-secrets.json').read_text())
config=compile_dual_account_config(secrets,[])
ports=[r['port'] for r in config['inbounds']]
assert ports==[8443,443,10085],ports
assert config['inbounds'][2]['listen']=='127.0.0.1'
with tempfile.NamedTemporaryFile(mode='w',suffix='.json',delete=True) as tmp:
  json.dump(config,tmp);tmp.flush()
  subprocess.run(['/opt/madar-v2/bin/xray','run','-test','-config',tmp.name],
                 check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
# Most important: a REAL customer UUID on both public REALITY ports must
# pass the pinned Xray's native validation, not only our Python unit test.
with tempfile.NamedTemporaryFile(mode='w',suffix='.json',delete=True) as tmp:
  enrolled=compile_dual_account_config(secrets,[{
    'subscription_id':'sub-ci-smoke','uuid':secrets['clients'][0]}])
  assert enrolled['inbounds'][0]['settings']['users'][0]['id']==secrets['clients'][0]
  assert enrolled['inbounds'][1]['settings']['users'][0]['id']==secrets['clients'][0]
  json.dump(enrolled,tmp);tmp.flush()
  subprocess.run(['/opt/madar-v2/bin/xray','run','-test','-config',tmp.name],
                 check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
PY
sudo /opt/madar-v2/bin/xray run -test -config /etc/madar-v2/config.json >/dev/null 2>&1
test "$(sudo stat -c '%a' /etc/madar-v2/local-secrets.json)" = "600"
test "$(sudo stat -c '%a' /opt/madar-v2)" = "755"
test "$(sudo stat -c '%a' /opt/madar-v2/bin)" = "755"
sudo python3 - <<'PY'
from agent.dual_reality import listening
assert listening(443) and listening(8443)
PY
echo "Verified: isolated systemd service running; not field-ready"
sudo env GITHUB_ACTIONS="$GITHUB_ACTIONS" RUNNER_ENVIRONMENT="$RUNNER_ENVIRONMENT" python3 -B tests/ci_runtime_outage.py
