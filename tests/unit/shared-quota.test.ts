import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../../src/ledger.ts';
import { utcDay, nextReset, validateConfig } from '../../src/config.ts';
import { cfg, verifiedLedger } from '../helpers.ts';

const day = utcDay();
const P = 'premium' as const, E = 'economy' as const;
function admit(l: Ledger, key: string, amount: number, group: 'premium' | 'economy' = 'premium') {
  const c = cfg();
  return l.admit(c, { key, hash: key, requestId: key, model: c.quotas[group].models[0], group, day, reserve: amount });
}

// 2. Only external usage, zero proxy: remaining reflects shared pool.
test('external-only usage reduces remaining without any proxy traffic', () => {
  const l = verifiedLedger(), c = cfg();
  l.publishSharedUsage(day, { premium: 0, economy: 0 }, { premium: 300000, economy: 100000 });
  const p = l.snapshot(c, day, P);
  assert.equal(p.official_proxy_usage, 0);
  assert.equal(p.official_external_usage, 300000);
  assert.equal(p.official_org_usage, 300000);
  assert.equal(p.proxy_local_committed, 0);
  // effective = 300000 + max(0, 0+0) + 10000 = 310000
  assert.equal(p.effective_used, 310000);
  assert.equal(p.estimated_remaining, 850000 - 310000);
  const e = l.snapshot(c, day, E);
  assert.equal(e.effective_used, 100000 + 0 + 100000);
  l.close();
});

// 3. Rising external usage tightens later admission.
test('rising external usage lowers subsequent admission budget', () => {
  const l = verifiedLedger(), c = cfg();
  l.publishSharedUsage(day, { premium: 0, economy: 0 }, { premium: 100000, economy: 0 });
  const before = l.snapshot(c, day, P).estimated_remaining;
  l.publishSharedUsage(day, { premium: 0, economy: 0 }, { premium: 200000, economy: 0 });
  const after = l.snapshot(c, day, P).estimated_remaining;
  assert.equal(before - after, 100000);
  l.close();
});

// 4+19. External saturation denies new proxy requests (no zero-fee claim).
test('external saturation exhausts safety cap and denies admission', () => {
  const l = verifiedLedger(), c = cfg();
  l.publishSharedUsage(day, { premium: 0, economy: 0 }, { premium: 840000, economy: 0 });
  const snap = l.snapshot(c, day, P);
  assert.equal(snap.state, 'EXHAUSTED');
  assert.equal(snap.estimated_remaining, 0);
  assert.throws(() => admit(l, 'late', 1), (e: any) => e.code === 'FREE_QUOTA_EXHAUSTED');
  l.close();
});

// 5. Premium / Economy accounted independently.
test('premium saturation does not block economy', () => {
  const l = verifiedLedger(), c = cfg();
  l.publishSharedUsage(day, { premium: 0, economy: 0 }, { premium: 840000, economy: 0 });
  assert.equal(l.snapshot(c, day, P).state, 'EXHAUSTED');
  assert.equal(l.snapshot(c, day, E).state, 'READY');
  admit(l, 'eco-1', 100, E);
  l.close();
});

// 6. Official aggregate containing settled proxy tokens is added
// conservatively (double-counted): under mixed-project traffic the same
// official tokens could be foreign, so netting would undercount.
test('settled proxy tokens reflected officially are added conservatively (double-count)', () => {
  const l = verifiedLedger(), c = cfg();
  admit(l, 'job', 50000);
  l.prepareDispatch(c, 'job', 40000, 1000);
  l.complete('job', 41000);
  // Official aggregate now includes the 41000 settled tokens.
  l.publishSharedUsage(day, { premium: 41000, economy: 0 }, { premium: 0, economy: 0 });
  const snap = l.snapshot(c, day, P);
  // 41000 official + 41000 settled + 10000 reserve.
  assert.equal(snap.effective_used, 41000 + 41000 + 10000);
  assert.equal(snap.estimated_remaining, 850000 - 92000);
  l.close();
});

// 7. Unreflected proxy usage keeps its full reservation.
test('locally committed but officially invisible usage keeps full reserve', () => {
  const l = verifiedLedger(), c = cfg();
  admit(l, 'inflight', 60000);
  const snap = l.snapshot(c, day, P);
  // max(0 official, 0 baseline + 60000 committed) = 60000
  assert.equal(snap.proxy_local_committed, 60000);
  assert.equal(snap.effective_used, 60000 + 10000);
  l.close();
});

// 8. Delayed official catch-up is added on top (conservative double-count).
test('delayed official catch-up only raises the effective figure', () => {
  const l = verifiedLedger(), c = cfg();
  admit(l, 'a', 50000);
  l.complete('a', 40000);
  const before = l.snapshot(c, day, P).effective_used;
  assert.equal(before, 40000 + 10000);
  // Late-arriving official batch covers the settled tokens: added in full.
  l.publishSharedUsage(day, { premium: 40000, economy: 0 }, { premium: 0, economy: 0 });
  const after = l.snapshot(c, day, P).effective_used;
  assert.ok(after! >= before!);
  assert.equal(after, 40000 + 40000 + 10000);
  // And a LATER higher official (delayed external batch) raises it.
  l.publishSharedUsage(day, { premium: 40000, economy: 0 }, { premium: 50000, economy: 0 });
  assert.equal(l.snapshot(c, day, P).effective_used, 40000 + 50000 + 40000 + 10000);
  l.close();
});

// 9. Concurrent admissions share one atomic budget under external load.
test('concurrent admissions cannot oversubscribe under external load', async () => {
  const l = verifiedLedger(), c = cfg();
  l.publishSharedUsage(day, { premium: 0, economy: 0 }, { premium: 700000, economy: 0 });
  // remaining = 850000 - 710000 = 140000; three 50000-way racers admit at most two.
  const ids = ['r1', 'r2', 'r3'];
  const results = await Promise.allSettled(ids.map(k =>
    Promise.resolve().then(() => l.admit(c, { key: k, hash: k, requestId: k, model: c.quotas.premium.models[0], group: P, day, reserve: 50000 }))));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 2);
  l.close();
});

// 13. Reserve config is validated and fingerprinted.
test('reserve config bounds are enforced and fingerprinted', () => {
  const c = cfg();
  assert.equal(c.policy.externalSafetyReserve.premium, 10000);
  const negative = structuredClone(c) as any;
  negative.policy.externalSafetyReserve.premium = -1;
  assert.throws(() => validateConfig(negative), /externalSafetyReserve/);
  const oversized = structuredClone(c) as any;
  oversized.policy.externalSafetyReserve.premium = c.quotas.premium.dailyTokens + 1;
  assert.throws(() => validateConfig(oversized), /externalSafetyReserve/);
  const l = new Ledger(':memory:');
  try {
    l.assertPolicy(c);
    const relaxed = structuredClone(c);
    relaxed.policy.externalSafetyReserve = { premium: 0, economy: 0 };
    assert.throws(() => l.verifyPolicy(relaxed), (e: any) => e.code === 'POLICY_CHANGED');
  } finally { l.close(); }
});

// 14. Same-project foreign usage is absorbed conservatively, never locks.
// effective = official (100000, foreign included) + unreflected local on top.
test('foreign usage inside the proxy project is absorbed, never locks', () => {
  const l = verifiedLedger(), c = cfg();
  admit(l, 'mine', 20000);
  l.publishSharedUsage(day, { premium: 100000, economy: 0 }, { premium: 0, economy: 0 });
  assert.equal(l.isPaused(), false);
  const snap = l.snapshot(c, day, P);
  // The unsettled 20000 rides on top of the official reading (conservative).
  assert.equal(snap.effective_used, 100000 + 20000 + 10000);
  admit(l, 'after', 10);
  l.close();
});

// 15. UTC midnight starts an independent day; Taipei 08:00 is the same instant.
test('new UTC day starts independent observations', () => {
  const l = verifiedLedger(), c = cfg();
  l.admit(c, { key: 'd1', hash: 'd1', requestId: 'd1', model: c.quotas.premium.models[0], group: P, day, reserve: 9000 });
  l.complete('d1', 9000);
  l.publishSharedUsage(day, { premium: 9000, economy: 0 }, { premium: 1000, economy: 0 });
  // effective = 9000 official + 1000 external + 9000 settled + 10000 reserve.
  assert.equal(l.snapshot(c, day, P).effective_used, 9000 + 1000 + 9000 + 10000);
  const tomorrow = '2999-01-02';
  assert.equal(nextReset('2999-01-01'), '2999-01-02T00:00:00.000Z');
  // Yesterday 16:00 UTC == Taipei midnight; UTC 00:00 == Taipei 08:00.
  assert.equal(new Date('2999-01-01T00:00:00Z').getTime(),
    new Date('2999-01-01T08:00:00+08:00').getTime());
  const snap = l.snapshot(c, tomorrow, P);
  assert.equal(snap.official_proxy_usage, null);
  assert.equal(snap.official_external_usage, null);
  assert.equal(snap.effective_used, null);
  assert.equal(snap.state, 'DATA_UNVERIFIED');
  assert.equal(snap.confidence, 'UNVERIFIED');
  l.close();
});

// 16. Prior-day DISPATCHED UNKNOWN inside the execution window is carried;
// older rows stop deducting automatically. History/idempotency retained.
test('prior-day UNKNOWN carries its reserve without blocking the new day', () => {
  const l = verifiedLedger(), c = cfg();
  const todayStart = Date.parse(day + 'T00:00:00Z');
  const prevDay = new Date(todayStart - 86400000).toISOString().slice(0, 10);
  // Window row: admitted 60s before midnight, dispatched, then UNKNOWN.
  // (Baseline published 90s before midnight so the window admission is fresh.)
  l.publishSharedUsage(prevDay, { premium: 0, economy: 0 }, { premium: 0, economy: 0 }, new Date(todayStart - 90000));
  l.admit(c, { key: 'stuck', hash: 'x', requestId: 'x', model: c.quotas.premium.models[0], group: P, day: prevDay, reserve: 100, now: new Date(todayStart - 60000) });
  l.prepareDispatch(c, 'stuck', 80, 4, new Date(todayStart - 30000));
  l.unknown('stuck');
  // A fresh new-day shared baseline restores admission with the carried
  // upper bound — no review, no waiting period.
  l.publishSharedUsage(day, { premium: 0, economy: 0 }, { premium: 0, economy: 0 });
  const carried = l.snapshot(c, day, P).cross_day_carry;
  assert.ok(carried > 0);
  admit(l, 'newday', 10);
  assert.equal(l.find('stuck')?.state, 'UNKNOWN');
  // Expired row: admitted long before the window stops deducting.
  const l2 = verifiedLedger(), c2 = cfg();
  l2.publishSharedUsage(prevDay, { premium: 0, economy: 0 }, { premium: 0, economy: 0 }, new Date(prevDay + 'T10:00:00Z'));
  l2.admit(c2, { key: 'old', hash: 'x', requestId: 'x', model: c2.quotas.premium.models[0], group: P, day: prevDay, reserve: 100, now: new Date(prevDay + 'T10:00:30Z') });
  l2.prepareDispatch(c2, 'old', 80, 4, new Date(prevDay + 'T10:01:00Z'));
  l2.unknown('old');
  l2.publishSharedUsage(day, { premium: 0, economy: 0 }, { premium: 0, economy: 0 });
  assert.equal(l2.snapshot(c2, day, P).cross_day_carry, 0);
  assert.doesNotThrow(() => l2.admit(c2, { key: 'newday2', hash: 'n', requestId: 'n', model: c2.quotas.premium.models[0], group: P, day, reserve: 10 }));
  l.close(); l2.close();
});

// 17. Restart, migration and legacy compatibility.
test('restart converts PENDING to UNKNOWN; legacy rows stay fail-closed until shared baseline', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qf-shared-'));
  const path = join(dir, 'guard.sqlite');
  try {
    const c = cfg();
    const l = new Ledger(path);
    l.assertPolicy(c);
    l.publishSharedUsage(day, { premium: 0, economy: 0 }, { premium: 0, economy: 0 });
    l.admit(c, { key: 'flight', hash: 'h', requestId: 'r', model: c.quotas.premium.models[0], group: P, day, reserve: 50 });
    l.close();
    const reopened = new Ledger(path);
    try {
      assert.equal(reopened.find('flight')?.state, 'UNKNOWN');
      // Simulate a pre-005 database: external scope wiped -> fail closed.
      reopened.db.prepare('UPDATE observations SET official_external=NULL WHERE utc_day=?').run(day);
      assert.equal(reopened.snapshot(c, day, P).state, 'DATA_UNVERIFIED');
      assert.equal(reopened.snapshot(c, day, P).effective_used, null);
      assert.throws(() => reopened.admit(c, { key: 'n', hash: 'n', requestId: 'n', model: c.quotas.premium.models[0], group: P, day, reserve: 1 }), (e: any) => e.code === 'FREE_QUOTA_UNVERIFIED');
    } finally { reopened.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// 18. Untrusted figures surface as null, never zero.
test('snapshot without trustworthy data reports nulls, not zero usage', () => {
  const l = new Ledger(':memory:'), c = cfg();
  try {
    const snap = l.snapshot(c, day, P);
    assert.equal(snap.official_org_usage, null);
    assert.equal(snap.official_external_usage, null);
    assert.equal(snap.official_proxy_usage, null);
    assert.equal(snap.effective_used, null);
    assert.equal(snap.last_successful_poll, null);
    assert.equal(snap.state, 'DATA_UNVERIFIED');
  } finally { l.close(); }
});

// Unknown external tokens count in BOTH groups; confirmed models never double-count.
test('unknown external tokens bound both groups without double-counting known models', () => {
  const l = verifiedLedger(), c = cfg();
  try {
    l.publishSharedUsage(day, { premium: 0, economy: 0 }, { premium: 50, economy: 500 },
      new Date(), { 'future-model-2099': { group: 'premium', tokens: 10 } });
    const p = l.snapshot(c, day, P);
    assert.equal(p.official_external_usage, 50);
    assert.equal(p.external_unknown_tokens, 10);
    assert.equal(p.official_org_usage, 60);
    // premium: 50 known + 10 unknown + max(0,0) + 10000
    assert.equal(p.effective_used, 60 + 10000);
    const e = l.snapshot(c, day, E);
    assert.equal(e.official_external_usage, 500);
    // economy: 500 known + 10 unknown + max(0,0) + 100000
    assert.equal(e.effective_used, 510 + 100000);
    assert.deepEqual(e.external_unknown_models, [{ model: 'future-model-2099', group: 'premium', tokens: 10 }]);
  } finally { l.close(); }
});

// Overflow and negativity can never sneak into admission math.
test('absurd usage figures fail closed instead of wrapping or going negative', () => {
  const c = cfg();
  const huge = Number.MAX_SAFE_INTEGER;
  const l = new Ledger(':memory:');
  try {
    // Fresh baseline at huge scale (no tripwire on first observation)...
    l.publishSharedUsage(day, { premium: huge, economy: 0 }, { premium: 0, economy: 0 });
    // ...but every downstream sum overflows safely instead of wrapping.
    assert.throws(() => l.snapshot(c, day, P), (e: any) => e.code === 'INVALID_USAGE');
    const l2 = new Ledger(':memory:');
    try {
      l2.publishSharedUsage(day, { premium: 0, economy: 0 }, { premium: 0, economy: 0 },
        new Date(), { 'future-model-2099': { group: 'premium', tokens: huge } });
      assert.throws(() => l2.snapshot(c, day, E), (e: any) => e.code === 'INVALID_USAGE');
    } finally { l2.close(); }
  } finally { l.close(); }
});
