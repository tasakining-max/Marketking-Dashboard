import { execSync } from 'child_process';

const WEBSITE_REPO = process.env.TASAKI_WEB_REPO || '/Users/marketingengineer/Desktop/tasaki-web';

execSync('git pull --ff-only', { cwd: WEBSITE_REPO, stdio: 'ignore' });

const log = execSync('git log --since=midnight --no-merges --pretty=%s', {
  cwd: WEBSITE_REPO,
  encoding: 'utf8',
});

const messages = log.split('\n').map((l) => l.trim()).filter(Boolean);
messages.forEach((m) => console.log(m));
