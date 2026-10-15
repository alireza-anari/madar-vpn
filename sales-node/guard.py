"""Xray cannot start with expired runtime authorization, including after reboot."""
import json,pathlib,time
if __name__=='__main__':
    try:
        auth=json.loads(pathlib.Path('/run/madar-sales-node/authorization.json').read_text())
        if auth['expiresAt']<=int(time.time()) or not auth['clients']:raise ValueError()
    except Exception:raise SystemExit(1)
