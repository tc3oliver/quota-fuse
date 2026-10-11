import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const setup = join(root, 'scripts/setup.mjs');
const status = join(root, 'scripts/status.mjs');

test('setup creates separate credentials, config and private file permissions without overwriting', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quota-fuse-setup-'));
  try {
    copyFileSync(join(root, 'config.example.json'), join(dir, 'config.example.json'));
    const first = spawnSync(process.execPath, [setup], { cwd: dir, encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    const proxy = readFileSync(join(dir, '.env.proxy'), 'utf8');
    const collector = readFileSync(join(dir, '.env.collector'), 'utf8');
    const cfg = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
    assert.match(proxy, /QG_PROXY_TOKEN=[0-9a-f]{64}/);
    assert.match(proxy, /OPENAI_API_KEY=/);
    assert.doesNotMatch(proxy, /OPENAI_ADMIN_KEY=/);
    assert.match(collector, /OPENAI_ADMIN_KEY=/);
    assert.doesNotMatch(collector, /OPENAI_API_KEY=|QG_PROXY_TOKEN=/);
    assert.equal(cfg.policy.preflightCostVerified, false);
    assert.deepEqual(cfg.quotas.premium.models, []);
    if (process.platform !== 'win32') {
      for (const name of ['config.json','.env.proxy','.env.collector'])
        assert.equal(statSync(join(dir,name)).mode & 0o777, 0o600);
    }
    writeFileSync(join(dir, 'config.json'), 'operator-edited');
    const second = spawnSync(process.execPath, [setup], { cwd: dir, encoding: 'utf8' });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(readFileSync(join(dir,'config.json'),'utf8'), 'operator-edited');
    assert.equal(readFileSync(join(dir,'.env.proxy'),'utf8'), proxy);
    assert.equal(readFileSync(join(dir,'.env.collector'),'utf8'), collector);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('status explains missing service without reporting credentials', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quota-fuse-status-'));
  try {
    copyFileSync(join(root,'config.example.json'),join(dir,'config.json'));
    const secret = 'do-not-print-' + '1234567890'.repeat(4);
    const result = spawnSync(process.execPath, [status], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, QG_CONFIG: './config.json', QG_PROXY_TOKEN: secret }
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Cannot reach the local QuotaFuse service/);
    assert.doesNotMatch(result.stderr + result.stdout, /do-not-print/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
