import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical, deriveNodeKey, signNodeRequest, authenticatedNode } from '../src/node-control.mjs';

const NOW_MS=1800000000000;
const master=btoa(String.fromCharCode(...new Uint8Array(32).fill(37))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
test('canonical manifest order deterministic and Python-compatible',()=>{
  assert.equal(canonical({z:1,a:[{c:3,b:2}]}),'{"a":[{"b":2,"c":3}],"z":1}');
});
test('per-node keys differ even under the same master key',async()=>{
  const a=await deriveNodeKey(master,'node_01');
  const b=await deriveNodeKey(master,'node_02');
  assert.equal(a.length,32); assert.notDeepEqual(a,b);
  const expected='V_0jBHeY1k48nlTMDSlzNDU_BiVYTZwlA0RWvY6KC7s';
  const value=btoa(String.fromCharCode(...a)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  assert.equal(value,expected);
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

async function signedRequest(path,method,nonce,payload,nowMs=1800000000000) {
  const id='node_01',timestamp=Math.floor(nowMs/1000);
  const body=payload===undefined?'':JSON.stringify(payload);
  const key=await deriveNodeKey(master,id);
  const signature=await signNodeRequest(key,method,path,timestamp,nonce,
    new TextEncoder().encode(body));
  return new Request('https://example.test'+path,{
    method,
    headers:{
      'x-madar-node-id':id,
      'x-madar-node-timestamp':String(timestamp),
      'x-madar-node-nonce':nonce,
      'x-madar-node-signature':signature,
      ...(method==='POST'?{'content-type':'application/json'}:{}),
    },
    ...(method==='POST'?{body}:{})
  });
}

function replayDb() {
  const seen=new Set();
  let nonceWrites=0;
  const DB={
    prepare(sql) {
      return {bind(...args) {
        return {
          async first() {
            assert.match(sql,/FROM nodes/);
            return {id:'node_01',lifecycle:'provisioning',desired_revision:1,
              acked_revision:0,user_limit:20,byte_limit:1000};
          },
          async run() {
            assert.match(sql,/node_nonces/);
            nonceWrites++;
            if(seen.has(args[1]))return {meta:{changes:0}};
            seen.add(args[1]);
            return {meta:{changes:1}};
          },
        };
      }};
    },
  };
  return {DB,get nonceWrites(){return nonceWrites;}};
}

test('read-only and idempotent polling routes do not write replay nonces',async()=>{
  const mock=replayDb(),env={DB:mock.DB,NODE_MASTER_KEY:master};
  assert.equal((await authenticatedNode(
    await signedRequest('/api/node/v1/manifest','GET','a'.repeat(32)),env,NOW_MS)).id,'node_01');
  assert.equal((await authenticatedNode(
    await signedRequest('/api/node/v1/manifest','GET','a'.repeat(32)),env,NOW_MS)).id,'node_01');

  const ackPayload={revision:1,status:'accepted',digest:'a'.repeat(64)};
  assert.equal((await authenticatedNode(
    await signedRequest('/api/node/v1/ack','POST','b'.repeat(32),ackPayload),env,NOW_MS)).id,'node_01');
  assert.equal((await authenticatedNode(
    await signedRequest('/api/node/v1/ack','POST','b'.repeat(32),ackPayload),env,NOW_MS)).id,'node_01');
  assert.equal(mock.nonceWrites,0);
});

test('unknown signed node mutations retain durable one-time replay protection',async()=>{
  const mock=replayDb(),env={DB:mock.DB,NODE_MASTER_KEY:master};
  assert.equal((await authenticatedNode(
    await signedRequest('/api/node/v1/future-mutation','POST','c'.repeat(32),{value:1}),env,NOW_MS)).id,'node_01');
  const replay=await authenticatedNode(
    await signedRequest('/api/node/v1/future-mutation','POST','c'.repeat(32),{value:1}),env,NOW_MS);
  assert.equal(replay.error.status,409);
  assert.equal(mock.nonceWrites,2);
  const wrongPath=await signedRequest('/api/node/v1/manifest','GET','d'.repeat(32));
  const signature=wrongPath.headers.get('x-madar-node-signature');
  const invalid=new Request('https://example.test/api/node/v1/future-mutation',{
    method:'POST',body:'{}',headers:{
      'x-madar-node-id':'node_01',
      'x-madar-node-timestamp':'1800000000',
      'x-madar-node-nonce':'e'.repeat(32),
      'x-madar-node-signature':signature,
      'content-type':'application/json',
    },
  });
  assert.equal((await authenticatedNode(invalid,env,NOW_MS)).error.status,401);
});
