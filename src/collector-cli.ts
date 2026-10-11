import { loadConfig } from './config.ts';
import { Ledger } from './ledger.ts';
import { collectOnce } from './collector.ts';
import { acquireInstanceLock } from './instance-lock.ts';
const config = loadConfig();
if (process.env.OPENAI_API_KEY) throw new Error('Do not share upstream project credential with Admin collector');
const releaseLock = acquireInstanceLock(config.server.storage, 'collector');
const ledger = new Ledger(config.server.storage, { recoverPending: false });
ledger.assertPolicy(config);
const once = process.argv.includes('--once');
let running = false;
async function tick() {
  if (running) return;
  running = true;
  try { const results = await collectOnce(config, ledger); console.log('Usage reconciliation complete', new Date().toISOString(), results); }
  catch { console.error('Collector fail-closed: upstream usage inaccessible or unverified'); if (once) process.exitCode = 1; }
  finally { running = false; }
}
await tick();
if (once) { ledger.close(); releaseLock(); }
else {
  const timer = setInterval(tick, 120000);
  for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal, () => {
    clearInterval(timer); ledger.close(); releaseLock(); process.exit(0);
  });
}
