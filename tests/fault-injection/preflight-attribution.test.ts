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
function rejectsWithCode(p: Promise<unknown>, code: string) {
  return assert.rejects(p, (e: unknown) => e instanceof LedgerError && e.code === code);
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

// b. Preflight over-count by 1 token trips PROXY_PROJECT_SHARED and stays sticky.
test('b. proxy 501 over settled 500 trips PROXY_PROJECT_SHARED and stays sticky', async () => {
  const c = cfg(), l = verifiedLedger();
  try {
    const model = premiumModel(c);
    l.admit(c, { key: 'b1', hash: 'b1', requestId: 'b1', model, group: 'premium', day, reserve: 1000 });
    l.prepareDispatch(c, 'b1', 400, 100);
    l.complete('b1', 500);
    l.publishSharedUsage(day, { premium: 500, economy: 0 }, { premium: 0, economy: 0 });
    let trip: unknown = null;
    try {
      l.publishSharedUsage(day, { premium: 501, economy: 0 }, { premium: 0, economy: 0 });
    } catch (e) { trip = e; }
    assert.ok(trip instanceof LedgerError);
    assert.equal(trip.code, 'PROXY_PROJECT_SHARED');
    assert.match(trip.message, /dedicated|preflight/i);
    assert.equal(l.pauseReason(), 'PROXY_PROJECT_SHARED');
    // Watermark keeps the old value.
    assert.equal(l.observation(day, 'premium')?.official_high_watermark, 500);
    // Sticky: a second direct publish is refused as an operator hold.
    await rejectsWithCode(
      (async () => l.publishSharedUsage(day, { premium: 500, economy: 0 }, { premium: 0, economy: 0 }))(),
      'MANUAL_REVIEW_REQUIRED',
    );
    assert.equal(l.pauseReason(), 'PROXY_PROJECT_SHARED');
    // Collector still performs its read-only fetch, then refuses to overwrite.
    const counter = { calls: 0 };
    await rejectsWithCode(
      collectOnce(c, l, { fetchImpl: fetchOf(bucket([proxyRow(c, 501)]), counter), adminKey: 'fake' }),
      'MANUAL_REVIEW_REQUIRED',
    );
    assert.ok(counter.calls >= 1);
    assert.equal(l.pauseReason(), 'PROXY_PROJECT_SHARED');
    assert.equal(l.observation(day, 'premium')?.official_high_watermark, 500);
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

// e. Genuine sharing: proxy far above the local upper bound trips and blocks admission.
test('e. proxy 5000 over settled 20 trips sticky and blocks admit', () => {
  const c = cfg(), l = verifiedLedger();
  try {
    const model = premiumModel(c);
    l.admit(c, { key: 'e1', hash: 'e1', requestId: 'e1', model, group: 'premium', day, reserve: 100 });
    l.complete('e1', 20);
    let trip: unknown = null;
    try {
      l.publishSharedUsage(day, { premium: 5000, economy: 0 }, { premium: 0, economy: 0 });
    } catch (e) { trip = e; }
    assert.ok(trip instanceof LedgerError);
    assert.equal(trip.code, 'PROXY_PROJECT_SHARED');
    assert.equal(l.pauseReason(), 'PROXY_PROJECT_SHARED');
    // Watermark is not overwritten by the tripping reading.
    assert.equal(l.observation(day, 'premium')?.official_high_watermark, 0);
    // Sticky: still held after the failure, and new admissions are refused.
    assert.equal(l.pauseReason(), 'PROXY_PROJECT_SHARED');
    assert.throws(
      () => l.admit(c, { key: 'e2', hash: 'e2', requestId: 'e2', model, group: 'premium', day, reserve: 10 }),
      (e: unknown) => e instanceof LedgerError && e.code === 'FREE_QUOTA_UNVERIFIED',
    );
  } finally { l.close(); }
});

// f. Small preflight-shaped excess inside outstanding headroom never trips.
test('f. proxy 11 inside outstanding 5000 does not trip', () => {
  const c = cfg(), l = verifiedLedger();
  try {
    const model = premiumModel(c);
    l.admit(c, { key: 'f1', hash: 'f1', requestId: 'f1', model, group: 'premium', day, reserve: 5000 });
    l.publishSharedUsage(day, { premium: 11, economy: 0 }, { premium: 0, economy: 0 });
    assert.equal(l.isPaused(), false);
    assert.equal(l.observation(day, 'premium')?.official_high_watermark, 11);
    const snap = l.snapshot(c, day, 'premium');
    assert.equal(snap.effective_used, 5000 + 10000);
  } finally { l.close(); }
});
