import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnose, compareEdgeVsDirect } from '../src/diagnostics.mjs';
test('classifies only an observed failure', () => {
  assert.deepEqual(diagnose({ transport:'wss', dns:{ok:true}, tcp:{ok:false} }),
    { code:'IP_OR_TCP_UNREACHABLE', failedAt:'tcp' });
  assert.equal(diagnose({ transport:'wss', dns:{ok:true}, tcp:{ok:true} }).code,
    'NOT_ENOUGH_EVIDENCE');
  assert.equal(diagnose({ transport:'reality', dns:{ok:true}, tcp:{ok:true},
    tls:{ok:true}, proxy:{ok:true}, traffic:{ok:true} }).code,'CONNECTED_VERIFIED');
});
test('CDN is suspected only in paired comparisons', () => {
  assert.equal(compareEdgeVsDirect({edge:{ok:false},direct:{ok:true}}), 'EDGE_PATH_SUSPECTED');
  assert.equal(compareEdgeVsDirect({edge:{ok:false}}),'UNDETERMINED');
});
