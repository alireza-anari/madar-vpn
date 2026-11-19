import test from 'node:test';
import assert from 'node:assert/strict';
import {reserveApprovedOrder,reconcileApprovedOrders} from '../src/provisioning.mjs';

const credentialKey=btoa(String.fromCharCode(...new Uint8Array(32).fill(11)))
  .replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
const fakeDB=(withNode=true)=>{
  const seen=[];
  const db={
    prepare(sql){
      return {bind(...args){return {
        async first(){
          if(sql.includes('FROM orders o JOIN plans'))
            return {id:'order-one',customer_telegram_id:'1000',
              quota_bytes:1073741824,duration_days:30};
          if(sql.includes('SELECT n.id FROM nodes n'))
            return withNode?{id:'test_node01'}:null;
          throw Error('unexpected SQL: '+sql);
        },
        async all(){
          if(sql.includes("SELECT id FROM orders WHERE state='approved'"))
            return {results:[{id:'order-one'}]};
          throw Error('unexpected SQL: '+sql);
        },
      };}};
    },
    async batch(rows){seen.push(...rows);return rows.map(()=>({meta:{changes:1}}));},
  };
  return {db,seen};
};
test('approved orders wait for a field-ready two-carrier capacity slot',async()=>{
  const {db,seen}=fakeDB(false);
  const status=await reserveApprovedOrder({DB:db,SUBSCRIPTION_CREDENTIAL_KEY:credentialKey},
    'order-one',1800000000000);
  assert.equal(status.status,'no_verified_capacity');
  assert.equal(seen.length,0);
});
test('reserve atomically creates pending subscription, sealed UUID and allocation',async()=>{
  const {db,seen}=fakeDB(true);
  const result=await reserveApprovedOrder({DB:db,SUBSCRIPTION_CREDENTIAL_KEY:credentialKey},
    'order-one',1800000000000);
  assert.equal(result.status,'reserved');
  assert.match(result.subscriptionId,/^[0-9a-f-]{36}$/);
  assert.equal(result.nodeId,'test_node01');
  assert.equal(seen.length,4);
});
test('the cron enroller is disabled by default, even with approved orders',async()=>{
  const {db,seen}=fakeDB(true);
  assert.deepEqual(await reconcileApprovedOrders({DB:db,
    SUBSCRIPTION_CREDENTIAL_KEY:credentialKey}),[]);
  assert.equal(seen.length,0);
});

test('secret opt-in enables the cron enroller without exposing public sale',async()=>{
  const {db,seen}=fakeDB(true);
  const rows=await reconcileApprovedOrders({DB:db,
    SHOP_ENABLED:'false',
    PROVISIONING_ENABLED:'false',PROVISIONING_ENABLED_SECRET:'true',
    SUBSCRIPTION_CREDENTIAL_KEY:credentialKey},1800000000000);
  assert.equal(rows.length,1);
  assert.equal(rows[0].status,'reserved');
  assert.equal(seen.length,4);
});

test('a secret off overrides an accidentally enabled provisioning variable',async()=>{
  const {db,seen}=fakeDB(true);
  assert.deepEqual(await reconcileApprovedOrders({DB:db,
    PROVISIONING_ENABLED:'true',PROVISIONING_ENABLED_SECRET:'false',
    SUBSCRIPTION_CREDENTIAL_KEY:credentialKey},1800000000000),[]);
  assert.equal(seen.length,0);
});
