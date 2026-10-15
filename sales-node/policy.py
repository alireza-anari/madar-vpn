import hashlib,hmac,json,re

def verify_policy(envelope,key,node_id,now,last_revision):
    payload=envelope['payload'];expected=hmac.new(key.encode(),payload.encode(),hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected,envelope.get('signature','')):raise ValueError('INVALID_SIGNATURE')
    policy=json.loads(payload)
    if policy.get('nodeId')!=node_id or not isinstance(policy.get('revision'),int) or policy['revision']<=last_revision:raise ValueError('STALE_POLICY')
    if not isinstance(policy.get('expiresAt'),int) or policy['expiresAt']<=now or policy['expiresAt']>now+330:raise ValueError('POLICY_EXPIRED')
    if not isinstance(policy.get('clients'),list) or len(policy['clients'])>5000:raise ValueError('INVALID_CLIENTS')
    for client in policy['clients']:
        if not re.fullmatch(r'[a-f0-9-]{36}',client.get('uuid','')) or not isinstance(client.get('validUntil'),int):raise ValueError('INVALID_CLIENT')
    if policy.get('version')==2:
        ids=set();ports=set()
        for client in policy['clients']:
            ident=client.get('accountId');port=client.get('listenPort')
            if not isinstance(ident,str) or not re.fullmatch(r'[a-f0-9-]{36}',ident) or ident in ids:raise ValueError('INVALID_ACCOUNT')
            ids.add(ident)
            for field in ('quotaEpoch','usedBytes','validUntil'):
                value=client.get(field)
                if type(value) is not int or not 0<=value<=9007199254740991:raise ValueError('INVALID_QUOTA')
            cap=client.get('quotaBytes')
            if cap is not None and (type(cap) is not int or not 1<=cap<=1000000000000):raise ValueError('INVALID_QUOTA')
            if type(port) is not int or not 20000<=port<=20999 or port in ports or client.get('generation')!=ident+':'+str(client['quotaEpoch']):raise ValueError('INVALID_QUOTA')
            ports.add(port)
    elif 'version' in policy:raise ValueError('UNSUPPORTED_POLICY')
    return policy
