import { Ledger } from '../../src/ledger.ts';
import { cfg } from '../helpers.ts';
import { utcDay } from '../../src/config.ts';

const [path, key] = process.argv.slice(2);
if (!path || !key) process.exit(3);
const l = new Ledger(path, { recoverPending: false });
try {
  const config = cfg();
  l.admit(config, { key, hash: key, requestId: key, model: config.quotas.premium.models[0],
    group: 'premium', day: utcDay(), reserve: 50_000 });
  process.exitCode = 0;
} catch (e: any) {
  if (e?.code === 'FREE_QUOTA_EXHAUSTED') process.exitCode = 9;
  else { console.error(e?.code ?? 'LEDGER_ERROR'); process.exitCode = 10; }
} finally { l.close(); }
