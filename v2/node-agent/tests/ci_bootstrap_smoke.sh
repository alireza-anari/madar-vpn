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
 sudo systemctl daemon-reload >/dev/null 2>&1 || true
 sudo rm -rf -- /etc/madar-v2 /opt/madar-v2
 sudo userdel madar-v2-xray >/dev/null 2>&1 || true
 sudo userdel madar-v2-caddy >/dev/null 2>&1 || true
}
trap cleanup EXIT
# Test-only placeholder, NOT an externally accepted VPS origin.
sudo python3 -m agent.bootstrap --test-only --apply --node-id test-ci-native --public-ip 8.8.4.4 --reality-port 18443
sudo systemctl is-active --quiet madar-v2-xray.service
sudo /opt/madar-v2/bin/xray run -test -config /etc/madar-v2/config.json >/dev/null 2>&1
test "$(sudo stat -c '%a' /etc/madar-v2/local-secrets.json)" = "600"
echo "Verified: isolated systemd service running; not field-ready"
