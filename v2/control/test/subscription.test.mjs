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
test('an active subscription can issue a sign-in token while route metadata is temporarily unavailable',async()=>{
  const {issueActiveToken}=await import('../src/subscription.mjs');
  const inserted=[];
  const env={
    SUBSCRIPTION_API_ENABLED:'true',
    SUBSCRIPTION_CREDENTIAL_KEY:key,
    DB:{prepare(sql){return {bind(...args){
      return {
        first:async()=>sql.includes('SELECT s.id,s.expires_at')
          ?{id:'sub-1',expires_at:1_900_003_600_000}:null,
        run:async()=>{if(sql.includes('INSERT INTO subscription_tokens'))inserted.push(args);return {meta:{changes:1};}},
      };
    }};}},
  };
  const issued=await issueActiveToken(env,'sub-1',1_900_000_000_000);
  assert.ok(issued);
  assert.match(issued.token,/^[A-Za-z0-9_-]{43}$/);
  assert.equal(inserted.length,1);
});

test('subscription API still refuses to publish a route-less subscription token',async()=>{
  const token='A'.repeat(43);
  const env={
    SUBSCRIPTION_API_ENABLED:'true',
    SUBSCRIPTION_CREDENTIAL_KEY:key,
    DB:{prepare(sql){return {bind(){
      return {
        first:async()=>sql.includes('FROM subscription_tokens t JOIN subscriptions s')
          ?{id:'sub-1',state:'active',expires_at:1_900_003_600_000,max_bytes:1000,used_bytes:0}:null,
        all:async()=>({results:[]}),
      };
    }};}},
  };
  const response=await getSubscription(new Request('https://api.madar.test/api/v2/subscription',{
    headers:{authorization:'Bearer '+token},
  }),env,1_900_000_000_000);
  assert.equal(response.status,503);
  assert.equal((await response.json()).error,'no_verified_routes');
});

test('credential decryption refuses incorrect key size and invalid ciphertext',async()=>{
  await assert.rejects(unwrapClientUuid({nonce_b64:'AAAAAAAAAAAAAAAA',
    ciphertext_b64:'AAAAAAAAAAAAAAAAAAAAAA'},'short'));
});

test('AES-GCM credentials encrypt/decrypt without exposing plaintext at rest',async()=>{
  const {wrapClientUuid}=await import('../src/subscription.mjs');
  const id='123e4567-e89b-42d3-a456-426614174000';
  const encrypted=await wrapClientUuid(id,key);
  assert.notEqual(encrypted.ciphertext_b64,id);
  assert.equal(await unwrapClientUuid(encrypted,key),id);
});
test('no token may be issued for pending or unverified subscriptions',async()=>{
  const {issueActiveToken}=await import('../src/subscription.mjs');
  assert.equal(await issueActiveToken({DB:{}},'sub-1'),null);
  const env={DB:{prepare(){return {bind(){return {first:async()=>null};}}}},
    SUBSCRIPTION_API_ENABLED:'true',SUBSCRIPTION_CREDENTIAL_KEY:key};
  assert.equal(await issueActiveToken(env,'sub-1'),null);
});
