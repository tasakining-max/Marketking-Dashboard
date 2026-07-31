import { execSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const WEBSITE_REPO = process.env.TASAKI_WEB_REPO || '/Users/marketingengineer/Desktop/tasaki-web';
const QUEUE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pending-website-updates');
const STATE_FILE = path.join(QUEUE_DIR, '.state.json');

execSync('git pull --ff-only', { cwd: WEBSITE_REPO, stdio: 'ignore' });

const today = new Date().toISOString().slice(0, 10);
const todayMidnight = `${today}T00:00:00`;

let state = {};
if (existsSync(STATE_FILE)) {
  state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
}
// Only trust the saved watermark if it's from today; otherwise fall back to midnight
// so a stale pointer from a previous day (or a never-processed file) doesn't skip commits.
const since = state.lastRun && state.lastRun.slice(0, 10) === today ? state.lastRun : todayMidnight;

const log = execSync(`git log --since="${since}" --no-merges --pretty=%aI%x1f%s`, {
  cwd: WEBSITE_REPO,
  encoding: 'utf8',
});

const newCommits = log.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
  const [date, message] = l.split('\x1f');
  return { date, message };
});

mkdirSync(QUEUE_DIR, { recursive: true });

if (newCommits.length > 0) {
  const queueFile = path.join(QUEUE_DIR, `${today}.json`);
  let existing = { date: today, commits: [] };
  if (existsSync(queueFile)) {
    existing = JSON.parse(readFileSync(queueFile, 'utf8'));
  }
  existing.commits = [...existing.commits, ...newCommits];
  writeFileSync(queueFile, JSON.stringify(existing, null, 2));
}

writeFileSync(STATE_FILE, JSON.stringify({ lastRun: new Date().toISOString() }, null, 2));
