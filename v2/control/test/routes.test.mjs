import test from 'node:test';
import assert from 'node:assert/strict';
import { eligibleRoutes, rankRoutes } from '../src/routes.mjs';
const nowMs=1_000_000;
const base={ status:'ready', verifiedAtMs:nowMs-1000, freeSlots:10,
  freeBytes:1000, transport:'reality', latencyMs:100 };
test('blocks stale, unproven and exhausted routes', () => {
  const cases=[{...base,id:'ok'}, {...base,id:'stale',verifiedAtMs:1},
    {...base,id:'none',freeBytes:0}, {...base,id:'broken',status:'quarantined'},
    {...base,id:'no-wss',transport:'wss'}];
  assert.deepEqual(eligibleRoutes(cases,{nowMs}).map(r=>r.id), ['ok']);
});
test('operator evidence influences route selection', () => {
  const a={...base,id:'a',byOperator:{irancell:{successRate:.15}}};
  const b={...base,id:'b',byOperator:{irancell:{successRate:.92}}};
  assert.deepEqual(rankRoutes([a,b],{nowMs,operator:'irancell'}).map(r=>r.id),['b','a']);
});
test('avoids UDP when network or app forbids it', () => {
  assert.equal(eligibleRoutes([{...base,id:'u',transport:'hysteria2'}],{nowMs,allowUdp:false}).length,0);
});
