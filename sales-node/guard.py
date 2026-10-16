"""Fail closed before Xray starts, including the zero-user owned shared frontend."""
import json,pathlib,time

def guard_allowed(config,authorization,frontend,now):
    fresh=config.get('shared443') is True and config.get('frontendManaged') is True
    if fresh:
        if not isinstance(authorization,dict) or authorization.get('mode')!='shared-frontend' or authorization.get('nodeId')!=config.get('nodeId'):return False
        if not isinstance(frontend,dict):return False
        candidates=[i for i in frontend.get('inbounds',[]) if i.get('port')==443 and i.get('protocol')=='vless' and i.get('streamSettings',{}).get('security')=='reality']
        if len(candidates)!=1:return False
        inbound=candidates[0]
        if inbound.get('listen') not in ('0.0.0.0','::'):return False
        clients=inbound.get('settings',{}).get('clients')
        return isinstance(clients,list) and not clients
    if isinstance(authorization,dict) and authorization.get('mode')=='shared-frontend':return False
    try:return authorization['expiresAt']>now and bool(authorization['clients'])
    except Exception:return False

def main(now=None):
    now=int(time.time()) if now is None else now
    try:
        try:config=json.loads(pathlib.Path('/etc/madar-sales-node/config.json').read_text())
        except Exception:config={}
        authorization=json.loads(pathlib.Path('/run/madar-sales-node/authorization.json').read_text())
        frontend=json.loads(pathlib.Path('/run/madar-sales-node/xray.json').read_text()) if config.get('shared443') is True and config.get('frontendManaged') is True else None
        if not guard_allowed(config,authorization,frontend,now):raise ValueError()
    except Exception:raise SystemExit(1)
    return True

if __name__=='__main__':main()
