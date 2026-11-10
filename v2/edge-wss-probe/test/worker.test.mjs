import test from 'node:test';
import assert from 'node:assert/strict';
import {makeHandler,WORKER_HOST,ORIGIN} from '../src/index.mjs';
const base = 'https://'+WORKER_HOST;

test('probe provides bounded non-proxy health check',async()=>{
  const result=await makeHandler(()=>{throw Error('should not fetch');})(new Request(base+'/healthz'));
  assert.equal(result.status,200);
  assert.match(await result.text(),/staging only/);
});

test('reject other hosts, paths, query and ordinary HTTP',async()=>{
  let count=0;
  const handle=makeHandler(async()=>{count++;return {status:101,webSocket:{}};});
  const req=(url,upgrade)=>new Request(url,upgrade?{headers:{Upgrade:'websocket'}}:{});
  for (const url of ['https://arbitrary.workers.dev/madar-ws',base+'/bad',
       base+'/madar-ws?destination=example.com']) {
    assert.equal((await handle(req(url,true))).status,404);
  }
  assert.equal((await handle(req(base+'/madar-ws',false))).status,426);
  assert.equal(count,0);
});

test('WebSocket upgrades only reach fixed origin; credentials never forwarded',async()=>{
  let upstream;
  const result=await makeHandler(async request=>{
    upstream=request;
    return {status:101,webSocket:{readyState:0}};
  })(new Request(base+'/madar-ws',{
      headers:{Upgrade:'websocket',Authorization:'Bearer test-should-not-leak'}
  }));
  assert.equal(result.status,101);
  assert.equal(upstream.url,ORIGIN);
  assert.equal(upstream.headers.get('upgrade'),'websocket');
  assert.equal(upstream.headers.get('authorization'),null);
});

test('no origin WebSocket and upstream exceptions fail closed',async()=>{
  const req=new Request(base+'/madar-ws',{headers:{upgrade:'websocket'}});
  assert.equal((await makeHandler(async()=>({status:200}))(req)).status,502);
  assert.equal((await makeHandler(async()=>{throw Error('origin unreachable')})(req)).status,502);
});
