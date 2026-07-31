import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const QUEUE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pending-website-updates');

let files = [];
try {
  files = readdirSync(QUEUE_DIR).filter((f) => f.endsWith('.json') && !f.startsWith('.'));
} catch {
  process.exit(0);
}

if (files.length === 0) process.exit(0);

const batches = files.map((f) => {
  const full = path.join(QUEUE_DIR, f);
  const data = JSON.parse(readFileSync(full, 'utf8'));
  return { file: full, date: data.date, commits: data.commits };
});

const summary = batches
  .map((b) => `${b.date} (${b.file}):\n${b.commits.map((c) => `  - [${c.date}] ${c.message}`).join('\n')}`)
  .join('\n\n');

const additionalContext = `There are pending Tasaki website git commits queued by the daily launchd job, waiting to be logged into the dashboard's "Tasaki Website Updates" changelog. Process these now using the website-updater agent's approach (translate to plain, non-technical Thai, grouped by topic — see [[feedback_website_changelog_style]] memory). Each commit below is shown with its actual commit timestamp (already in Thai local time). IMPORTANT: post each entry as a {"text": "...", "date": "<timestamp>"} object (not a bare string) via scripts/post-website-changelog.mjs, using the actual commit timestamp of that topic's commit(s) — not the batch date at noon, not "now". If a topic groups several commits, use the timestamp of the latest commit in that group. Delete each pending JSON file once its entries are posted.\n\n${summary}`;

console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext,
  },
}));
