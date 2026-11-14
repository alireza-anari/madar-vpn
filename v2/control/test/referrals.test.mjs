import test from 'node:test';
import assert from 'node:assert/strict';
import {hashInvite,grantStaffRole} from '../src/referrals.mjs';
test('invite tokens are hashed, malformed input rejected',async()=>{
  const a=await hashInvite('0123456789abcdef0123456789abcdef');
  const b=await hashInvite('0123456789abcdef0123456789abcdee');
  assert.match(a,/^[a-f0-9]{64}$/);
  assert.notEqual(a,b);
  assert.equal(await hashInvite('invalid'),null);
});
test('no seller/support grant without exact ID and allowed role',async()=>{
  const db={batch(){throw Error('must not write')}};
  assert.equal(await grantStaffRole(db,{actorId:'1'},'admin','55'),false);
  assert.equal(await grantStaffRole(db,{actorId:'1'},'seller','username'),false);
});
