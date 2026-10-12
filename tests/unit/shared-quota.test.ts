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

// 6. Official aggregate containing settled proxy tokens is not double-counted.
test('settled proxy tokens reflected officially count once', () => {
  const l = verifiedLedger(), c = cfg();
  admit(l, 'job', 50000);
  l.prepareDispatch(c, 'job', 40000, 1000);
  l.complete('job', 41000);
  // Official aggregate now includes the 41000 settled tokens.
  l.publishSharedUsage(day, { premium: 41000, economy: 0 }, { premium: 0, economy: 0 });
  const snap = l.snapshot(c, day, P);
  // max(41000, 0 + 41000) = 41000 counted once, + 10000 reserve
  assert.equal(snap.effective_used, 51000);
  assert.equal(snap.estimated_remaining, 850000 - 51000);
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

// 8. Delayed official catch-up never underestimates.
test('delayed official catch-up only raises the effective figure', () => {
  const l = verifiedLedger(), c = cfg();
  admit(l, 'a', 50000);
  l.complete('a', 40000);
  const before = l.snapshot(c, day, P).effective_used;
  // Late-arriving official batch covers the settled tokens.
  l.publishSharedUsage(day, { premium: 40000, economy: 0 }, { premium: 0, economy: 0 });
  const after = l.snapshot(c, day, P).effective_used;
  assert.ok(after! <= before! || after === before);
  assert.equal(after, 40000 + 10000);
  // And a LATER higher official (delayed external batch) raises it.
  l.publishSharedUsage(day, { premium: 40000, economy: 0 }, { premium: 50000, economy: 0 });
  assert.equal(l.snapshot(c, day, P).effective_used, 50000 + 40000 + 10000);
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

// 14. Same-project foreign usage is NOT deduped away: it trips the
// dedication tripwire instead of silently undercounting. Underestimate
// counterexample: 20 local vs 100000 official in the routing project can
// only be foreign traffic (dedicated project), so max() must not launder it.
test('foreign usage inside the proxy project trips instead of undercounting', () => {
  const l = verifiedLedger(), c = cfg();
  admit(l, 'mine', 20000);
  assert.throws(() => l.publishSharedUsage(day, { premium: 100000, economy: 0 }, { premium: 0, economy: 0 }),
    (e: any) => e.code === 'PROXY_PROJECT_SHARED');
  assert.equal(l.pauseReason(), 'PROXY_PROJECT_SHARED');
  assert.equal(l.observation(day, 'premium')?.official_high_watermark, 0);
  assert.throws(() => admit(l, 'after', 10), (e: any) => e.code === 'FREE_QUOTA_UNVERIFIED');
  l.close();
});

// 15. UTC midnight starts an independent day; Taipei 08:00 is the same instant.
test('new UTC day starts independent observations', () => {
  const l = verifiedLedger(), c = cfg();
  l.admit(c, { key: 'd1', hash: 'd1', requestId: 'd1', model: c.quotas.premium.models[0], group: P, day, reserve: 9000 });
  l.complete('d1', 9000);
  l.publishSharedUsage(day, { premium: 9000, economy: 0 }, { premium: 1000, economy: 0 });
  assert.equal(l.snapshot(c, day, P).effective_used, 1000 + 9000 + 10000);
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

// 16. Prior-day UNKNOWN still blocks the new day after reset.
test('prior-day UNKNOWN survives UTC reset without release', () => {
  const l = verifiedLedger(), c = cfg(), oldDay = '2026-01-01';
  l.publishSharedUsage(oldDay, { premium: 0, economy: 0 }, { premium: 0, economy: 0 }, new Date('2026-01-01T10:00:00Z'));
  l.admit(c, { key: 'stuck', hash: 'x', requestId: 'x', model: c.quotas.premium.models[0], group: P, day: oldDay, reserve: 100, now: new Date('2026-01-01T10:00:30Z') });
  l.unknown('stuck');
  // A fresh new-day shared baseline does NOT release the old UNKNOWN.
  l.publishSharedUsage(day, { premium: 0, economy: 0 }, { premium: 0, economy: 0 });
  assert.throws(() => admit(l, 'newday', 10), (e: any) => e.code === 'FREE_QUOTA_UNVERIFIED');
  assert.equal(l.find('stuck')?.state, 'UNKNOWN');
  l.close();
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
