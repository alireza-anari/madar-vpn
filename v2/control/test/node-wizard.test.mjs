import test from 'node:test';
import assert from 'node:assert/strict';
import {newNodePrompt,beginNodeWizard,cancelNodeWizard,consumeNodeWizard} from '../src/node-wizard.mjs';

test('mobile wizard never asks for SSH passwords or private keys',()=>{
  const panel=newNodePrompt();
  assert.match(panel.text,/سقف حجم/);
  assert.doesNotMatch(panel.text,/SSH|password|private key/);
  assert.equal(panel.replyMarkup.inline_keyboard[0][0].callback_data,'v2:admin:node:cancel');
});
test('node wizard expires and never submits stale enrollment',async()=>{
  const sql=[];
  const db={prepare(query){return {bind(...params){
    sql.push({query,params});
    return {run:async()=>({meta:{changes:1}}),first:async()=>({mode:'add',expires_ms:99})};
  }};}};
  const res=await consumeNodeWizard(db,'123','test_node|aws|eu|20|500',100);
  assert.match(res.text,/مهلت/);
  assert.ok(sql.some(x=>x.query.startsWith('DELETE FROM admin_node_sessions')));
  assert.ok(!sql.some(x=>x.query.startsWith('INSERT INTO nodes')));
});
test('invalid input retains session and cannot create a node',async()=>{
  const sql=[];
  const db={prepare(query){return {bind(){
    sql.push(query);
    return {run:async()=>({}),first:async()=>({mode:'add',expires_ms:2000})};
  }};}};
  const res=await consumeNodeWizard(db,'123','not a valid node',100);
  assert.match(res.text,/معتبر نیست/);
  assert.equal(sql.filter(x=>x.startsWith('DELETE FROM admin_node_sessions')).length,0);
});
test('wizard initiates and cancellation only use one owner session row',async()=>{
  const calls=[];
  const db={prepare(q){return {bind(...values){calls.push({q,values});return {run:async()=>({})};}}}};
  await beginNodeWizard(db,'123',1000);
  await cancelNodeWizard(db,'123');
  assert.equal(calls.length,2);
  assert.deepEqual(calls[0].values,['123',601000]);
  assert.deepEqual(calls[1].values,['123']);
});
