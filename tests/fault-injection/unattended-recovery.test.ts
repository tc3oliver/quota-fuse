import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { utcDay } from '../../src/config.ts';
import { Ledger } from '../../src/ledger.ts';
import { gate } from '../../src/policy.ts';
import { cfg } from '../helpers.ts';

// New snapshot semantics (per spec): effective_used = official_proxy
// + official_external_known + unknown_external + outstanding
// + max(0, anchor + settled - official_proxy) + cross_day_carry + reserve.
// Mocks only: zero real API calls in this file.
const day = utcDay();
const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
const yesterdayNoon = new Date(yesterday + 'T12:00:00Z');
const ZERO = { premium: 0, economy: 0 } as const;
const zeros = (): { premium: number; economy: number } => ({ premium: 0, economy: 0 });

// 1. Yesterday UNKNOWN 280 (premium, DISPATCHED): today's fresh baseline
// unblocks admission with no review; carry is counted conservatively.
test('yesterday dispatched UNKNOWN carries into today without blocking admission', () => {
  const c = cfg(), l = new Ledger(':memory:');
  const oldToken = process.env.QG_PROXY_TOKEN, oldKey = process.env.OPENAI_API_KEY;
  process.env.QG_PROXY_TOKEN = 'unattended-recovery-token-1234567890';
  process.env.OPENAI_API_KEY = 'sk-test-only';
  try {
    l.publishSharedUsage(yesterday, zeros(), zeros(), yesterdayNoon);
    l.admit(c, { key: 'y-unknown', hash: 'h', requestId: 'r', model: c.quotas.premium.models[0], group: 'premium', day: yesterday, reserve: 280, now: yesterdayNoon });
    // 200 + 64 + 16 (accountMargin) = 280 -> DISPATCHED with reserved 280.
    l.prepareDispatch(c, 'y-unknown', 200, 64, yesterdayNoon);
    assert.equal(l.find('y-unknown')?.phase, 'DISPATCHED');
    l.unknown('y-unknown');
    assert.equal(l.find('y-unknown')?.state, 'UNKNOWN');
    // New-day baseline, no reviewDispatchedDay call anywhere.
    l.publishSharedUsage(day, zeros(), zeros());
    const snap: any = l.snapshot(c, day, 'premium');
    assert.equal(snap.cross_day_carry, 280);
    // 0 proxy + 0 external + 0 unknown + 0 outstanding + max(0,0+0-0) + 280 + 10000.
    assert.equal(snap.effective_used, 280 + 10000);
    assert.doesNotThrow(() => l.admit(c, { key: 'today-ok', hash: 'h2', requestId: 'r2', model: c.quotas.premium.models[0], group: 'premium', day, reserve: 100 }));
    assert.doesNotThrow(() => gate(c, l));
  } finally {
    l.close();
    if (oldToken === undefined) delete process.env.QG_PROXY_TOKEN; else process.env.QG_PROXY_TOKEN = oldToken;
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey;
  }
});

// 2. Yesterday admitted PENDING (reserve 500, unsettled) is not underestimated today.
test('cross-day pending reservation stays counted in today effective usage', () => {
  const c = cfg(), l = new Ledger(':memory:');
  try {
    l.publishSharedUsage(yesterday, zeros(), zeros(), yesterdayNoon);
    l.admit(c, { key: 'y-pending', hash: 'h', requestId: 'r', model: c.quotas.premium.models[0], group: 'premium', day: yesterday, reserve: 500, now: yesterdayNoon });
    l.publishSharedUsage(day, zeros(), zeros());
    const snap: any = l.snapshot(c, day, 'premium');
    assert.equal(snap.cross_day_carry, 500);
    assert.equal(snap.effective_used, 500 + 10000);
    assert.ok((snap.effective_used as number) >= 500);
  } finally { l.close(); }
});

// 3. Heavy external consumption crushes remaining quota (no tripwire, fail-safe math).
test('external 900k usage exhausts premium remaining quota', () => {
  const c = cfg(), l = new Ledger(':memory:');
  try {
    l.publishSharedUsage(day, zeros(), zeros());
    const before: any = l.snapshot(c, day, 'premium');
    assert.ok((before.estimated_remaining as number) > 800000);
    // Direct publish: no tripwire exists anymore.
    l.publishSharedUsage(day, zeros(), { premium: 900000, economy: 0 });
    const snap: any = l.snapshot(c, day, 'premium');
    // 0 + 900000 + 0 + 0 + 0 + 0 + 10000 = 910000 >= safetyCap 850000.
    assert.equal(snap.effective_used, 900000 + 10000);
    assert.equal(snap.state, 'EXHAUSTED');
    assert.equal(snap.estimated_remaining, 0);
    assert.throws(() => l.admit(c, { key: 'too-big', hash: 'x', requestId: 'x', model: c.quotas.premium.models[0], group: 'premium', day, reserve: 100000 }),
      (e: any) => e.code === 'FREE_QUOTA_EXHAUSTED');
  } finally { l.close(); }
});

// 4. Filling the safety cap rejects further admission with EXHAUSTED state.
test('filled safety cap rejects admission as exhausted', () => {
  const c = cfg(), l = new Ledger(':memory:');
  try {
    l.publishSharedUsage(day, zeros(), zeros());
    l.admit(c, { key: 'fill', hash: 'h', requestId: 'r', model: c.quotas.premium.models[0], group: 'premium', day, reserve: 840000 });
    const snap: any = l.snapshot(c, day, 'premium');
    assert.equal(snap.state, 'EXHAUSTED');
    assert.throws(() => l.admit(c, { key: 'over', hash: 'x', requestId: 'x', model: c.quotas.premium.models[0], group: 'premium', day, reserve: 1 }),
      (e: any) => e.code === 'FREE_QUOTA_EXHAUSTED');
    assert.equal((l.snapshot(c, day, 'premium') as any).state, 'EXHAUSTED');
  } finally { l.close(); }
});

// 5. Next-day fresh baselines auto-recover from exhaustion without operator help.
test('next-day reset recovers from exhaustion automatically', () => {
  const c = cfg(), l = new Ledger(':memory:');
  try {
    l.publishSharedUsage(day, zeros(), zeros());
    // Exhaust via day-scoped external usage (no local reservations to carry).
    l.publishSharedUsage(day, zeros(), { premium: 840000, economy: 0 });
    assert.equal((l.snapshot(c, day, 'premium') as any).state, 'EXHAUSTED');
    l.publishSharedUsage(tomorrow, zeros(), zeros());
    const snap: any = l.snapshot(c, tomorrow, 'premium');
    assert.equal(snap.cross_day_carry, 0);
    assert.equal(snap.state, 'READY');
    assert.doesNotThrow(() => l.admit(c, { key: 'next-day', hash: 'h', requestId: 'r', model: c.quotas.premium.models[0], group: 'premium', day: tomorrow, reserve: 100 }));
  } finally { l.close(); }
});

// 6. Collector outage recovers on the next successful publish.
test('collector failure pause clears on next successful publish', () => {
  const c = cfg(), l = new Ledger(':memory:');
  try {
    l.publishSharedUsage(day, zeros(), zeros());
    // Cover the checkpoint with local settlement so the publish below is
    // about transport recovery, not the (separately tested) sharing tripwire.
    l.admit(c, { key: 'cover', hash: 'cover', requestId: 'cover', model: c.quotas.premium.models[0], group: 'premium', day, reserve: 123 });
    l.complete('cover', 123);
    l.pauseCollectorFailure('COLLECTOR_DOWN');
    assert.equal(l.isPaused(), true);
    l.publishSharedUsage(day, { premium: 123, economy: 0 }, zeros());
    assert.equal(l.isPaused(), false);
    assert.equal(l.observation(day, 'premium')?.official_high_watermark, 123);
  } finally { l.close(); }
});

// 7. Proxy official far above local ledger is counted conservatively, never an error.
test('proxy official above local ledger is counted without pause', () => {
  const c = cfg(), l = new Ledger(':memory:');
  try {
    l.publishSharedUsage(day, zeros(), zeros());
    l.admit(c, { key: 'local', hash: 'h', requestId: 'r', model: c.quotas.premium.models[0], group: 'premium', day, reserve: 100 });
    l.complete('local', 20);
    assert.doesNotThrow(() => l.publishSharedUsage(day, { premium: 5000, economy: 0 }, zeros()));
    assert.equal(l.isPaused(), false);
    const snap: any = l.snapshot(c, day, 'premium');
    assert.equal(snap.official_proxy_usage, 5000);
    // 5000 + 0 + 0 + 0 + max(0, 0+20-5000)=0 + 0 + 10000.
    assert.equal(snap.effective_used, 5000 + 10000);
    assert.ok((snap.effective_used as number) >= 5000);
  } finally { l.close(); }
});

// 8. Official regression is fail-closed and sticky, but polling stays available.
test('official regression sticks while collector keeps polling', () => {
  const c = cfg();
  void c;
  const l = new Ledger(':memory:');
  try {
    l.publishSharedUsage(day, { premium: 1000, economy: 0 }, zeros());
    assert.throws(() => l.publishSharedUsage(day, { premium: 999, economy: 0 }, zeros()),
      (e: any) => e.code === 'OFFICIAL_WATERMARK_REGRESSION');
    assert.equal(l.pauseReason(), 'OFFICIAL_WATERMARK_REGRESSION');
    assert.equal(l.observation(day, 'premium')?.official_high_watermark, 1000);
    // Sticky: even a good publish requires manual review.
    assert.throws(() => l.publishSharedUsage(day, { premium: 1001, economy: 0 }, zeros()),
      (e: any) => e.code === 'MANUAL_REVIEW_REQUIRED');
    // Collector read path still works under the hold.
    assert.doesNotThrow(() => l.recordPollAttempt(day, 'premium', new Date(), null));
    assert.equal(l.collectorMayPoll(), true);
  } finally { l.close(); }
});

// 9. Restart preserves UNKNOWN history and idempotency (real file DB).
test('restart retains unknown history and duplicate protection', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qf-unattended-restart-'));
  const path = join(dir, 'guard.sqlite');
  try {
    const c = cfg();
    const setup = new Ledger(path);
    try {
      setup.publishSharedUsage(day, zeros(), zeros());
      setup.admit(c, { key: 'restart-key', hash: 'h', requestId: 'r', model: c.quotas.premium.models[0], group: 'premium', day, reserve: 100 });
      setup.unknown('restart-key');
    } finally { setup.close(); }
    const l = new Ledger(path, { recoverPending: false });
    try {
      assert.equal(l.find('restart-key')?.state, 'UNKNOWN');
      assert.throws(() => l.admit(c, { key: 'restart-key', hash: 'h', requestId: 'r2', model: c.quotas.premium.models[0], group: 'premium', day, reserve: 10 }),
        (e: any) => e.code === 'DUPLICATE_REQUEST');
    } finally { l.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// 10. Legacy fingerprint + legacy pause auto-upgrade on verify + publish (real file DB).
test('legacy policy fingerprint auto-upgrades and legacy pause self-clears', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qf-unattended-legacy-'));
  const path = join(dir, 'guard.sqlite');
  try {
    const c = cfg();
    const setup = new Ledger(path);
    try {
      setup.assertPolicy(c);
      setup.db.prepare('UPDATE policy_fingerprint SET sha256=? WHERE id=1').run(setup.legacyPolicyHash(c));
      setup.db.prepare('UPDATE guard_control SET paused_reason=? WHERE id=1').run('UNACCOUNTED_OFFICIAL_USAGE');
    } finally { setup.close(); }
    const l = new Ledger(path, { recoverPending: false });
    try {
      // Auto-migration: no POLICY_CHANGED.
      assert.doesNotThrow(() => l.verifyPolicy(c));
      assert.doesNotThrow(() => l.publishSharedUsage(day, zeros(), zeros()));
      assert.equal(l.isPaused(), false);
      const audit = l.db.prepare(
        "SELECT operator FROM accounting_migration_audit WHERE operator='auto-upgrade' LIMIT 1").get() as any;
      assert.ok(audit && audit.operator === 'auto-upgrade');
    } finally { l.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
