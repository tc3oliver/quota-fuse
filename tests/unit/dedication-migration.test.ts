import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectOnce } from '../../src/collector.ts';
import { Ledger } from '../../src/ledger.ts';
import { gate, readinessIssues } from '../../src/policy.ts';
import { cfg, verifiedLedger } from '../helpers.ts';

const day = new Date().toISOString().slice(0, 10);
const utcStart = Math.floor(Date.parse(day + 'T00:00:00Z') / 1000);
const end = utcStart + 3600;
const bucket = (results: any[]) => ({ object: 'page', data: [{ object: 'bucket', start_time: utcStart, end_time: end, results }], has_more: false, next_page: null });
const evidence = 'operator audit ticket-2026-0199: reviewed Dashboard project activity for proj_test (only QuotaFuse key usage, 2026-10-01..12), verified Costs page shows no unexpected charges, backup stored at ops-vault dated 2026-10-12';

// Retired attestations are compat-only: never gate admission, never expire
// into a daily chore. Only the one-time eligibility confirmation remains.
test('retired project-dedication and costs attestations never gate admission', () => {
  const l = verifiedLedger();
  const oldToken = process.env.QG_PROXY_TOKEN, oldKey = process.env.OPENAI_API_KEY;
  process.env.QG_PROXY_TOKEN = 'dedication-gate-token-1234567890123456';
  process.env.OPENAI_API_KEY = 'sk-test-only';
  try {
    const c = cfg() as any;
    c.policy.proxyProjectDedicatedAttestedUntil = null;
    c.policy.manualCostsAuditedUntil = null;
    assert.doesNotThrow(() => gate(c, l));
    const issues = readinessIssues(c, l);
    assert.ok(!issues.includes('PROXY_PROJECT_DEDICATION_UNVERIFIED'));
    assert.ok(!issues.includes('COST_AUDIT_UNVERIFIED'));
    // Other org projects may share the pool: no org-wide attestation exists.
    assert.equal(c.policy.exclusiveOrgTrafficAttestedUntil !== undefined, true);
  } finally {
    l.close();
    if (oldToken === undefined) delete process.env.QG_PROXY_TOKEN; else process.env.QG_PROXY_TOKEN = oldToken;
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey;
  }
});

// No dedication premise: reflected settlement is added conservatively
// (official increments may be foreign); the gate still passes.
test('dedicated proxy double-counts reflected settlement conservatively and passes the gate', () => {
  const c = cfg(), l = verifiedLedger();
  const oldToken = process.env.QG_PROXY_TOKEN, oldKey = process.env.OPENAI_API_KEY;
  process.env.QG_PROXY_TOKEN = 'dedication-gate-token-1234567890123456';
  process.env.OPENAI_API_KEY = 'sk-test-only';
  try {
    l.admit(c, { key: 'job', hash: 'job', requestId: 'job', model: c.quotas.premium.models[0], group: 'premium', day, reserve: 50000 });
    l.prepareDispatch(c, 'job', 40000, 1000);
    l.complete('job', 41000);
    l.publishSharedUsage(day, { premium: 41000, economy: 0 }, { premium: 7000, economy: 0 });
    assert.doesNotThrow(() => gate(c, l));
    const snap = l.snapshot(c, day, 'premium');
    // effective = 41000 official + 7000 external + 41000 settled + 10000.
    assert.equal(snap.effective_used, 41000 + 7000 + 41000 + 10000);
  } finally {
    l.close();
    if (oldToken === undefined) delete process.env.QG_PROXY_TOKEN; else process.env.QG_PROXY_TOKEN = oldToken;
    if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey;
  }
});

// External unknown model: counted in premium, recorded, never pauses.
test('external unknown models are counted conservatively with diagnostics', async () => {
  const c = cfg(), l = new Ledger(':memory:');
  const rows = [{ model: 'future-model-2099', project_id: 'proj_external', input_tokens: 5, output_tokens: 5 }];
  const fetchImpl = (async () => new Response(JSON.stringify(bucket(rows)), { status: 200 })) as typeof fetch;
  try {
    const result = await collectOnce(c, l, { fetchImpl, adminKey: 'fake' });
    assert.deepEqual(result.external, { premium: 0, economy: 0 });
    assert.deepEqual(result.unknownModels, { 'future-model-2099': { group: 'premium', tokens: 10 } });
    assert.equal(l.isPaused(), false);
    const snap = l.snapshot(c, day, 'premium');
    assert.equal(snap.state, 'READY');
    // Unknown tokens land in BOTH groups' conservative estimates.
    assert.equal(snap.external_unknown_tokens, 10);
    assert.equal(snap.effective_used, 10 + 10000);
    assert.equal(l.snapshot(c, day, 'economy').effective_used, 10 + 100000);
    assert.deepEqual(snap.external_unknown_models, [{ model: 'future-model-2099', group: 'premium', tokens: 10 }]);
  } finally { l.close(); }
});

// Partial official reflection keeps full local reserve; catch-up never drops below it.
test('delayed partial reflection keeps full reserve until catch-up', () => {
  const c = cfg(), l = verifiedLedger();
  try {
    l.admit(c, { key: 'slow', hash: 'slow', requestId: 'slow', model: c.quotas.premium.models[0], group: 'premium', day, reserve: 1000 });
    l.complete('slow', 800);
    // Nothing reflected yet: full 800 retained.
    l.publishSharedUsage(day, { premium: 0, economy: 0 }, { premium: 0, economy: 0 });
    assert.equal(l.snapshot(c, day, 'premium').effective_used, 800 + 10000);
    // Partial reflection: settled is still added in full (conservative).
    l.publishSharedUsage(day, { premium: 300, economy: 0 }, { premium: 0, economy: 0 });
    assert.equal(l.snapshot(c, day, 'premium').effective_used, 300 + 800 + 10000);
    // Full catch-up: added on top, never less.
    l.publishSharedUsage(day, { premium: 800, economy: 0 }, { premium: 0, economy: 0 });
    assert.equal(l.snapshot(c, day, 'premium').effective_used, 800 + 800 + 10000);
  } finally { l.close(); }
});

// A retired legacy pause auto-clears on the next good observation.
test('legacy PROXY_PROJECT_SHARED pause auto-clears on next good observation', async () => {
  const c = cfg(), l = verifiedLedger();
  l.db.prepare("UPDATE guard_control SET paused_reason='PROXY_PROJECT_SHARED' WHERE id=1").run();
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return new Response(JSON.stringify(bucket([])), { status: 200 });
  }) as typeof fetch;
  try {
    const r = await collectOnce(c, l, { fetchImpl, adminKey: 'fake' });
    assert.equal(calls, 1);
    assert.deepEqual(r.proxy, { premium: 0, economy: 0 });
    assert.equal(l.isPaused(), false);
  } finally { l.close(); }
});

// Legacy fingerprints auto-adopt on boot: idempotent, audited, history kept.
test('legacy fingerprint auto-adopts on verify with full history preserved', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qf-shared-mig-'));
  const path = join(dir, 'guard.sqlite');
  try {
    const c = cfg();
    const setup = new Ledger(path);
    try {
      setup.assertPolicy(c);
      // Simulate a pre-shared-accounting ledger: fingerprint without reserve.
      setup.db.prepare('UPDATE policy_fingerprint SET sha256=? WHERE id=1').run(setup.legacyPolicyHash(c));
      setup.publishSharedUsage(day, { premium: 0, economy: 0 }, { premium: 0, economy: 0 });
      setup.admit(c, { key: 'old-key', hash: 'h', requestId: 'r', model: c.quotas.premium.models[0], group: 'premium', day, reserve: 100 });
      setup.unknown('old-key');
      setup.admit(c, { key: 'done-key', hash: 'h2', requestId: 'r2', model: c.quotas.premium.models[0], group: 'premium', day, reserve: 50 });
      setup.complete('done-key', 20);
    } finally { setup.close(); }
    const l = new Ledger(path, { recoverPending: false });
    try {
      // Boot adopts the compatible fingerprint automatically (no manual step)...
      assert.doesNotThrow(() => l.verifyPolicy(c));
      // ...writes a verifiable audit row, and stays a no-op on second boot.
      const audit = l.db.prepare('SELECT operator, from_fingerprint, to_fingerprint FROM accounting_migration_audit').get() as any;
      assert.equal(audit.operator, 'auto-upgrade');
      assert.ok(audit.from_fingerprint !== audit.to_fingerprint);
      assert.doesNotThrow(() => l.verifyPolicy(c));
      assert.equal((l.db.prepare('SELECT COUNT(*) AS n FROM accounting_migration_audit').get() as any).n, 1);
      // History fully preserved: UNKNOWN, settlement, observations, pause bit.
      assert.equal(l.find('old-key')?.state, 'UNKNOWN');
      assert.equal(l.find('done-key')?.actual, 20);
      assert.equal(l.observation(day, 'premium')?.official_high_watermark, 0);
      assert.throws(() => l.admit(c, { key: 'old-key', hash: 'h', requestId: 'r3', model: c.quotas.premium.models[0], group: 'premium', day, reserve: 10 }),
        (e: any) => e.code === 'DUPLICATE_REQUEST');
    } finally { l.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('migration refuses unrelated policy drift and weak evidence', () => {
  const c = cfg();
  const l = new Ledger(':memory:');
  try {
    l.assertPolicy(c);
    l.db.prepare('UPDATE policy_fingerprint SET sha256=? WHERE id=1').run(l.legacyPolicyHash(c));
    assert.throws(() => l.migrateSharedAccounting(c, 'op', 'short'), (e: any) => e.code === 'INVALID_EVIDENCE');
    const drifted = structuredClone(c);
    drifted.dataSharing.projectId = 'proj_somethingelse';
    assert.throws(() => l.migrateSharedAccounting(drifted, 'operator1', evidence), (e: any) => e.code === 'POLICY_CHANGED');
    // Stored fingerprint untouched by refused attempts.
    assert.equal((l.db.prepare('SELECT sha256 FROM policy_fingerprint WHERE id=1').get() as any).sha256, l.legacyPolicyHash(c));
  } finally { l.close(); }
});

test('concurrent boots auto-adopt exactly once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qf-concurrent-mig-'));
  const path = join(dir, 'guard.sqlite');
  try {
    const c = cfg();
    const setup = new Ledger(path);
    try {
      setup.assertPolicy(c);
      setup.db.prepare('UPDATE policy_fingerprint SET sha256=? WHERE id=1').run(setup.legacyPolicyHash(c));
    } finally { setup.close(); }
    const a = new Ledger(path, { recoverPending: false });
    const b = new Ledger(path, { recoverPending: false });
    try {
      assert.doesNotThrow(() => a.verifyPolicy(c));
      assert.doesNotThrow(() => b.verifyPolicy(c));
      assert.equal((a.db.prepare('SELECT COUNT(*) AS n FROM accounting_migration_audit').get() as any).n, 1);
    } finally { a.close(); b.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
