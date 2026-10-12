import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../../src/ledger.ts';
import { utcDay } from '../../src/config.ts';
import { cfg } from '../helpers.ts';

// Unattended lifecycle acceptance: no operator review anywhere in this file.
const day = utcDay();
const dayStart = Date.parse(day + 'T00:00:00Z');
const prevDay = new Date(dayStart - 86400000).toISOString().slice(0, 10);
const zeros = (): { premium: number; economy: number } => ({ premium: 0, economy: 0 });

// (a) PREFLIGHT-phase UNKNOWN is never carried, even from yesterday.
test('preflight-phase UNKNOWN never carries into today', () => {
  const c = cfg(), l = new Ledger(':memory:');
  try {
    // Baseline 90s before midnight so the window admission below is fresh.
    l.publishSharedUsage(prevDay, zeros(), zeros(), new Date(dayStart - 90000));
    // Admitted 60s before midnight but NEVER dispatched: phase stays PREFLIGHT.
    l.admit(c, { key: 'preflight-stuck', hash: 'h', requestId: 'r', model: c.quotas.premium.models[0], group: 'premium', day: prevDay, reserve: 100, now: new Date(dayStart - 60000) });
    assert.equal(l.find('preflight-stuck')?.phase, 'PREFLIGHT');
    l.unknown('preflight-stuck');
    assert.equal(l.find('preflight-stuck')?.phase, 'PREFLIGHT');
    l.publishSharedUsage(day, zeros(), zeros());
    assert.equal(l.snapshot(c, day, 'premium').cross_day_carry, 0);
    assert.equal(l.snapshot(c, day, 'premium').effective_used, 10000);
    assert.doesNotThrow(() => l.admit(c, { key: 'ok', hash: 'h2', requestId: 'r2', model: c.quotas.premium.models[0], group: 'premium', day, reserve: 10 }));
  } finally { l.close(); }
});

// (b) Bulk historical UNKNOWN rows stop deducting; admission stays normal.
test('bulk historical UNKNOWN rows carry zero and admission stays normal', () => {
  const c = cfg(), l = new Ledger(':memory:');
  try {
    const oldDay = '2026-01-01';
    l.publishSharedUsage(oldDay, zeros(), zeros(), new Date('2026-01-01T10:00:00Z'));
    for (let i = 0; i < 20; i++) {
      const k = 'hist-' + i;
      l.admit(c, { key: k, hash: k, requestId: k, model: c.quotas.premium.models[0], group: 'premium', day: oldDay, reserve: 100, now: new Date('2026-01-01T10:00:30Z') });
      l.prepareDispatch(c, k, 80, 4, new Date('2026-01-01T10:01:00Z'));
      l.unknown(k);
    }
    l.publishSharedUsage(day, zeros(), zeros());
    assert.equal(l.snapshot(c, day, 'premium').cross_day_carry, 0);
    assert.equal(l.snapshot(c, day, 'premium').effective_used, 10000);
    assert.doesNotThrow(() => l.admit(c, { key: 'fresh', hash: 'f', requestId: 'f', model: c.quotas.premium.models[0], group: 'premium', day, reserve: 100 }));
    // History and idempotency retained.
    assert.equal(l.find('hist-0')?.state, 'UNKNOWN');
    assert.throws(() => l.admit(c, { key: 'hist-0', hash: 'hist-0', requestId: 'r2', model: c.quotas.premium.models[0], group: 'premium', day, reserve: 10 }), (e: any) => e.code === 'DUPLICATE_REQUEST');
  } finally { l.close(); }
});

// (c) Mixed-traffic counterexample: settled tokens are never netted away.
test('mixed traffic never underestimates: settled plus official plus reserve', () => {
  const c = cfg(), l = new Ledger(':memory:');
  try {
    l.publishSharedUsage(day, zeros(), zeros());
    l.admit(c, { key: 'mine', hash: 'h', requestId: 'r', model: c.quotas.premium.models[0], group: 'premium', day, reserve: 1000 });
    l.complete('mine', 100);
    // Official 100 could be foreign traffic in the same project (or counted
    // preflight): it proves nothing about the settled 100, so both count.
    l.publishSharedUsage(day, { premium: 100, economy: 0 }, zeros());
    assert.equal(l.snapshot(c, day, 'premium').effective_used, 100 + 100 + 10000);
  } finally { l.close(); }
});

// (d) Concurrent admissions never exceed remaining quota.
test('concurrent admits never oversubscribe remaining quota', async () => {
  const c = cfg(), l = new Ledger(':memory:');
  try {
    l.publishSharedUsage(day, zeros(), zeros());
    l.publishSharedUsage(day, zeros(), { premium: 700000, economy: 0 });
    const remaining = (l.snapshot(c, day, 'premium') as any).estimated_remaining as number;
    assert.equal(remaining, 850000 - 700000 - 10000);
    const ids = ['cc1', 'cc2', 'cc3', 'cc4'];
    const results = await Promise.allSettled(ids.map((k) =>
      Promise.resolve().then(() => l.admit(c, { key: k, hash: k, requestId: k, model: c.quotas.premium.models[0], group: 'premium', day, reserve: 50000 }))));
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    assert.ok(ok * 50000 <= remaining);
  } finally { l.close(); }
});

// (e) Three-day simulation: baselines plus admit/complete/unknown mix,
// zero manual steps; the oldest carry expires by day three.
test('three-day unattended simulation with carry expiry', () => {
  const c = cfg(), l = new Ledger(':memory:');
  try {
    const d1 = new Date(dayStart - 2 * 86400000).toISOString().slice(0, 10);
    const d2 = new Date(dayStart - 86400000).toISOString().slice(0, 10);
    const d3 = day;
    const d1Start = Date.parse(d1 + 'T00:00:00Z');
    const d2Start = Date.parse(d2 + 'T00:00:00Z');
    const d3Start = Date.parse(d3 + 'T00:00:00Z');
    // Day 1: baseline, one settled 50, one window UNKNOWN 100 (dispatched).
    l.publishSharedUsage(d1, zeros(), zeros(), new Date(d1 + 'T12:00:00Z'));
    l.admit(c, { key: 'd1-done', hash: 'a', requestId: 'a', model: c.quotas.premium.models[0], group: 'premium', day: d1, reserve: 100, now: new Date(d1 + 'T12:00:30Z') });
    l.complete('d1-done', 50);
    // Refresh the day-1 baseline so the window admission is fresh.
    l.publishSharedUsage(d1, zeros(), zeros(), new Date(d2Start - 90000));
    l.admit(c, { key: 'd1-stuck', hash: 'b', requestId: 'b', model: c.quotas.premium.models[0], group: 'premium', day: d1, reserve: 100, now: new Date(d2Start - 60000) });
    l.prepareDispatch(c, 'd1-stuck', 80, 4, new Date(d2Start - 30000));
    l.unknown('d1-stuck');
    // Day 2: fresh baseline carries the window UNKNOWN; settle 30 more plus
    // a new window UNKNOWN 70.
    l.publishSharedUsage(d2, zeros(), zeros(), new Date(d2 + 'T00:01:00Z'));
    const s2 = l.snapshot(c, d2, 'premium') as any;
    assert.ok(s2.cross_day_carry > 0);
    l.admit(c, { key: 'd2-done', hash: 'e', requestId: 'e', model: c.quotas.premium.models[0], group: 'premium', day: d2, reserve: 100, now: new Date(d2 + 'T00:01:30Z') });
    l.complete('d2-done', 30);
    l.admit(c, { key: 'd2-live', hash: 'g', requestId: 'g', model: c.quotas.premium.models[0], group: 'premium', day: d2, reserve: 10, now: new Date(d2 + 'T00:02:00Z') });
    // Refresh the day-2 baseline so the next window admission is fresh.
    l.publishSharedUsage(d2, zeros(), zeros(), new Date(d3Start - 90000));
    l.admit(c, { key: 'd2-stuck', hash: 'f', requestId: 'f', model: c.quotas.premium.models[0], group: 'premium', day: d2, reserve: 70, now: new Date(d3Start - 60000) });
    l.prepareDispatch(c, 'd2-stuck', 50, 4, new Date(d3Start - 30000));
    l.unknown('d2-stuck');
    // Day 3: day-1 carry has expired (window long past); only day-2 window
    // rows ride along. No review, no waiting, no manual step at any point.
    void d1Start;
    l.publishSharedUsage(d3, zeros(), zeros());
    const s3 = l.snapshot(c, d3, 'premium') as any;
    assert.ok(s3.cross_day_carry >= 0);
    // Day-1 100-token row can no longer overlap day 3: at most the day-2
    // 70-token row is carried.
    assert.ok(s3.cross_day_carry <= 70);
    assert.equal(s3.effective_used, s3.cross_day_carry + 10000);
    assert.doesNotThrow(() => l.admit(c, { key: 'd3-live', hash: 'h', requestId: 'h', model: c.quotas.premium.models[0], group: 'premium', day: d3, reserve: 10 }));
    assert.equal(l.find('d1-stuck')?.state, 'UNKNOWN');
    assert.equal(l.find('d2-stuck')?.state, 'UNKNOWN');
  } finally { l.close(); }
});
