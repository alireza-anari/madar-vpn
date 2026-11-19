import test from 'node:test';
import assert from 'node:assert/strict';
import {enabled} from '../src/feature-flags.mjs';

test('plain-text flag remains supported when no secret override exists',()=>{
  assert.equal(enabled({SHOP_ENABLED:'true'},'SHOP_ENABLED'),true);
  assert.equal(enabled({SHOP_ENABLED:'false'},'SHOP_ENABLED'),false);
  assert.equal(enabled({},'SHOP_ENABLED'),false);
});

test('secret flag is authoritative over the plain-text fallback',()=>{
  assert.equal(enabled({SHOP_ENABLED:'false',SHOP_ENABLED_SECRET:'true'},'SHOP_ENABLED'),true);
  assert.equal(enabled({SHOP_ENABLED:'true',SHOP_ENABLED_SECRET:'false'},'SHOP_ENABLED'),false);
  assert.equal(enabled({SHOP_ENABLED_SECRET:'TRUE'},'SHOP_ENABLED'),false);
});

test('invalid names and absent environments fail closed',()=>{
  assert.equal(enabled(null,'SHOP_ENABLED'),false);
  assert.equal(enabled({},'bad-name'),false);
  assert.equal(enabled({},''),false);
});
