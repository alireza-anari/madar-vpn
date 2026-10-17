import argparse,json,pathlib,time,urllib.request
from policy import verify_policy
from xray import Xray

def request(config,path,data=None):
    req=urllib.request.Request(config['baseUrl']+'/api/node/'+path,data=json.dumps(data).encode() if data is not None else None,headers={'Authorization':'Bearer '+config['nodeToken'],'Content-Type':'application/json','User-Agent':'MadarSales/0.1'})
    with urllib.request.urlopen(req,timeout=10) as response:return json.loads(response.read(1048576))

def watchdog(now=None):
    import subprocess
    now=int(time.time()) if now is None else now
    heartbeat=pathlib.Path('/run/madar-sales-node/quota-heartbeat.json')
    if heartbeat.exists():
        from quota_runtime import meter_authorized
        valid=meter_authorized(heartbeat,now)
        if not valid:subprocess.run(['systemctl','stop','madar-sales-node.service'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=15)
        return valid
    try:
        auth=json.loads(pathlib.Path('/run/madar-sales-node/authorization.json').read_text());valid=auth['expiresAt']>now
    except Exception:valid=False
    if not valid:subprocess.run(['systemctl','stop','madar-sales-xray.service'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=15)
    return valid

def main():
    p=argparse.ArgumentParser();p.add_argument('--config',default='/etc/madar-sales-node/config.json');p.add_argument('--watchdog',action='store_true');args=p.parse_args()
    if args.watchdog:watchdog();return
    config=json.loads(pathlib.Path(args.config).read_text())
    if config.get('protocolVersion')==2:
        import signal
        from quota_runtime import QuotaRuntime
        runtime=QuotaRuntime(config,request,verify_policy)
        signal.signal(signal.SIGTERM,lambda *_:runtime.stopping.set())
        runtime.run();return
    xray=Xray(config);xray.stop();revision=0;deadline=0
    while True:
        now=int(time.time())
        try:
            envelope=request(config,'policy');policy=verify_policy(envelope,config['policyKey'],config['nodeId'],now,revision-1)
            # An identical revision may be re-ACKed but cannot extend its signed TTL.
            healthy=xray.apply(policy,now);revision=policy['revision'];deadline=policy['expiresAt'];request(config,'ack',{'revision':revision,'healthy':healthy})
        except Exception:
            if int(time.time())>=deadline:xray.stop()
        time.sleep(30)
if __name__=='__main__':main()
