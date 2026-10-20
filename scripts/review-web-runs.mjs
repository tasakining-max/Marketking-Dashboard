// SessionStart hook: hands Claude every scheduled WEB summary it hasn't
// reviewed yet, so each run (script → Haiku → Opus → posted) gets a human-
// level check. Replaces the old "post website commits yourself" queue: WEB
// does the posting now; Claude only checks the results.
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const STATE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pending-website-updates');
const STATE = path.join(STATE_DIR, '.web-review.json');

let since = 0;
try { since = new Date(JSON.parse(readFileSync(STATE, 'utf8')).reviewedUntil).getTime() || 0; } catch {}

let tasks = [];
try {
  const res = await fetch('http://localhost:5050/api/agents', { signal: AbortSignal.timeout(5000) });
  tasks = (await res.json()).tasks || [];
} catch {
  process.exit(0);
}

const runs = tasks
  .filter((t) => t.agent === 'website' && t.input?.mode === 'daily' && ['done', 'failed'].includes(t.status) && new Date(t.finishedAt || t.updatedAt).getTime() > since)
  .sort((a, b) => new Date(a.finishedAt || a.updatedAt) - new Date(b.finishedAt || b.updatedAt));
if (!runs.length) process.exit(0);

const icon = { website: '🌐 Website', system: '🛠 Marketing System', ads: '📈 Ads' };
const summary = runs.map((t) => {
  const r = t.result || {};
  const head = `Run ${t.id} (${t.prompt}) window ${t.input.since} → ${t.input.until}, status ${t.status}${t.error ? `, error: ${t.error}` : ''}`;
  const lines = (r.entries || []).map((e) => `  - [${icon[e.section] || e.section} · ${e.date}${e.method ? ` · ${e.method}` : ''}] ${e.text}`);
  return [head, `  review notes: ${r.review || '-'}`, ...(lines.length ? lines : ['  (no entries posted)'])].join('\n');
}).join('\n\n');

mkdirSync(STATE_DIR, { recursive: true });
writeFileSync(STATE, JSON.stringify({ reviewedUntil: new Date().toISOString() }));

const additionalContext = `The AI team's WEB agent posted its scheduled "what I've done" summaries without approval (her rule: routine work runs on its own; Claude checks the results). Review the runs below before anything else: compare each entry with the real sources for its window (git log of ~/Desktop/tasaki-web and of this repo, and the ad-related agent tasks she approved/rejected), check for missing approved work, invented items, wrong section, wrong time, duplicates and technical jargon. Tell her in a few lines of plain Thai what WEB got right and what was wrong. Fix a wrong entry only if it's clearly wrong, and if the same mistake repeats, improve the script/checks in lib/agentTeam.js (dailySources / dailyPrompt / verifyDaily) rather than fixing entries by hand each time.\n\n${summary}`;

console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } }));
