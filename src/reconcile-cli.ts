import { loadConfig } from './config.ts';
import { Ledger } from './ledger.ts';
import { acquireInstanceLock } from './instance-lock.ts';

const [action,key,operator,...rest] = process.argv.slice(2);
const dispatched = action === 'dispatched-day-bounded';
const terminalAt = dispatched ? rest[0] : undefined;
const acknowledgement = rest[1];
const evidence = dispatched ? rest.slice(2).join(' ') : rest.join(' ');
const preflight = action === 'preflight-zero';
if (!key || !operator || !(preflight || dispatched) ||
    (preflight ? evidence.length < 20 : !terminalAt || acknowledgement !== '--attest-finalized-usage-and-costs' || evidence.length < 80)) {
  console.error('Usage: npm run reconcile -- preflight-zero <key> <operator> <evidence-ref>');
  console.error('OR: npm run reconcile -- dispatched-day-bounded <key> <operator> <terminal-response-UTC-ISO> --attest-finalized-usage-and-costs <detailed-request-logs-and-usage-costs-evidence>');
  console.error('The dispatched option is ONLY for a proven same-old-day terminal response, >=24h after that day ended.');
  process.exitCode = 2;
} else {
  const config = loadConfig();
  const unlock = acquireInstanceLock(config.server.storage, 'proxy');
  let unlockCollector: (() => void) | null = null;
  try {
    unlockCollector = acquireInstanceLock(config.server.storage, 'collector');
    const ledger = new Ledger(config.server.storage, { recoverPending: false });
    try {
      ledger.verifyPolicy(config);
      // Maintenance stop; distinct audited operations, no implicit unpause.
      ledger.enterManualReview();
      if (preflight) {
        ledger.reconcilePreflight(key, operator, evidence);
        console.log('Preflight-only UNKNOWN reconciled; review audit trail before restarting collector.');
      } else {
        ledger.reviewDispatchedDay(key, operator, terminalAt!, evidence);
        console.log('Prior-day DISPATCHED UNKNOWN reviewed: original UNKNOWN and full reservation retained. Re-run collector and check READY.');
      }
    } finally { ledger.close(); }
  } finally { unlockCollector?.(); unlock(); }
}
