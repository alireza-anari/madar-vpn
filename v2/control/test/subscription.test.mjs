import test from 'node:test';
import assert from 'node:assert/strict';
import {tokenDigest,eligibleEndpoint,getSubscription,unwrapClientUuid} from '../src/subscription.mjs';

const key=btoa(String.fromCharCode(...new Uint8Array(32).fill(7))).replace(/=+$/,'');
test('opaque random tokens are hashed and never accepted in URL query',async()=>{
  assert.equal(await tokenDigest('invalid'),null);
  assert.match(await tokenDigest('A'.repeat(43)),/^[a-f0-9]{64}$/);
});
test('unprovisioned subscription endpoint is fail-closed',async()=>{
  const req=new Request('https://api.madar.test/api/v2/subscription',{
    headers:{authorization:'Bearer '+'A'.repeat(43)},
  });
  assert.equal((await getSubscription(req,{})).status,503);
  assert.equal((await getSubscription(req,{SUBSCRIPTION_API_ENABLED:'true'})).status,503);
  const env={SUBSCRIPTION_API_ENABLED:'true',DB:{prepare() {throw Error('should not query');}},
    SUBSCRIPTION_CREDENTIAL_KEY:key};
  assert.equal((await getSubscription(new Request(req.url),env)).status,401);
});
test('only complete Reality and TLS WebSocket routes are published',()=>{
  const base={host:'vpn.example.com',port:443,server_name:'vpn.example.com'};
  assert.equal(eligibleEndpoint({...base,transport:'reality',
    reality_public_key:'A'.repeat(43),reality_short_id:'abcd'}),true);
  assert.equal(eligibleEndpoint({...base,transport:'reality'}),false);
  assert.equal(eligibleEndpoint({...base,transport:'wss',ws_path:'/ws'}),true);
  assert.equal(eligibleEndpoint({...base,transport:'wss',ws_path:'/ws\r\nInjected: x'}),false);
  assert.equal(eligibleEndpoint({...base,transport:'hysteria2'}),false);
});
test('credential decryption refuses incorrect key size and invalid ciphertext',async()=>{
  await assert.rejects(unwrapClientUuid({nonce_b64:'AAAAAAAAAAAAAAAA',
    ciphertext_b64:'AAAAAAAAAAAAAAAAAAAAAA'},'short'));
});
