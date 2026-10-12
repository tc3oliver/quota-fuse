import test from 'node:test';
import assert from 'node:assert/strict';
import { collectOnce } from '../../src/collector.ts';
import { Ledger, LedgerError } from '../../src/ledger.ts';
import { cfg, verifiedLedger } from '../helpers.ts';

const day = new Date().toISOString().slice(0, 10);
const utcStart = Math.floor(Date.parse(day + 'T00:00:00Z') / 1000);
const end = utcStart + 3600;
const premiumModel = (c: ReturnType<typeof cfg>) => c.quotas.premium.models[0];

function bucket(results: unknown[]) {
  return { object: 'page', data: [{ object: 'bucket', start_time: utcStart, end_time: end, results }], has_more: false, next_page: null };
}
function proxyRow(c: ReturnType<typeof cfg>, tokens: number) {
  return { model: premiumModel(c), project_id: 'proj_test', input_tokens: tokens, output_tokens: 0 };
}
function fetchOf(page: unknown, counter?: { calls: number }) {
  return (async (u: unknown) => {
    if (counter) counter.calls++;
    return new Response(JSON.stringify(page), { status: 200 });
  }) as typeof fetch;
}

// a. Normal: exact proxy accounting never trips the dedicated-project tripwire.
test('a. exact proxy publish matches local settlement without tripping', () => {
  const c = cfg(), l = verifiedLedger();
  try {
    const model = premiumModel(c);
    l.admit(c, { key: 'a1', hash: 'a1', requestId: 'a1', model, group: 'premium', day, reserve: 1000 });
    l.prepareDispatch(c, 'a1', 400, 100);
    l.complete('a1', 500);
    l.publishSharedUsage(day, { premium: 500, economy: 0 }, { premium: 0, economy: 0 });
    assert.equal(l.isPaused(), false);
    assert.equal(l.observation(day, 'premium')?.official_high_watermark, 500);
    const snap = l.snapshot(c, day, 'premium');
    // proxyEffective = max(500, 0+500) = 500; effective = 0 + 500 + 10000 reserve.
    assert.equal(snap.proxy_local_committed, 500);
    assert.equal(snap.official_proxy_usage, 500);
    assert.equal(snap.effective_used, 500 + 10000);
    assert.equal(snap.state, 'READY');
  } finally { l.close(); }
});

// b. Small over-counts are absorbed conservatively — never a lock.
// (No dedication premise: official tokens are always counted, unreflected
// local reservations are added on top.)
test('b. proxy 501 over settled 500 is absorbed without locking', async () => {
  const c = cfg(), l = verifiedLedger();
  try {
    const model = premiumModel(c);
    l.admit(c, { key: 'b1', hash: 'b1', requestId: 'b1', model, group: 'premium', day, reserve: 1000 });
    l.prepareDispatch(c, 'b1', 400, 100);
    l.complete('b1', 500);
    l.publishSharedUsage(day, { premium: 500, economy: 0 }, { premium: 0, economy: 0 });
    // One extra token (e.g. counted preflight or foreign use) only tightens.
    l.publishSharedUsage(day, { premium: 501, economy: 0 }, { premium: 0, economy: 0 });
    assert.equal(l.isPaused(), false);
    assert.equal(l.observation(day, 'premium')?.official_high_watermark, 501);
    const snap = l.snapshot(c, day, 'premium');
    assert.equal(snap.effective_used, 501 + 10000);
    // The collector keeps publishing normally afterwards.
    const counter = { calls: 0 };
    const r = await collectOnce(c, l, { fetchImpl: fetchOf(bucket([proxyRow(c, 501)]), counter), adminKey: 'fake' });
    assert.ok(counter.calls >= 1);
    assert.equal(r.proxy.premium, 501);
    assert.equal(l.isPaused(), false);
  } finally { l.close(); }
});

// c. Delayed official aggregation: outstanding reservation covers proxy 0.
test('c. unsettled outstanding keeps full reservation with proxy 0', () => {
  const c = cfg(), l = verifiedLedger();
  try {
    const model = premiumModel(c);
    l.admit(c, { key: 'c1', hash: 'c1', requestId: 'c1', model, group: 'premium', day, reserve: 1000 });
    l.publishSharedUsage(day, { premium: 0, economy: 0 }, { premium: 0, economy: 0 });
    assert.equal(l.isPaused(), false);
    const snap = l.snapshot(c, day, 'premium');
    assert.equal(snap.proxy_local_committed, 1000);
    assert.equal(snap.effective_used, 1000 + 10000);
  } finally { l.close(); }
});

// d. Partial official visibility: max() dedup keeps the local upper bound.
test('d. partial proxy 300 under settled 800 does not trip', () => {
  const c = cfg(), l = verifiedLedger();
  try {
    const model = premiumModel(c);
    l.admit(c, { key: 'd1', hash: 'd1', requestId: 'd1', model, group: 'premium', day, reserve: 1000 });
    l.complete('d1', 800);
    l.publishSharedUsage(day, { premium: 300, economy: 0 }, { premium: 0, economy: 0 });
    assert.equal(l.isPaused(), false);
    const snap = l.snapshot(c, day, 'premium');
    assert.equal(snap.official_proxy_usage, 300);
    assert.equal(snap.effective_used, 800 + 10000);
  } finally { l.close(); }
});

// e. Genuine sharing: proxy far above local books is absorbed, never locks.
// Admission only tightens; it can never be loosened by foreign traffic.
test('e. proxy 5000 over settled 20 is absorbed and only tightens admission', () => {
  const c = cfg(), l = verifiedLedger();
  try {
    const model = premiumModel(c);
    l.admit(c, { key: 'e1', hash: 'e1', requestId: 'e1', model, group: 'premium', day, reserve: 100 });
    l.complete('e1', 20);
    l.publishSharedUsage(day, { premium: 5000, economy: 0 }, { premium: 0, economy: 0 });
    assert.equal(l.isPaused(), false);
    assert.equal(l.observation(day, 'premium')?.official_high_watermark, 5000);
    assert.equal(l.snapshot(c, day, 'premium').effective_used, 5000 + 10000);
    // Small admissions still flow; only truly exhausted ones refuse.
    l.admit(c, { key: 'e2', hash: 'e2', requestId: 'e2', model, group: 'premium', day, reserve: 10 });
    assert.throws(
      () => l.admit(c, { key: 'e3', hash: 'e3', requestId: 'e3', model, group: 'premium', day, reserve: 850000 }),
      (e: unknown) => e instanceof LedgerError && e.code === 'FREE_QUOTA_EXHAUSTED',
    );
  } finally { l.close(); }
});

// f. Small in-flight reservations ride on top of the official reading.
test('f. proxy 11 with outstanding 5000 keeps full reservation on top', () => {
  const c = cfg(), l = verifiedLedger();
  try {
    const model = premiumModel(c);
    l.admit(c, { key: 'f1', hash: 'f1', requestId: 'f1', model, group: 'premium', day, reserve: 5000 });
    l.publishSharedUsage(day, { premium: 11, economy: 0 }, { premium: 0, economy: 0 });
    assert.equal(l.isPaused(), false);
    assert.equal(l.observation(day, 'premium')?.official_high_watermark, 11);
    const snap = l.snapshot(c, day, 'premium');
    assert.equal(snap.effective_used, 11 + 5000 + 10000);
  } finally { l.close(); }
});
