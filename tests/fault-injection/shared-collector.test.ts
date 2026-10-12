import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { collectOnce } from '../../src/collector.ts';
import { Ledger } from '../../src/ledger.ts';
import { makeServer } from '../../src/server.ts';
import { cfg, verifiedLedger } from '../helpers.ts';

const day = new Date().toISOString().slice(0, 10);
const utcStart = Math.floor(Date.parse(day + 'T00:00:00Z') / 1000);
const end = utcStart + 3600;
function bucket(results: any[]) {
  return { object: 'page', data: [{ object: 'bucket', start_time: utcStart, end_time: end, results }], has_more: false, next_page: null };
}
const proxyRow = (c: any, n: number) => ({ model: c.quotas.premium.models[0], project_id: 'proj_test', input_tokens: n, output_tokens: n });
const extRow = (c: any, n: number) => ({ model: c.quotas.premium.models[0], project_id: 'proj_external', input_tokens: n, output_tokens: n });

// 1. Mixed proxy + external traffic in one cycle splits scopes, no failure.
test('mixed org pages split proxy and external scopes without failure', async () => {
  const c = cfg(), l = new Ledger(':memory:');
  const first = { object: 'page', data: [{ object: 'bucket', start_time: utcStart, end_time: end, results: [proxyRow(c, 10)] }], has_more: true, next_page: 'p2' };
  const second = bucket([extRow(c, 25)]);
  let calls = 0;
  const pages = [first, second];
  const fetchImpl = (async () => new Response(JSON.stringify(pages[calls++]), { status: 200 })) as typeof fetch;
  try {
    const result = await collectOnce(c, l, { fetchImpl, adminKey: 'fake' });
    assert.deepEqual(result, { proxy: { premium: 20, economy: 0 }, external: { premium: 50, economy: 0 } });
    assert.equal(l.isPaused(), false);
    const snap = l.snapshot(c, day, 'premium');
    assert.equal(snap.official_proxy_usage, 20);
    assert.equal(snap.official_external_usage, 50);
    assert.equal(snap.official_org_usage, 70);
    // effective = 50 + max(20, 20+0) + 10000
    assert.equal(snap.effective_used, 70 + 10000);
  } finally { l.close(); }
});

// 10. API failure preserves watermarks and the next cycle still polls.
test('api failure preserves checkpoint and never blocks the next poll', async () => {
  const c = cfg(), l = verifiedLedger();
  l.publishSharedUsage(day, { premium: 100, economy: 0 }, { premium: 50, economy: 0 });
  let calls = 0;
  const retryPage = bucket([proxyRow(c, 50), extRow(c, 25)]);
  const flaky = (async () => {
    calls++;
    if (calls === 1) return new Response('', { status: 503 });
    return new Response(JSON.stringify(retryPage), { status: 200 });
  }) as typeof fetch;
  try {
    await assert.rejects(() => collectOnce(c, l, { fetchImpl: flaky, adminKey: 'fake' }), /Admin Usage API unsuccessful/);
    assert.equal(l.pauseReason(), 'COLLECTOR_UNVERIFIED');
    assert.equal(l.observation(day, 'premium')?.official_high_watermark, 100);
    assert.equal(l.observation(day, 'premium')?.official_external, 50);
    const result = await collectOnce(c, l, { fetchImpl: flaky, adminKey: 'fake' });
    assert.equal(calls, 2);
    assert.equal(result.proxy.premium, 100);
    assert.equal(l.isPaused(), false);
  } finally { l.close(); }
});

// 11. Recoverable pause clears on the next complete trusted observation.
test('recoverable stall recovers automatically on trusted success', async () => {
  const c = cfg(), l = verifiedLedger();
  l.setPause('COLLECTOR_DOWN');
  const fetchImpl = (async () => new Response(JSON.stringify(bucket([])), { status: 200 })) as typeof fetch;
  try {
    await collectOnce(c, l, { fetchImpl, adminKey: 'fake' });
    assert.equal(l.pauseReason(), null);
  } finally { l.close(); }
});

// 12. Manual hold survives even successful collection.
test('manual hold is never auto-cleared by collector success', async () => {
  const c = cfg(), l = verifiedLedger();
  l.setPause('MANUAL_REVIEW');
  const fetchImpl = (async () => new Response(JSON.stringify(bucket([])), { status: 200 })) as typeof fetch;
  try {
    await assert.rejects(() => collectOnce(c, l, { fetchImpl, adminKey: 'fake' }), /operator hold/);
    assert.equal(l.pauseReason(), 'MANUAL_REVIEW');
  } finally { l.close(); }
});

// 13. Regression, missing bucket, unknown model, unattributable rows refuse safely.
test('regression across either scope pauses without overwriting', async () => {
  const c = cfg(), l = verifiedLedger();
  l.publishSharedUsage(day, { premium: 100, economy: 0 }, { premium: 80, economy: 0 });
  const fetchImpl = (async () => new Response(JSON.stringify(bucket([{ ...extRow(c, 10), input_tokens: 10, output_tokens: 10 }])), { status: 200 })) as typeof fetch;
  // external 20 < 80 -> regression
  try {
    await assert.rejects(() => collectOnce(c, l, { fetchImpl, adminKey: 'fake' }), /decreased/);
    assert.equal(l.pauseReason(), 'OFFICIAL_WATERMARK_REGRESSION');
    assert.equal(l.observation(day, 'premium')?.official_external, 80);
  } finally { l.close(); }
});

test('missing day bucket, unknown model and unattributable rows fail closed', async () => {
  const c = cfg();
  const empty = (async () => new Response(JSON.stringify({ object: 'page', data: [], has_more: false, next_page: null }), { status: 200 })) as typeof fetch;
  const l1 = new Ledger(':memory:');
  try {
    await assert.rejects(() => collectOnce(c, l1, { fetchImpl: empty, adminKey: 'fake' }), /Missing official day bucket/);
    assert.equal(l1.observation(day, 'premium'), undefined);
  } finally { l1.close(); }
  const unknownModel = (async () => new Response(JSON.stringify(bucket([{ model: 'mystery-model', project_id: 'proj_test', input_tokens: 1, output_tokens: 1 }])), { status: 200 })) as typeof fetch;
  const l2 = new Ledger(':memory:');
  try {
    await assert.rejects(() => collectOnce(c, l2, { fetchImpl: unknownModel, adminKey: 'fake' }), /whitelist/);
    assert.equal(l2.observation(day, 'premium'), undefined);
  } finally { l2.close(); }
  const unattributed = (async () => new Response(JSON.stringify(bucket([{ model: c.quotas.premium.models[0], input_tokens: 1, output_tokens: 1 }])), { status: 200 })) as typeof fetch;
  const l3 = new Ledger(':memory:');
  try {
    await assert.rejects(() => collectOnce(c, l3, { fetchImpl: unattributed, adminKey: 'fake' }), /Unattributable/);
  } finally { l3.close(); }
});

// 18+20. Status API surfaces shared fields, nulls when untrusted, stable error contract.
test('quota endpoint exposes shared fields and nulls, keeps OMP error contract', async () => {
  const c = cfg(), l = verifiedLedger();
  const oldToken = process.env.QG_PROXY_TOKEN, oldKey = process.env.OPENAI_API_KEY;
  process.env.QG_PROXY_TOKEN = 'shared-quota-status-token-1234567890';
  process.env.OPENAI_API_KEY = 'sk-test-only';
  const server = makeServer(c, l);
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    const auth = { authorization: 'Bearer ' + process.env.QG_PROXY_TOKEN };
    const res = await fetch(base + '/quota', { headers: auth });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.groups.length, 2);
    for (const g of body.groups) {
      for (const field of ['utc_day', 'official_org_usage', 'official_external_usage', 'official_proxy_usage',
        'proxy_local_committed', 'proxy_pending_reserved', 'external_safety_reserve', 'effective_used',
        'estimated_remaining', 'last_successful_poll', 'last_poll_attempt', 'observation_age_seconds',
        'state', 'pause_reason', 'next_reset_at']) assert.ok(field in g, field);
      assert.equal(g.pause_reason, null);
    }
    // Hold the ledger: endpoint must zero the estimate but keep scope figures.
    l.setPause('COLLECTOR_DOWN');
    const held = await (await fetch(base + '/quota', { headers: auth })).json() as any;
    assert.equal(held.groups[0].estimated_remaining, 0);
    assert.equal(held.groups[0].pause_reason, 'COLLECTOR_DOWN');
    assert.equal(held.groups[0].official_external_usage, 0);
    // OMP contract: exhausted/error shape unchanged (checked at ledger level).
    l.setPause(null);
    l.publishSharedUsage(day, { premium: 0, economy: 0 }, { premium: 840000, economy: 0 });
    const saturated = await (await fetch(base + '/quota', { headers: auth })).json() as any;
    assert.equal(saturated.groups[0].state, 'EXHAUSTED');
  } finally {
    await new Promise<void>(done => server.close(() => done())); l.close();
    if (oldToken === undefined) delete process.env.QG_PROXY_TOKEN; else process.env.QG_PROXY_TOKEN = oldToken;
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey;
  }
});
