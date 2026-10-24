// Competitor watch helpers (used by the "ส่อง" agent for /competitors).
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

// The agent only finds things (a brand's web address, search results, news);
// the script decides what is believable: robots.txt is fetched and classified
// here, a keyword counts as ranking only when the evidence URL is on
// tasaki.co.th, and news is de-duplicated against what is already logged.
const AI_BOTS = ['gptbot', 'chatgpt-user', 'oai-searchbot', 'claudebot', 'claude-web', 'anthropic-ai', 'google-extended', 'perplexitybot', 'ccbot', 'bytespider', 'applebot-extended', 'meta-externalagent'];

// 'blocked' when a group that covers an AI bot (or everyone) disallows the whole site.
export function classifyRobots(text) {
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], disallow: [], allow: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else if (cur && (key === 'disallow' || key === 'allow')) {
      cur[key].push(val);
      lastWasAgent = false;
    } else lastWasAgent = false;
  }
  const fullBlock = (g) => g.disallow.includes('/') && !g.allow.some((a) => a === '/' || a === '/*');
  const blockedBots = new Set();
  let everyone = false;
  for (const g of groups) {
    if (!fullBlock(g)) continue;
    for (const a of g.agents) {
      if (a === '*') everyone = true;
      else if (AI_BOTS.includes(a)) blockedBots.add(a);
    }
  }
  // A block on the Thai content itself (e.g. Daikin's "Disallow: /th/" for every crawler)
  // hides the pages from AI just as well as a full block, so it is reported.
  const thai = groups.find((g) => (g.agents.includes('*') || g.agents.some((a) => AI_BOTS.includes(a))) && g.disallow.some((d) => /^\/th\/?$/i.test(d)));
  if (thai && !everyone) return { value: 'open', detail: 'ปิดเฉพาะเนื้อหาภาษาไทย (Disallow /th/) บอทอ่านเนื้อหาไทยไม่ได้', thaiBlocked: true };
  if (everyone || blockedBots.size >= 3) return { value: 'blocked', detail: everyone ? 'Disallow: / สำหรับทุกบอท' : `ปิดบอท AI ${[...blockedBots].join(', ')}` };
  if (blockedBots.size) return { value: 'open', detail: `เปิดเป็นส่วนใหญ่ แต่ปิดบอท ${[...blockedBots].join(', ')}` };
  return { value: 'open', detail: groups.length ? 'ไม่ได้ปิดบอท AI' : 'robots.txt ว่าง/ไม่มีกฎ' };
}

export async function fetchRobots(domain) {
  const host = String(domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return { value: 'unknown', detail: 'ที่อยู่เว็บไม่ถูกต้อง', host };
  for (const scheme of ['https', 'http']) {
    const r = await fetchRobotsAt(scheme, host);
    if (r.value !== 'unknown' || r.hard) return r;
  }
  return { value: 'unknown', detail: 'เชื่อมต่อเว็บไม่ได้ทั้ง https และ http', host };
}

// Some old sites only work over plain http (broken certificate); http is tried second.
async function fetchRobotsAt(scheme, host) {
  try {
    const res = await fetch(`${scheme}://${host}/robots.txt`, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; TasakiCompetitorWatch)' }, signal: AbortSignal.timeout(20000), redirect: 'follow' });
    if (res.status === 404) return { value: 'open', detail: 'ไม่มี robots.txt (เปิดทั้งหมด)', host };
    if (!res.ok) return { value: 'unknown', detail: `เปิด robots.txt ไม่ได้ (${res.status})`, host, hard: true };
    const type = res.headers.get('content-type') || '';
    const body = await res.text();
    if (/html/i.test(type) && /<html/i.test(body.slice(0, 500))) return { value: 'open', detail: 'ไม่มี robots.txt จริง (เว็บตอบเป็นหน้าเว็บแทน) ถือว่าเปิดทั้งหมด', host };
    return { ...classifyRobots(body), host };
  } catch (e) {
    return { value: 'unknown', detail: `เชื่อมต่อไม่ได้ (${e.cause?.code || e.message})`.slice(0, 80), host };
  }
}

export const onTasakiDomain = (url) => {
  try { const h = new URL(url).hostname.toLowerCase(); return h === 'tasaki.co.th' || h.endsWith('.tasaki.co.th'); } catch { return false; }
};

// ─── Meta Ad Library (active ads per advertiser page) ────────────────────────
// The library answers plain HTTP requests with 403 but renders for a real
// browser, so a headless Chrome loads the page-scoped URL (no login needed) and
// the count is read from the page's own "~N results" / "No ads match" line.
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export function parseAdCount(html) {
  const m = /~?\s*([\d,]+)\s+results?\b/i.exec(html);
  if (m) return Number(m[1].replace(/,/g, ''));
  if (/No ads match|ไม่พบโฆษณา|ไม่มีโฆษณา/i.test(html)) return 0;
  return null;
}

// One retry: the page occasionally finishes rendering after the time budget.
export async function adCount(pageId) {
  return (await adCountOnce(pageId)) ?? adCountOnce(pageId);
}

function adCountOnce(pageId) {
  if (!/^\d{8,20}$/.test(String(pageId))) return Promise.resolve(null);
  if (!fs.existsSync(CHROME)) return Promise.resolve(null);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'adlib-'));
  const url = `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=TH&view_all_page_id=${pageId}`;
  return new Promise((resolve) => {
    execFile(CHROME, ['--headless=new', '--disable-gpu', `--user-data-dir=${profile}`, '--virtual-time-budget=20000', '--window-size=1400,1000', '--dump-dom', url],
      { maxBuffer: 64 * 1024 * 1024, timeout: 90000 }, (err, stdout) => {
        fs.rmSync(profile, { recursive: true, force: true });
        resolve(err ? null : parseAdCount(stdout));
      });
  });
}
