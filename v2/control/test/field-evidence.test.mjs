import test from 'node:test';
import assert from 'node:assert/strict';
import {validateFieldSample,completePair,fieldProbeRoute} from '../src/field-evidence.mjs';

const now=1800000000000;
const uuid=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const sample=(operator,probe=1)=>({
  nodeId:'test_node01',probeId:uuid(probe),operator,port:operator==='mci'?443:8443,
  revision:1,observedMs:now-1000,authenticated:true,uploadBytes:1024,downloadBytes:2048
});
const secret='unshared-test-external-field-harness-secret-key-42';
const signed=async(body,nonce='a'.repeat(32))=>{
  const raw=JSON.stringify(body),timestamp=String(now);
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),
    {name:'HMAC',hash:'SHA-256'},false,['sign']);
  const bytes=new Uint8Array(await crypto.subtle.sign('HMAC',key,
    new TextEncoder().encode(timestamp+'\n'+nonce+'\n'+raw)));
  const signature=Array.from(bytes,x=>x.toString(16).padStart(2,'0')).join('');
  return new Request('https://example.test/api/v2/field/accept',{method:'POST',
    headers:{'content-type':'application/json','x-madar-field-timestamp':timestamp,
      'x-madar-field-nonce':nonce,'x-madar-field-signature':signature},body:raw});
};
test('carrier evidence requires distinct, authenticated tunnel traffic',()=>{
  assert.ok(validateFieldSample(sample('mci'),now));
  assert.ok(validateFieldSample(sample('irancell'),now));
  assert.equal(validateFieldSample({...sample('mci'),port:8443},now),null);
  assert.equal(validateFieldSample({...sample('mci'),authenticated:false},now),null);
  assert.equal(validateFieldSample({...sample('mci'),downloadBytes:0},now),null);
  assert.equal(validateFieldSample({...sample('mci'),observedMs:now-120001},now),null);
  assert.equal(validateFieldSample({...sample('mci'),unknown:true},now),null);
});
test('only two fresh independent operator observations satisfy readiness',()=>{
  const first={operator:'mci',port:443,revision:1,observed_ms:now};
  const second={operator:'irancell',port:8443,revision:1,observed_ms:now-20};
  assert.equal(completePair([first],1,now),null);
  assert.equal(completePair([first,{...first}],1,now),null);
  assert.equal(completePair([first,{...second,revision:2}],1,now),null);
  assert.equal(completePair([first,{...second,observed_ms:now-600001}],1,now),null);
  assert.ok(completePair([first,second],1,now));
});
test('field route denies missing config and invalid HMAC before touching D1',async()=>{
  const req=await signed(sample('mci'));
  assert.equal((await fieldProbeRoute(req,{},now)).status,503);
  const bad=new Request('https://example.test/api/v2/field/accept',{
    method:'POST',headers:{'content-type':'application/json',
      'x-madar-field-timestamp':String(now),'x-madar-field-nonce':'b'.repeat(32),
      'x-madar-field-signature':'0'.repeat(64)},body:JSON.stringify(sample('mci'))});
  const result=await fieldProbeRoute(bad,{FIELD_PROBE_ENABLED:'true',FIELD_PROBE_SECRET:secret,DB:{}},now);
  assert.equal(result.status,401);
});
test('field route requires installed server and accepted node manifest',async()=>{
  const db={prepare(sql){
    return {bind(){return {first:async()=>null}}};
  }};
  const result=await fieldProbeRoute(await signed(sample('mci')),
    {FIELD_PROBE_ENABLED:'true',FIELD_PROBE_SECRET:secret,DB:db},now);
  assert.equal(result.status,409);
  assert.deepEqual(await result.json(),{error:'not_commissioned'});
});
test('two signed field samples promote the pair exactly once; replay rejected',async()=>{
  const probes=[],statements=[],db={
    prepare(sql){return {bind(...args){return {
      async first(){return {id:'test_node01'};},
      async run(){
        if(!sql.includes('INSERT OR IGNORE INTO field_probes'))throw Error(sql);
        if(probes.some(p=>p.id===args[0]))return {meta:{changes:0}};
        probes.push({id:args[0],operator:args[2],port:args[3],revision:args[4],observed_ms:args[5]});
        return {meta:{changes:1}};
      },
      async all(){return {results:probes.map(({id,...p})=>p)};},
    }};}},
    async batch(rows){statements.push(...rows);return rows.map(()=>({meta:{changes:1}}));}
  };
  const env={DB:db,FIELD_PROBE_ENABLED:'true',FIELD_PROBE_SECRET:secret};
  const a=await fieldProbeRoute(await signed(sample('mci',1)),env,now);
  assert.equal(a.status,202);
  assert.equal((await a.json()).ready,false);
  const b=await fieldProbeRoute(await signed(sample('irancell',2),'b'.repeat(32)),env,now);
  assert.equal(b.status,200);
  assert.equal((await b.json()).ready,true);
  assert.equal(statements.length,4);
  const replay=await fieldProbeRoute(await signed(sample('irancell',2),'c'.repeat(32)),env,now);
  assert.equal(replay.status,409);
});
