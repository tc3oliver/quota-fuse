import test from 'node:test';
import assert from 'node:assert/strict';
import {chooseAfterQuotaGuard} from '../../examples/omp-fallback.ts';
test('independent provider only for known quota code and safe boundary',()=>{
  assert.equal(chooseAfterQuotaGuard(429,'FREE_QUOTA_EXHAUSTED',{id:'x',publicOnly:true,hasSideEffects:false}),'codex-plus');
  assert.equal(chooseAfterQuotaGuard(503,'FREE_QUOTA_UNVERIFIED',{id:'x',publicOnly:true,hasSideEffects:true}),'STOP');
  assert.equal(chooseAfterQuotaGuard(500,'FREE_QUOTA_UNVERIFIED',{id:'x',publicOnly:true,hasSideEffects:false}),'STOP');
});
