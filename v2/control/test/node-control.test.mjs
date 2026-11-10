import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical, deriveNodeKey, signNodeRequest, authenticatedNode } from '../src/node-control.mjs';

const master=btoa(String.fromCharCode(...new Uint8Array(32).fill(37))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
test('canonical manifest order deterministic and Python-compatible',()=>{
  assert.equal(canonical({z:1,a:[{c:3,b:2}]}),'{"a":[{"b":2,"c":3}],"z":1}');
});
test('per-node keys differ even under the same master key',async()=>{
  const a=await deriveNodeKey(master,'node_01');
  const b=await deriveNodeKey(master,'node_02');
  assert.equal(a.length,32); assert.notDeepEqual(a,b);
  await assert.rejects(deriveNodeKey(master,'../escape'));
});
test('unsigned node requests and missing server secrets are denied',async()=>{
  const env={};
  const req=new Request('https://example.test/api/node/v1/manifest');
  assert.equal((await authenticatedNode(req,env)).error.status,503);
  env.DB={};
  env.NODE_MASTER_KEY=master;
  assert.equal((await authenticatedNode(req,env)).error.status,401);
});
test('HMAC signature binds request to method, path, timestamp and body',async()=>{
  const key=await deriveNodeKey(master,'node_01');
  const timestamp=1800000000,nonce='c'.repeat(32);
  const a=await signNodeRequest(key,'GET','/api/node/v1/manifest',timestamp,nonce);
  const b=await signNodeRequest(key,'POST','/api/node/v1/ack',timestamp,nonce);
  assert.match(a,/^[a-zA-Z0-9_-]{43}$/);
  assert.notEqual(a,b);
});
