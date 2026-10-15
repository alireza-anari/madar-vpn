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
    return policy
