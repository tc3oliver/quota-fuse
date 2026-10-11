import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const configPath = resolve(process.env.QG_CONFIG || './config.json');
let config;
try { config = JSON.parse(readFileSync(configPath, 'utf8')); }
catch {
  console.error('Configuration not found. Run npm run setup, then edit config.json.');
  process.exit(1);
}
const token = process.env.QG_PROXY_TOKEN;
if (!token) {
  console.error('Proxy token is missing. Use npm run status:local to load .env.proxy.');
  process.exit(1);
}
const url = 'http://127.0.0.1:' + config.server.port;
async function get(path) {
  return fetch(url + path, {
    headers: { authorization: 'Bearer ' + token },
    signal: AbortSignal.timeout(3000)
  });
}
try {
  const live = await get('/health/live');
  if (!live.ok) throw new Error('Health endpoint unavailable');
  const ready = await get('/health/ready');
  const quota = await get('/quota');
  if (!quota.ok) throw new Error('Quota endpoint rejected the local proxy token');
  const body = await quota.json();
  console.log('QuotaFuse at ' + url);
  console.log('Admission: ' + (ready.ok ? 'READY' : 'PAUSED (fail-closed)'));
  for (const group of body.groups || []) {
    console.log(group.group + ': ' + group.estimated_remaining.toLocaleString('en-US') +
      ' estimated admissible tokens (' + group.state + ', UTC ' + group.utc_day + ')');
  }
  if (!ready.ok) {
    console.log('For a new installation this is expected. Complete Data Sharing and billing checks before enabling requests.');
    console.log('Guide: docs/deployment.md');
  }
} catch {
  console.error('Cannot reach the local QuotaFuse service at ' + url + '. Start it with npm run start:local.');
  process.exitCode = 1;
}
