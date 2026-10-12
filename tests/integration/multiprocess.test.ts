import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ledger } from '../../src/ledger.ts';
import { cfg } from '../helpers.ts';
import { utcDay } from '../../src/config.ts';

const worker = fileURLToPath(new URL('../fixtures/admit-worker.ts', import.meta.url));
function runWorker(database: string, id: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--experimental-strip-types', worker, database, id], {
      stdio: 'ignore', env: process.env
    });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 10));
  });
}
test('two separate OS processes never oversubscribe final 50K', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'quota-guard-race-'));
  const database = join(dir, 'ledger.sqlite');
  try {
    const l = new Ledger(database); const c = cfg();
    l.publishSharedUsage(utcDay(), { premium: 0, economy: 0 }, { premium: 0, economy: 0 });
    l.admit(c, { key: 'existing-790k', hash: 'existing', requestId: 'existing',
      model: c.quotas.premium.models[0], group: 'premium', day: utcDay(), reserve: 790_000 });
    l.close();
    const result = await Promise.all([runWorker(database, 'worker-one'), runWorker(database, 'worker-two')]);
    assert.deepEqual(result.sort(), [0, 9]);
    const verify = new Ledger(database, { recoverPending: false });
    assert.equal(verify.snapshot(c, utcDay(), 'premium').estimated_remaining, 0);
    verify.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
