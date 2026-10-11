import { loadConfig } from './config.ts';
import { Ledger } from './ledger.ts';
import { acquireInstanceLock } from './instance-lock.ts';

const [action,key,operator,...evidenceParts] = process.argv.slice(2);
if (action !== 'preflight-zero' || !key || !operator || !evidenceParts.length) {
  console.error('Usage: npm run reconcile -- preflight-zero <idempotency-key> <operator> <audited-evidence-reference>');
  process.exitCode = 2;
} else {
  const config = loadConfig();
  // Requires the proxy to be STOPPED; prevents a live request racing manual action.
  const unlock = acquireInstanceLock(config.server.storage, 'proxy');
  let unlockCollector: (() => void) | null = null;
  try {
    unlockCollector = acquireInstanceLock(config.server.storage, 'collector');
    const ledger = new Ledger(config.server.storage, { recoverPending: false });
    try {
      ledger.verifyPolicy(config);
      // Explicit operator maintenance stop; no concurrently running collector may unpause it.
      ledger.setPause('MANUAL_REVIEW');
      ledger.reconcilePreflight(key, operator, evidenceParts.join(' '));
      console.log('Preflight-only UNKNOWN reconciled; review audit trail before restarting collector.');
    } finally { ledger.close(); }
  } finally { unlockCollector?.(); unlock(); }
}
