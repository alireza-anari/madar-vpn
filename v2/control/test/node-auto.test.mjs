import test from 'node:test';
import assert from 'node:assert/strict';
import {parseAutoNode,publicV4,tryDispatch,reportInstall,getTrialFeed} from '../src/node-auto.mjs';

const GOOD='test-aria01|arianet|eu|20|500|86.54.42.66';
test('public IPv4 and node enrollment is tightly validated',()=>{
  assert.equal(parseAutoNode(GOOD).mode,'aria-cutover');
  assert.equal(parseAutoNode('test-xx01|vendor|eu|20|500|8.8.8.8').mode,'fresh');
  assert.equal(parseAutoNode('test-another|vendor|eu|20|500|86.54.42.66'),null);
  for(const ip of ['127.0.0.1','10.0.0.1','172.16.0.1','192.168.1.1',
                   '169.254.1.1','100.64.10.1','203.0.113.5','8.8.8.08'])
    assert.equal(publicV4(ip),false,ip);
  assert.equal(parseAutoNode(GOOD+'|root-password'),null);
});
test('no root shell / provisioning when secrets absent',async()=>{
  assert.equal(await tryDispatch({NODE_AUTO_ENABLED:'false'},{
    id:'x',node_id:'test-aria01',ip:'86.54.42.66',mode:'aria-cutover'}),false);
});
test('only exact authenticated callback can register test route metadata',async()=>{
  const env={NODE_AUTO_ENABLED:'true',NODE_PROVISION_CALLBACK_SECRET:'Z'.repeat(48),SUBSCRIPTION_CREDENTIAL_KEY:'K'.repeat(43),DB:{}};
  const req=new Request('https://api.madar.test/api/v2/node-bootstrap/report',{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({status:'installed',node_id:'test-aria01',
      job_id:'a'.repeat(36),ip:'86.54.42.66'})});
  assert.equal((await reportInstall(req,env)).status,401);
  assert.equal((await reportInstall(new Request(req.url,{method:'GET'}),env)).status,404);
});
test('trial cannot disclose non-existent or expired token',async()=>{
  const env={DB:{prepare:()=>({bind:()=>({first:async()=>null})})},
    SUBSCRIPTION_CREDENTIAL_KEY:'Z'.repeat(43)};
  assert.equal((await getTrialFeed(new Request('https://a.test/t/short'),env)).status,404);
  assert.equal((await getTrialFeed(new Request('https://a.test/t/'+'A'.repeat(43)),env)).status,403);
});
