// Builds the static site for GitHub Pages: copies app/ and writes config.json
// with the relay address (SQUIGGLE_RELAY_URL / RELAY_URL). Used by the Deploy
// and PR preview workflows; handy locally too:
//   RELAY_URL=https://squiggle-relay.you.workers.dev node scripts/build-site.mjs _site
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const out = resolve(process.argv[2] || '_site');
const relayUrl = String(process.env.RELAY_URL || process.env.SQUIGGLE_RELAY_URL || '').trim();

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync('app', out, { recursive: true });
writeFileSync(resolve(out, 'config.json'), JSON.stringify({ relayUrl }) + '\n');
writeFileSync(resolve(out, '.nojekyll'), '');
if (!relayUrl) console.log('::warning::SQUIGGLE_RELAY_URL is not set; the app will ask for the relay address on first run.');
console.log(`Built ${out}${relayUrl ? ` (relay ${relayUrl})` : ''}`);
