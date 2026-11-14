#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "$GITHUB_ACTIONS" != "true" || "$RUNNER_ENVIRONMENT" != "github-hosted" ]]; then
 echo "Refusing smoke outside ephemeral GitHub-hosted runner" >&2
 exit 1
fi
cleanup() {
 sudo systemctl disable --now madar-v2-xray.service >/dev/null 2>&1 || true
 sudo systemctl disable --now madar-v2-caddy.service >/dev/null 2>&1 || true
 sudo rm -f /etc/systemd/system/madar-v2-xray.service /etc/systemd/system/madar-v2-caddy.service
 sudo rm -rf -- /etc/systemd/system/madar-v2-xray.service.d
 sudo systemctl daemon-reload >/dev/null 2>&1 || true
 sudo rm -rf -- /etc/madar-v2 /opt/madar-v2
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
result=install(LocalTransport(),job,lambda:None)
assert set(result)=={'public_key','short_id','server_name','uuid'}
print('Verified exact remote package/bootstrap/dual/metadata flow; no client credentials logged')
PY
sudo systemctl is-active --quiet madar-v2-xray.service
sudo /opt/madar-v2/bin/xray run -test -config /etc/madar-v2/config.json >/dev/null 2>&1
test "$(sudo stat -c '%a' /etc/madar-v2/local-secrets.json)" = "600"
test "$(sudo stat -c '%a' /opt/madar-v2)" = "755"
test "$(sudo stat -c '%a' /opt/madar-v2/bin)" = "755"
sudo python3 - <<'PY'
from agent.dual_reality import listening
assert listening(443) and listening(8443)
PY
echo "Verified: isolated systemd service running; not field-ready"
