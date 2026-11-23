// Compares this Mac's .env with the server copy's .env and lists settings the
// server is missing or has empty. Never prints values.
//   node scripts/check-server-env.mjs          → report only, exit 1 if missing
//   node scripts/check-server-env.mjs --fix    → copy the missing ones to the server
// Run by scripts/deploy-server.sh before every restart.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const HOST = 'tasaki@192.168.10.10';
const DIR = '/mnt/newdisk/www/Marketking-Dashboard';
// Settings that may rightly be different or absent on the server: the AI team
// (and its website bot login) runs on the Mac, and TRACKER_KEY stays Mac-only
// so page-tracking reads remain private.
const SERVER_MAY_SKIP = new Set(['PORT', 'AGENT_RUNNER', 'TASAKI_WEB_BOT_EMAIL', 'TASAKI_WEB_BOT_PASSWORD', 'TRACKER_KEY']);

function parse(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) out[m[1]] = { line: line.trim(), value: m[2].trim().replace(/^["']|["']$/g, '') };
  }
  return out;
}

const local = parse(readFileSync(new URL('../.env', import.meta.url), 'utf8'));
const server = parse(execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', HOST, `cat ${DIR}/.env`], { encoding: 'utf8' }));

const missing = Object.keys(local).filter((k) => local[k].value && !SERVER_MAY_SKIP.has(k) && !(server[k] && server[k].value));
if (!missing.length) { console.log('✓ Server .env has every setting this Mac has.'); process.exit(0); }

console.log('⚠ Server .env is missing or empty:', missing.join(', '));
if (!process.argv.includes('--fix')) { console.log('Run with --fix to copy them from this Mac.'); process.exit(1); }

const script = `
import sys
new = {l.split('=', 1)[0]: l.rstrip('\\n') for l in sys.stdin if '=' in l}
lines = open('.env').read().splitlines(); seen = set(); out = []
for l in lines:
    k = l.split('=', 1)[0].strip()
    if k in new: out.append(new[k]); seen.add(k)
    else: out.append(l)
out += [v for k, v in new.items() if k not in seen]
open('.env', 'w').write('\\n'.join(out) + '\\n')
`;
execFileSync('ssh', ['-o', 'BatchMode=yes', HOST,
  `cd ${DIR} && cp .env .env.bak-$(date +%Y%m%d%H%M%S) && python3 -c ${JSON.stringify(script).replace(/\$/g, '\\$')}`],
  { input: missing.map((k) => local[k].line).join('\n') + '\n', stdio: ['pipe', 'inherit', 'inherit'] });
console.log('✓ Copied to server (old .env backed up):', missing.join(', '));
