import { loadConfig, utcDay } from './config.ts';
import { Ledger } from './ledger.ts';
const config = loadConfig();
const ledger = new Ledger(config.server.storage, { recoverPending: false, readOnly: true });
ledger.verifyPolicy(config);
const now = new Date();
for (const group of ['premium','economy'] as const) console.log(JSON.stringify(ledger.snapshot(config, utcDay(now), group, now)));
ledger.close();
