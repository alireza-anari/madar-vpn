import test from 'node:test';
import assert from 'node:assert/strict';
import {parseNodeAdd,parseRouteAdd,enrollNode} from '../src/node-admin.mjs';
test('node enroll input rejects shell, oversized and missing capacities',()=>{
  assert.deepEqual(parseNodeAdd('/node_add eu_01|aws|eu|20|500'),{
    id:'eu_01',provider:'aws',region:'eu',userLimit:20,byteLimit:500*1073741824
  });
  assert.equal(parseNodeAdd('/node_add ../../root|a|b|1|50'),null);
  assert.equal(parseNodeAdd('/node_add node|a|b|0|50'),null);
  assert.equal(parseNodeAdd('/node_add node|a|b|2|0'),null);
  assert.equal(parseNodeAdd('/node_add node|a|b|20|200001'),null);
  assert.equal(parseNodeAdd('/node_add node|a|b|20|1; rm -rf /'),null);
});
test('only explicit Reality or valid TLS/WSS route configurations pass',()=>{
  assert.deepEqual(parseRouteAdd('/node_route eu_01|reality|443'),{
    nodeId:'eu_01',transport:'reality',port:443,
    hostname:null,path:null,id:'eu_01_reality',operatorHint:null
  });
  assert.deepEqual(parseRouteAdd('/node_route eu_01|wss|8443|vpn.example.com|/ws'),{
    nodeId:'eu_01',transport:'wss',port:8443,
    hostname:'vpn.example.com',path:'/ws',id:'eu_01_wss',operatorHint:null
  });
  assert.deepEqual(parseRouteAdd('/node_route eu_01|reality|443|mci'),{
    nodeId:'eu_01',transport:'reality',port:443,
    hostname:null,path:null,id:'eu_01_reality_mci',operatorHint:'mci',
  });
  assert.deepEqual(parseRouteAdd('/node_route eu_01|reality|8443|irancell'),{
    nodeId:'eu_01',transport:'reality',port:8443,
    hostname:null,path:null,id:'eu_01_reality_irancell',operatorHint:'irancell',
  });
  assert.equal(parseRouteAdd('/node_route eu_01|reality|443|unknown'),null);
  assert.equal(parseRouteAdd('/node_route eu_01|wss|443|not valid|/ws'),null);
  assert.equal(parseRouteAdd('/node_route eu_01|wss|443|vpn.example.com|/a?b'),null);
  assert.equal(parseRouteAdd('/node_route eu_01|hysteria2|443'),null);
});
test('node admin input never runs an arbitrary shell process',async()=>{
  const db={batch(stmts) {
    assert.equal(stmts.length,2);
    return Promise.resolve([{meta:{changes:1}},{meta:{changes:1}}]);
  },prepare(sql) {
    assert.match(sql,/^(INSERT INTO nodes|INSERT INTO audit_events)/);
    return {bind(...x){return {sql,params:x};}};
  }};
  const res=await enrollNode(db,'123','/node_add node_01|aws|eu|10|50');
  assert.match(res.text,/NOT ready/);
});
