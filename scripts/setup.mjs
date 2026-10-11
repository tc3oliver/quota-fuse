import { randomBytes } from 'node:crypto';
import { readFileSync, openSync, closeSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Run from the repository root. Create user-owned files without overwriting edits.
const root = process.cwd();
const example = resolve(root, 'config.example.json');
if (!existsSync(example)) {
  console.error('Run npm run setup from the QuotaFuse repository root.');
  process.exit(1);
}
const config = readFileSync(example, 'utf8');
JSON.parse(config); // Do not create partial setup files from an invalid example.

function createIfMissing(name, content) {
  const path = resolve(root, name);
  let fd;
  try { fd = openSync(path, 'wx', 0o600); }
  catch (error) {
    if (error?.code === 'EEXIST') {
      console.log('Kept existing ' + name);
      return;
    }
    throw error;
  }
  try {
    writeFileSync(fd, content, { encoding: 'utf8' });
  } finally {
    closeSync(fd);
  }
  chmodSync(path, 0o600);
  console.log('Created ' + name + ' (owner-only permissions)');
}
createIfMissing('config.json', config);
createIfMissing('.env.proxy',
  '# QuotaFuse proxy: keep OPENAI_ADMIN_KEY in the separate collector file.\n' +
  'QG_CONFIG=./config.json\n' +
  'QG_PROXY_TOKEN=' + randomBytes(32).toString('hex') + '\n' +
  'OPENAI_API_KEY=\n');
createIfMissing('.env.collector',
  '# QuotaFuse collector: keep OPENAI_API_KEY and QG_PROXY_TOKEN out of this file.\n' +
  'QG_CONFIG=./config.json\n' +
  'OPENAI_ADMIN_KEY=\n');
console.log('\nNext: edit config.json and the two .env files; then run npm run start:local and npm run collector:local in separate terminals.');
console.log('Config and credentials default to DENY. Never commit these local files.');
