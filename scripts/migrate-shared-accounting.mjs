import { loadConfig } from '../src/config.ts';
import { Ledger, LedgerError } from '../src/ledger.ts';
import { acquireInstanceLock } from '../src/instance-lock.ts';

// Audited in-place adoption of shared-org accounting. Keeps every
// reservation, observation, idempotency key and pause bit; only advances the
// policy fingerprint with an immutable audit row. Prefer this over swapping
// database files (a fresh file loses idempotency and UNKNOWN/PENDING safety).
//
// Usage:
//   npm run accounting:shared-migration -- operator-id 'detailed evidence ticket >=80 chars'
const [, , operator, ...rest] = process.argv;
const evidence = rest.join(' ');
if (!operator || evidence.trim().length < 80 || evidence.length > 4096) {
  console.error('Usage: npm run accounting:shared-migration -- <operator> <evidence-ref>=80-chars');
  console.error('Stop Proxy and Collector first. Evidence must cover: reserve bounds,');
  console.error('proxy-project dedication review, Dashboard Usage/Costs check, backup location.');
  process.exitCode = 2;
} else {
  const config = loadConfig();
  const unlock = acquireInstanceLock(config.server.storage, 'proxy');
  let unlockCollector = null;
  try {
    unlockCollector = acquireInstanceLock(config.server.storage, 'collector');
    const ledger = new Ledger(config.server.storage, { recoverPending: false });
    try {
      try {
        ledger.verifyPolicy(config);
        console.log('Ledger already on shared-org accounting; nothing to migrate.');
      } catch (e) {
        if (!(e instanceof LedgerError) || e.code !== 'POLICY_CHANGED') throw e;
        ledger.migrateSharedAccounting(config, operator, evidence);
        console.log('Shared-accounting fingerprint adopted in place; history preserved.');
        console.log('Next: start the Collector for trusted shared baselines, verify /quota, then start the Proxy.');
      }
    } finally { ledger.close(); }
  } finally { unlockCollector?.(); unlock(); }
}
