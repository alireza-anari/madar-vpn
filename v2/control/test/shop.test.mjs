import test from 'node:test';
import assert from 'node:assert/strict';
import { adminAllowed, salesConfigured, availableForSale, validAdminIds } from '../src/shop.mjs';

test('admin role fail closed for absent or malformed identifiers',()=>{
  assert.equal(adminAllowed(undefined,'123'),false);
  assert.equal(adminAllowed('','123'),false);
  assert.equal(adminAllowed('12,123,456','123'),true);
  assert.equal(adminAllowed('123','12'),false);
  assert.equal(adminAllowed('123','abc'),false);
});
test('sales require explicit opt-in and valid payment instructions',()=>{
  assert.equal(salesConfigured({}),false);
  assert.equal(salesConfigured({SHOP_ENABLED:'true'}),false);
  assert.equal(salesConfigured({SHOP_ENABLED:'true',PAYMENT_INSTRUCTIONS:'short'}),false);
  assert.equal(salesConfigured({
    SHOP_ENABLED:'true',PROVISIONING_ENABLED:'true',PAYMENT_INSTRUCTIONS:'Confirmed official payment instructions',
  }),true);
});
test('route availability never guesses capacity from missing evidence', async()=>{
  const db={prepare(sql) {
    assert.match(sql,/verified_ms BETWEEN/);
    return {bind(...args) {
      assert.equal(args.length,3);
      return {first:async()=>null};
    }};
  }};
  assert.equal(await availableForSale(db,{quota_bytes:1234},Date.now()),false);
  assert.equal(await availableForSale(db,null,Date.now()),false);
});

test('nonprovisioning checkout never opens even if a bank destination exists',()=>{
  assert.equal(salesConfigured({
    SHOP_ENABLED:'true',PAYMENT_INSTRUCTIONS:'Confirmed official payment instructions'
  }),false);
});

test('receipt alerts go only to explicitly configured distinct admin IDs',()=>{
  assert.deepEqual(validAdminIds(' 200,200,garbage,300,400 ', '300'),['200','400']);
  assert.deepEqual(validAdminIds(undefined),[]);
});
