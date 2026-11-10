// ─── AI Team ("ทีม AI") ──────────────────────────────────────────────────────
// A small team of AI helpers driven from public/agents.html. Each agent runs on
// this Mac through the CLI that's already logged in to the user's monthly plan
// (Claude Code → Claude plan, Codex → ChatGPT plan), so there's no API bill.
//
// Agents only ever draft. Their output lands in "รออนุมัติ" and nothing on the
// board/changelog changes until the user approves — the approve step is plain
// server code (onApprove below), not the AI.
//
// The runner only exists where AGENT_RUNNER=1 (the user's own Mac): the CLIs
// are logged in to her personal plans, so the shared production dashboard
// must never pick up tasks. It only works Mon–Fri (plus company-calendar Saturdays) 08:00–17:00 Bangkok time;
// tasks ordered outside those hours wait in the queue.
import { spawn, execFile, execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { enginePreferences, effectiveEngine, saveEngine, codexSchema, claudeSession, revisionContext, recentNote } from './agentEngine.js';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fixCatalogBrands } from './catalogFix.js';
import { syncFeatures, featureChangesIn } from './featureTracker.js';
import { fetchRobots, onTasakiDomain, adCount } from './rivalWatch.js';
import { staleCatalogs, allCatalogs, groupByUrl, groupByModelText, uploadFixedCatalog, specColumns, groupSpecs, loadPdf, UNREADABLE_PDF, brandHits, clipPdfText, checkChanges, applyChanges } from './catalogSync.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const IMAGES_DIR = path.join(ROOT, 'public', 'uploads', 'agent-images');

// A new shoot folder (copy finished: nothing changed for 10 min) becomes a
// ฟุต job. Folders that existed when this started are remembered as seen, so
// only new shoots trigger.
const WEBSITE_REPO = process.env.TASAKI_WEB_REPO || '/Users/marketingengineer/Desktop/tasaki-web';
const RUNNER_ON = process.env.AGENT_RUNNER === '1';
// No daily cap unless AGENT_DAILY_LIMIT is set (she asked for none).
const DAILY_LIMIT = Number(process.env.AGENT_DAILY_LIMIT) || null;
const TASK_TIMEOUT_MS = 15 * 60 * 1000;
const POLL_MS = 5000;
const WORK_DAYS = [1, 2, 3, 4, 5];
// Saturdays are work days only when they are on the company calendar. Her list
// of dates lives in the setting below; this copy is refreshed every minute.
const SAT_KEY = '__work_saturdays';
let workSaturdays = new Set();
async function loadWorkSaturdays(prisma) {
  const row = await prisma.agentSetting.findUnique({ where: { agent: SAT_KEY } });
  try { workSaturdays = new Set(JSON.parse(row?.rules || '[]')); } catch { workSaturdays = new Set(); }
}
// Agents she has personally signed off as ready ("ผ่าน"); everyone else is still in training.
const PASSED_KEY = '__passed_agents';
async function loadPassedAgents(prisma) {
  const row = await prisma.agentSetting.findUnique({ where: { agent: PASSED_KEY } });
  try { return JSON.parse(row?.rules || '[]'); } catch { return []; }
}
const isWorkDay = ({ weekday, date }) => WORK_DAYS.includes(weekday) || (weekday === 6 && workSaturdays.has(date));
const WORK_START_HOUR = 8;
const WORK_END_HOUR = 17;


const BRAND_NOTE = `คุณเป็นส่วนหนึ่งของทีม AI ฝ่ายการตลาดของ Tasaki Air (แอร์/HVAC ผลิตในไทย)
ตอบเป็นภาษาไทยที่อ่านง่ายและเป็นธรรมชาติ อย่าใช้โครงประโยคซ้ำๆ เหมือนแม่แบบ
งานของคุณเป็นแค่ "ร่าง" ให้คนตรวจก่อนเสมอ ห้ามแก้ไฟล์ ห้ามโพสต์ ห้ามเปลี่ยนข้อมูลใดๆ เอง
ถ้าข้อมูลไม่พอให้บอกตรงๆ ห้ามเดาตัวเลขหรือข้อเท็จจริงขึ้นมาเอง`;

// ─── Time window ─────────────────────────────────────────────────────────────
function bangkokNow() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Bangkok', weekday: 'short', hour: 'numeric', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return { weekday, hour: Number(parts.hour), date: `${parts.year}-${parts.month}-${parts.day}` };
}

function isWorkingHours() {
  const now = bangkokNow();
  return isWorkDay(now) && now.hour >= WORK_START_HOUR && now.hour < WORK_END_HOUR;
}

function startOfBangkokDay() {
  return new Date(`${bangkokNow().date}T00:00:00+07:00`);
}

// ─── CLI discovery ───────────────────────────────────────────────────────────
// Both CLIs ship inside their VS Code extensions, whose folder name changes on
// every update — pick the most recently installed copy.
function newestExisting(paths) {
  return paths
    .filter((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } })
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null;
}

function extensionBinaries(prefix, relPath) {
  const dir = path.join(os.homedir(), '.vscode', 'extensions');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.startsWith(prefix)); } catch {}
  return names.map((n) => path.join(dir, n, relPath));
}

function claudeBin() {
  return process.env.CLAUDE_BIN || newestExisting(extensionBinaries('anthropic.claude-code-', 'resources/native-binary/claude'));
}

function codexBin() {
  // Prefer the extension's native binary; the app bundle can be Intel-only.
  return process.env.CODEX_BIN
    || newestExisting(extensionBinaries('openai.chatgpt-', 'bin/macos-aarch64/codex'))
    || newestExisting(['/Applications/ChatGPT.app/Contents/Resources/codex']);
}

// ─── Context helpers ─────────────────────────────────────────────────────────
function fmtDate(d) {
  return new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
}

function websiteCommits(date) {
  try { execFileSync('git', ['pull', '--ff-only'], { cwd: WEBSITE_REPO, stdio: 'ignore', timeout: 30000 }); } catch {}
  return gitCommits(WEBSITE_REPO, `${date}T00:00:00+07:00`, `${date}T23:59:59+07:00`);
}

function gitCommits(repo, since, until) {
  let out = '';
  try {
    out = execFileSync('git', ['log', '--all', '--no-merges', `--since=${since}`, `--until=${until}`, '--name-only', '--pretty=%x1e%H%x1f%aI%x1f%s%x1f%b%x1f'], { cwd: repo, encoding: 'utf8' });
  } catch { return []; }
  return out.split('\x1e').map((r) => r.trim()).filter(Boolean).map((r) => {
    const [hash, when, subject, body, names] = r.split('\x1f');
    // File names say what a vague subject doesn't; media/assets are noise.
    const files = [...new Set((names || '').split('\n').map((f) => f.trim()).filter((f) => f && !/\.(png|jpe?g|webp|svg|mp4|mov|pdf|ecproj|fcproj)$/i.test(f)))];
    return { hash, date: when, subject, body: (body || '').replace(/Co-Authored-By:.*$/gim, '').trim(), files: files.slice(0, 40) };
  });
}

// What WEB has already logged, by source (commit:<hash> / task:<id>), not by
// wording: a re-run over the same hours ("ทำอีกครั้ง", or her own @WEB that
// covers the whole day) rephrases the same commit, and wording checks miss it.
const LOGGED_SOURCES_KEY = '__web_logged_sources';
async function loggedSources(prisma) {
  const row = await prisma.agentSetting.findUnique({ where: { agent: LOGGED_SOURCES_KEY } });
  if (row) { try { return new Set(JSON.parse(row.rules || '[]')); } catch { return new Set(); } }
  // First run: everything inside summaries she already approved counts as logged.
  const keys = [];
  for (const t of await prisma.agentTask.findMany({ where: { agent: 'website', status: 'done' }, select: { input: true } })) {
    if (t.input?.since && t.input?.until) keys.push(...(await sourcesIn(prisma, t.input.since, t.input.until)).map((s) => s.key));
  }
  const all = [...new Set(keys)].slice(-3000);
  await prisma.agentSetting.upsert({ where: { agent: LOGGED_SOURCES_KEY }, create: { agent: LOGGED_SOURCES_KEY, rules: JSON.stringify(all) }, update: {} });
  return new Set(all);
}
async function markLogged(prisma, keys) {
  const all = [...new Set([...(await loggedSources(prisma)), ...keys])].slice(-3000);
  const rules = JSON.stringify(all);
  await prisma.agentSetting.upsert({ where: { agent: LOGGED_SOURCES_KEY }, create: { agent: LOGGED_SOURCES_KEY, rules }, update: { rules } });
}
const decidedAdWork = async (prisma, range) => (await prisma.agentTask.findMany({ where: { agent: { in: ['ads', 'adideas', 'image', 'motion', 'caption'] }, decidedAt: range }, orderBy: { decidedAt: 'asc' } }))
  .filter((t) => t.input?.mode !== 'daily');
// Every source in a window, logged or not, with the log it belongs to.
async function sourcesIn(prisma, since, until) {
  const range = { gte: new Date(since), lte: new Date(until) };
  return [
    ...gitCommits(WEBSITE_REPO, since, until).map((c) => ({ section: 'website', key: `commit:${c.hash}`, t: new Date(c.date).getTime() })),
    ...gitCommits(ROOT, since, until).map((c) => ({ section: 'system', key: `commit:${c.hash}`, t: new Date(c.date).getTime() })),
    ...(await decidedAdWork(prisma, range)).map((w) => ({ section: 'ads', key: `task:${w.id}`, t: new Date(w.decidedAt).getTime() })),
    ...(await featureChangesIn(prisma, since, until)).flatMap((f) => f.times.map((t) => ({ section: 'website', key: f.key, t: new Date(t).getTime() }))),
  ];
}

// "What I've done" for one window of time, from where it's actually recorded:
// the two git repos, the ad work the team did that she decided on, and what is
// already in each log (so nothing is posted twice).
async function dailySources(prisma, since, until) {
  try { execFileSync('git', ['pull', '--ff-only'], { cwd: WEBSITE_REPO, stdio: 'ignore', timeout: 30000 }); } catch {}
  const range = { gte: new Date(since), lte: new Date(until) };
  // The team's own routine runs (e.g. AD's daily brief) get a decidedAt too but
  // she never decided them: they are not "ad work she approved".
  // Sources an approved summary already covered are left out entirely.
  const seen = await loggedSources(prisma);
  const decided = (await decidedAdWork(prisma, range)).filter((t) => !seen.has(`task:${t.id}`));
  // Feature cards on product pages are edited in the website's database, often
  // with no commit: the tracker is their record (and the panel's report).
  if (deps.tasakiWebPool) await syncFeatures(prisma, deps.tasakiWebPool).catch(() => {});
  const features = (await featureChangesIn(prisma, since, until)).filter((f) => !seen.has(f.key));
  return {
    features,
    website: gitCommits(WEBSITE_REPO, since, until).filter((c) => !seen.has(`commit:${c.hash}`)),
    dashboard: gitCommits(ROOT, since, until).filter((c) => !seen.has(`commit:${c.hash}`)),
    adWork: decided.map((t) => ({
      when: t.decidedAt, agent: AGENTS[t.agent]?.name || t.agent, outcome: t.status === 'done' ? 'หนิงอนุมัติ' : t.status === 'rejected' ? 'หนิงปัดตก' : t.status,
      kind: t.agent === 'image' && t.result?.stage === 'planned' ? 'แผนก่อนเจนภาพ (ยังไม่ได้เจนภาพ)' : t.agent === 'image' ? 'ภาพแอด' : t.agent,
      asked: (t.prompt || '').slice(0, 300), reason: t.result?.rejectReason || '',
      summary: String(t.result?.summary || t.result?.reviewNote || t.result?.note || '').slice(0, 900),
      highlights: (t.result?.highlights || []).slice(0, 5), suggestions: (t.result?.suggestions || []).slice(0, 5),
      picks: (t.result?.decisions || []).map((d) => `${d.picked ? 'เลือก' : 'ไม่เลือก'}: ${d.title}${d.reason ? ` (${d.reason})` : ''}`),
    })),
    logged: {
      website: (await prisma.websiteChangelog.findMany({ where: { date: range } })).map((r) => r.text),
      system: (await prisma.marketingChangelog.findMany({ where: { date: range } })).map((r) => r.text),
      ads: (await prisma.adActionLog.findMany({ where: { createdAt: range } })).map((r) => r.text),
    },
  };
}

// A message she typed to WEB (not the schedule's own prompt) is something she
// did outside git and wants logged; it dates from when she sent it.
function manualNote(task) {
  const p = String(task.prompt || '').trim();
  return p && !/^สรุปสิ่งที่ทำ/.test(p) && !/อัตโนมัติ/.test(p) ? { text: p, when: new Date(task.input?.noteAt || task.createdAt).toISOString() } : null;
}

async function dailyPrompt(task, prisma) {
  const { since, until } = task.input;
  const src = await dailySources(prisma, since, until);
  const fmt = (list) => list.map((c) => `[${c.date}] ${c.subject}${c.body ? `\n${c.body.slice(0, 1200)}` : ''}${c.body.length < 60 && c.files.length ? `\n(ข้อความ commit สั้น ดูจากไฟล์ที่แก้: ${c.files.join(', ')})` : ''}`).join('\n\n') || '(ไม่มี)';
  return `${BRAND_NOTE}

หน้าที่: สรุป "สิ่งที่หนิงทำ" ช่วง ${since} ถึง ${until} ลง 3 บันทึกของแดชบอร์ด เป็นภาษาไทยง่ายๆ ที่คนไม่ใช่สายเทคนิคอ่านเข้าใจ
กฎ:
- แยกรายการตามเรื่อง เรื่องละ 1 รายการ (รวมหลาย commit เรื่องเดียวกันเป็นรายการเดียว) ห้ามใส่ชื่อไฟล์หรือศัพท์โปรแกรม บอกผลที่เห็นได้จริง
- date ต้องเป็นเวลาจริงจากแหล่งข้อมูล (commit หรือเวลาที่หนิงตัดสินใจ) รูปแบบ ISO มี +07:00 ห้ามใช้เวลาปัจจุบันแทน
- ห้ามซ้ำกับรายการที่ลงไว้แล้ว (ด้านล่าง) ถ้าเรื่องไหนลงแล้วให้ข้าม ถ้าไม่มีอะไรใหม่เลยให้ entries ว่าง
- ห้ามแต่งเรื่องที่ไม่มีในข้อมูล เหตุผลที่หนิงปัดตกให้ใช้เฉพาะช่อง reason ถ้าว่างให้ไม่ต้องเล่าเหตุผล และให้เรียกงานตามช่อง kind (แผนไม่ใช่ภาพ)
- commit ที่ข้อความสั้น (เช่น "AI TEAM") ให้ดูจากรายชื่อไฟล์ที่แก้ว่าเปลี่ยนหน้าไหนของแดชบอร์ด แล้วสรุปเป็นผลที่เห็นได้
- Feature หน้าสินค้า (ข้อ 1.1) ระบบลงเป็นรายการรวมรายวันในโซนรวมอัพเดทให้เองแล้ว ห้ามเขียนรายการแยกเรื่อง feature ซ้ำ ใช้ข้อ 1.1 แค่เพื่อบอกชื่อรุ่นให้ถูกเมื่อ commit เว็บพูดถึงภาพ/งานของรุ่นนั้น ห้ามเขียนรวมๆ ว่า "แอร์กลุ่ม..."
section:
- "website" = งานบนเว็บ Tasaki (จาก commit ของเว็บ) method = ""
- "system" = ฟีเจอร์หรือการแก้ของแดชบอร์ดการตลาด (จาก commit ของแดชบอร์ด) ขึ้นต้นด้วยชื่อหน้า เช่น "หน้า 🧑‍💼 ทีม AI: ..." method = ""
- "ads" = งานโฆษณา: ผลที่ดึงมาดู การตัดสินใจ ไอเดียที่เลือก/ไม่เลือก ครีเอทีฟที่ทำ ใส่ตัวเลขสำคัญ method = "ตัดสินใจ" ถ้าเป็นการตัดสินใจ ไม่งั้น "ทีม AI (ชื่อ Agent)"
  · งานที่หนิงอนุมัติต้องมีครบทุกชิ้น ห้ามตกหล่น (เช่น สรุปผลโฆษณา ใส่ยอดเงินและตัวเลขหลัก)
  · ร่างภาพ/คลิปที่หนิงปัดตก คือการฝึกทีม ให้รวมเป็นรายการเดียวต่อวัน สั้นๆ ว่าลองอะไรไปกี่ชิ้นและติดเรื่องหลักอะไร ห้ามแยกทีละชิ้น

1) commit ของเว็บ Tasaki:
${fmt(src.website)}

1.1) Feature (จุดเด่น) ในหน้าสินค้าที่เพิ่ม/แก้ช่วงนี้ แยกตามรุ่น (ข้อมูลอ้างอิงชื่อรุ่นเท่านั้น ระบบลงให้เองแล้ว):
${src.features.length ? src.features.map((f) => `[${f.date}] ${f.model} (${f.type}): ${f.cards.map((c) => `${c.kind} “${c.title}”`).join(', ')}`).join('\n') : '(ไม่มี)'}

2) commit ของแดชบอร์ดการตลาด:
${fmt(src.dashboard)}

3) งานโฆษณาที่ทีม AI ทำและหนิงตัดสินใจแล้ว:
${src.adWork.length ? JSON.stringify(src.adWork, null, 1) : '(ไม่มี)'}

รายการที่ลงไว้แล้วในช่วงนี้ (ห้ามซ้ำ):
${JSON.stringify(src.logged, null, 1)}
${manualNote(task) ? `
4) สิ่งที่หนิงบอกเองในแชท (งานที่หนิงทำนอกระบบ ต้องลงบันทึกตามหมวดที่เหมาะ ห้ามตอบว่าไม่มีอะไรใหม่ ตัดคำถามท้ายข้อความออก เขียนเป็นข้อเท็จจริงสั้นๆ ว่าทำอะไรและสถานะตอนนี้ เช่น ผลงานที่เคยทำบนเว็บ = section website; date = ${manualNote(task).when}):
${manualNote(task).text}` : ''}`;
}

// After the small model writes, a script checks what can be checked exactly,
// then Claude Opus reviews the rest before it reaches her.
function similar(a, b) {
  const grams = (t) => { const x = String(t).replace(/\s+/g, ''); const g = new Set(); for (let i = 0; i < x.length - 2; i++) g.add(x.slice(i, i + 3)); return g; };
  const A = grams(a); const B = grams(b);
  if (!A.size || !B.size) return 0;
  let both = 0;
  for (const g of A) if (B.has(g)) both += 1;
  return both / (A.size + B.size - both);
}

const JARGON = /\b[\w-]+\.(js|mjs|ts|tsx|json|css|html|prisma)\b|\bcommit\b|\bendpoint\b|\brefactor\b|\bPR\b/i;

async function verifyDaily(result, task, prisma) {
  const { since, until } = task.input;
  const src = await dailySources(prisma, since, until);
  const times = {
    website: src.website.map((c) => new Date(c.date).getTime()),
    system: src.dashboard.map((c) => new Date(c.date).getTime()),
    ads: src.adWork.map((w) => new Date(w.when).getTime()),
  };
  // Her own message counts as a source for any section, dated when she sent it.
  const note = manualNote(task);
  if (note) for (const k of Object.keys(times)) times[k].push(new Date(note.when).getTime());
  const notes = [];
  const kept = [];
  const short = (t) => `“${String(t).slice(0, 40)}…”`;
  for (const e of result.entries || []) {
    const section = ['website', 'system', 'ads'].includes(e.section) ? e.section : null;
    const text = String(e.text || '').trim();
    if (!section || !text) { notes.push('ตัดรายการที่ว่างหรือไม่มีหมวด'); continue; }
    if (!times[section].length) { notes.push(`ตัด ${short(text)} เพราะไม่มีข้อมูลต้นทางของหมวดนี้ (แต่งขึ้นเอง)`); continue; }
    if (src.logged[section].some((x) => similar(x, text) > 0.5) || kept.some((k) => k.section === section && similar(k.text, text) > 0.6)) {
      notes.push(`ตัด ${short(text)} เพราะซ้ำกับที่ลงไว้แล้ว`); continue;
    }
    // The time must be a real source time: snap to the nearest one.
    const t = new Date(e.date).getTime();
    const nearest = [...times[section]].sort((a, b) => Math.abs(a - t) - Math.abs(b - t))[0];
    if (Number.isNaN(t) || Math.abs(nearest - t) > 60 * 1000) notes.push(`แก้เวลา ${short(text)} ให้ตรงกับเวลาจริงของงาน`);
    kept.push({ section, text, date: new Date(nearest).toISOString(), method: section === 'ads' ? String(e.method || 'ทีม AI') : '', jargon: JARGON.test(text) });
  }
  // Every piece of ad work she approved must be in the log.
  const missing = src.adWork.filter((w) => w.outcome === 'หนิงอนุมัติ'
    && !kept.some((k) => k.section === 'ads' && Math.abs(new Date(k.date).getTime() - new Date(w.when).getTime()) < 60 * 1000)
    && !src.logged.ads.some((x) => similar(x, `${w.asked} ${w.summary}`) > 0.3));
  // A window with commits but no entry for them (and nothing similar already
  // logged) is a miss, not a quiet day.
  const missingCommits = [];
  for (const [section, list] of [['website', src.website], ['system', src.dashboard]]) {
    if (kept.some((k) => k.section === section)) continue;
    for (const c of list) {
      const text = `${c.subject} ${c.body} ${c.files.join(' ')}`;
      if (!src.logged[section].some((x) => similar(x, text) > 0.2)) missingCommits.push({ section, when: c.date, subject: c.subject, body: c.body.slice(0, 600), files: c.files });
    }
  }
  if (!kept.length && !missing.length && !missingCommits.length) return { entries: [], review: notes.join(' · ') || 'ไม่มีอะไรใหม่' };

  const reviewer = {
    speaker: 'website', rulesAgent: 'website', model: 'opus', tools: [],
    schema: { type: 'object', properties: {
      items: { type: 'array', items: { type: 'object', properties: { index: { type: 'number' }, verdict: { type: 'string', enum: ['ok', 'fix', 'drop'] }, text: { type: 'string' }, why: { type: 'string' } }, required: ['index', 'verdict', 'text', 'why'] } },
      add: { type: 'array', items: { type: 'object', properties: { section: { type: 'string', enum: ['website', 'system', 'ads'] }, when: { type: 'string' }, text: { type: 'string' }, method: { type: 'string' } }, required: ['section', 'when', 'text', 'method'] } },
    }, required: ['items', 'add'] },
    async buildPrompt() {
      return `คุณคือผู้ตรวจทาน (Claude) งานที่โมเดลเล็กเขียนบันทึก "สิ่งที่หนิงทำ" ไว้ ตรวจทุกรายการเทียบกับข้อมูลจริงด้านล่าง
ตรวจ: (1) ตรงกับข้อมูลจริง ไม่แต่งเพิ่ม ตัวเลขถูก (2) อยู่หมวดถูก (website = เว็บ Tasaki, system = แดชบอร์ดการตลาด, ads = งานโฆษณา) (3) ภาษาไทยง่าย คนไม่ใช่สายเทคนิคอ่านเข้าใจ ไม่มีชื่อไฟล์หรือศัพท์โปรแกรม (4) หนึ่งรายการหนึ่งเรื่อง
verdict: ok = ใช้ได้ (text ใส่ข้อความเดิม), fix = แก้แล้วดีขึ้น (text ใส่ข้อความที่แก้), drop = ตัดทิ้งเพราะผิดหรือแต่ง (why บอกเหตุผล)
แก้เท่าที่จำเป็น อย่าเขียนใหม่ทั้งหมดถ้าใช้ได้แล้ว
ร่างภาพ/คลิปที่หนิงปัดตกเป็นแค่การฝึกทีม ถ้ามีหลายรายการแยกกัน ให้ fix รายการแรกเป็นสรุปรวมรายการเดียว แล้ว drop ที่เหลือ
add: เขียนรายการสำหรับสิ่งที่ตกหล่น (รายการด้านล่าง) section ให้ตรงหมวด (ads = งานโฆษณาที่หนิงอนุมัติ, system = commit ของแดชบอร์ด, website = commit ของเว็บ) when = เวลา when ของสิ่งนั้นตรงตัว method = "ทีม AI (ชื่อ Agent)" สำหรับ ads นอกนั้น "" ถ้าไม่มีให้ add ว่าง
commit ที่ตกหล่น (ดูจากไฟล์ที่แก้ว่าเปลี่ยนอะไรจริง): ${missingCommits.length ? JSON.stringify(missingCommits) : '(ไม่มี)'}
งานที่อนุมัติแต่ตกหล่น: ${missing.length ? JSON.stringify(missing) : '(ไม่มี)'}

รายการที่ต้องตรวจ:
${kept.map((k, i) => `${i}. [${k.section}] ${k.text}${k.jargon ? '  (สคริปต์เจอศัพท์เทคนิค)' : ''}`).join('\n')}

ข้อมูลจริง:
(ชื่อ commit สั้นหรือรวมหลายเรื่อง ให้ดูรายชื่อไฟล์ที่แก้เป็นหลักฐานว่าหน้าไหนเปลี่ยนจริง ห้ามตัดรายการเพียงเพราะชื่อ commit ไม่ได้พูดถึง)
ข้อความที่หนิงบอกเองในแชท (เป็นหลักฐานได้ ถือเป็นข้อเท็จจริงที่หนิงยืนยันเอง ห้ามตัดเพราะ "ไม่มีใน git"): ${note ? JSON.stringify(note.text) : '(ไม่มี)'}
commit เว็บ: ${JSON.stringify(src.website.map((c) => `${c.subject}\nไฟล์ที่แก้: ${c.files.join(', ')}`))}
Feature หน้าสินค้าที่เปลี่ยน (ระบบลงรายการรวมรายวันให้เองแล้ว: รายการที่เล่าแค่เรื่อง feature ซ้ำให้ drop ใช้ข้อมูลนี้ตรวจชื่อรุ่นเท่านั้น): ${JSON.stringify(src.features.map((f) => ({ model: f.model, when: f.date, cards: f.cards })))}
commit แดชบอร์ด: ${JSON.stringify(src.dashboard.map((c) => `${c.subject}\n${c.body.slice(0, 1500)}\nไฟล์ที่แก้: ${c.files.join(', ')}`))}
งานโฆษณา: ${JSON.stringify(src.adWork)}`;
    },
  };
  let reviewed = kept;
  try {
    const { result: r } = await runLanguageAgent(reviewer, { ...task, sessionId: null, feedback: '', input: { ...task.input, attachments: [] } }, prisma, deps);
    const byIndex = new Map((r.items || []).map((x) => [Number(x.index), x]));
    reviewed = [];
    kept.forEach((k, i) => {
      const v = byIndex.get(i);
      if (v?.verdict === 'drop') { notes.push(`ผู้ตรวจทานตัด ${short(k.text)}: ${v.why}`); return; }
      if (v?.verdict === 'fix' && v.text.trim()) { notes.push(`ผู้ตรวจทานแก้ ${short(k.text)}`); reviewed.push({ ...k, text: v.text.trim() }); return; }
      reviewed.push(k);
    });
    for (const a of r.add || []) {
      const when = new Date(a.when).getTime();
      if (!a.text.trim()) continue;
      const near = (t) => Math.abs(new Date(t).getTime() - when) < 60 * 1000;
      if (a.section === 'ads') {
        const match = missing.find((w) => near(w.when));
        if (!match) continue;
        reviewed.push({ section: 'ads', text: a.text.trim(), date: new Date(match.when).toISOString(), method: a.method || `ทีม AI (${match.agent})` });
        notes.push(`ผู้ตรวจทานเติมงานที่ตกหล่น: ${match.agent}`);
      } else {
        const match = missingCommits.find((c) => c.section === a.section && near(c.when));
        if (!match) continue;
        reviewed.push({ section: a.section, text: a.text.trim(), date: new Date(match.when).toISOString(), method: '' });
        notes.push(`ผู้ตรวจทานเติม commit ที่ตกหล่น: ${match.subject.slice(0, 40)}`);
      }
    }
  } catch (e) {
    notes.push(`ตรวจทานด้วย Opus ไม่สำเร็จ (${e.message.slice(0, 80)}) ใช้ผลที่สคริปต์ตรวจแล้ว`);
  }
  return { entries: reviewed.map(({ jargon, ...k }) => k), review: notes.length ? notes.join(' · ') : 'ตรวจแล้ว ใช้ได้ทุกรายการ' };
}


// ─── AD's routine: a short ad brief on its own clock ─────────────────────────
// Script: reads the ad table, works out yesterday vs the week before, flags
// what changed. Small model: only turns those facts into plain Thai. Script
// again: every number in the text must be one of the facts, or the script's
// own plain wording is used instead. No data / nothing new = quiet (no post).
const AD_CPC_LIMIT = 10; // her review line (฿ per click), 2026-10-12 plan

async function adFacts(prisma) {
  const since = new Date(Date.now() - 12 * 86400000);
  const dayOf = (r) => r.date.toISOString().slice(0, 10);
  const today = bangkokNow().date;
  // The hourly sync also stores today's partial numbers; the daily review
  // compares complete days only.
  const rows = (await prisma.adInsight.findMany({ where: { date: { gte: since } }, orderBy: { date: 'asc' } })).filter((r) => dayOf(r) < today);
  const latest = rows.length ? dayOf(rows[rows.length - 1]) : null;
  const ageDays = latest ? Math.round((new Date(`${today}T00:00:00Z`) - new Date(`${latest}T00:00:00Z`)) / 86400000) : null;
  if (!latest || ageDays > 3) return { status: 'no_data', today, latest, ageDays, ads: [], flags: [], totals: null };
  const prior = (d) => rows.filter((r) => dayOf(r) < latest && dayOf(r) >= new Date(new Date(`${latest}T00:00:00Z`) - 7 * 86400000).toISOString().slice(0, 10) && r.adId === d);
  const adIds = [...new Set(rows.filter((r) => dayOf(r) === latest).map((r) => r.adId).concat(rows.map((r) => r.adId)))];
  const ads = [];
  const flags = [];
  for (const id of adIds) {
    const last = rows.filter((r) => r.adId === id && dayOf(r) === latest);
    const prev = prior(id);
    const name = (last[0] || prev[0] || rows.find((r) => r.adId === id)).creativeName || id;
    const camp = (last[0] || prev[0] || rows.find((r) => r.adId === id)).campaignName;
    const sum = (list, k) => list.reduce((a, r) => a + r[k], 0);
    const y = { spend: sum(last, 'spend'), clicks: sum(last, 'clicks'), impressions: sum(last, 'impressions') };
    const w = { spend: sum(prev, 'spend'), clicks: sum(prev, 'clicks'), days: new Set(prev.map(dayOf)).size };
    const ycpc = y.clicks ? y.spend / y.clicks : null;
    const wcpc = w.clicks ? w.spend / w.clicks : null;
    const wavg = w.days ? w.spend / w.days : 0;
    const row = { name, campaign: camp, yesterdaySpend: +y.spend.toFixed(2), yesterdayClicks: y.clicks, yesterdayCpc: ycpc ? +ycpc.toFixed(2) : null, priorAvgDailySpend: +wavg.toFixed(2), priorCpc: wcpc ? +wcpc.toFixed(2) : null };
    ads.push(row);
    if (wavg > 0 && y.spend === 0) flags.push({ ad: name, flag: 'หยุดใช้งบ', detail: `ปกติใช้วันละราว ฿${wavg.toFixed(2)} แต่วันล่าสุดไม่ใช้เลย` });
    if (ycpc && wcpc && y.clicks >= 5 && ycpc > wcpc * 1.25) flags.push({ ad: name, flag: 'ค่าคลิกพุ่ง', detail: `ค่าคลิก ฿${ycpc.toFixed(2)} สูงกว่าช่วง 7 วันก่อนหน้า (฿${wcpc.toFixed(2)}) เกิน 25%` });
    if (ycpc && ycpc > AD_CPC_LIMIT) flags.push({ ad: name, flag: 'ค่าคลิกเกินเกณฑ์', detail: `ค่าคลิก ฿${ycpc.toFixed(2)} เกินเกณฑ์ ฿${AD_CPC_LIMIT} ที่ตั้งไว้ให้ทบทวน` });
    if (!prev.length && y.spend > 0) flags.push({ ad: name, flag: 'แอดใหม่', detail: `เพิ่งเริ่มวิ่ง ใช้ ฿${y.spend.toFixed(2)} ได้ ${y.clicks} คลิก` });
  }
  const totals = { spend: +ads.reduce((a, x) => a + x.yesterdaySpend, 0).toFixed(2), clicks: ads.reduce((a, x) => a + x.yesterdayClicks, 0) };
  return { status: totals.spend > 0 ? 'ok' : 'idle', today, latest, ageDays, ads: ads.filter((a) => a.yesterdaySpend > 0 || a.priorAvgDailySpend > 0), flags, totals };
}

// The script's own plain wording: used when the model's text fails the check.
function adPlainText(f) {
  if (f.status === 'no_data') return f.latest ? `ข้อมูลโฆษณาในระบบล่าสุดคือวันที่ ${f.latest} (ระบบอาจยังดึงข้อมูลไม่ถึง ให้เช็กสถานะแคมเปญจริงใน Ads Manager)` : 'ยังไม่มีข้อมูลโฆษณาในระบบ';
  const lines = [`ข้อมูลวันที่ ${f.latest}: ใช้เงินรวม ฿${f.totals.spend.toFixed(2)} ได้ ${f.totals.clicks} คลิก`];
  for (const x of f.flags) lines.push(`• ${x.ad}: ${x.flag} — ${x.detail}`);
  return lines.join('\n');
}

// Every number of 10 or more in the text must be one of the facts (or a date).
function adNumbersOk(text, f) {
  const facts = JSON.stringify(f).match(/\d+(?:\.\d+)?/g) || [];
  const allowed = facts.map(Number);
  const clean = String(text).replace(/\d{1,4}[-/]\d{1,2}[-/]\d{1,4}/g, '').replace(/\d{1,2}\s*(ต\.ค\.|ตุลาคม|พ\.ย\.|ก\.ย\.)/g, '');
  const used = (clean.replace(/,/g, '').match(/\d+(?:\.\d+)?/g) || []).map(Number).filter((n) => n >= 10);
  const bad = used.filter((n) => !allowed.some((a) => Math.abs(a - n) <= Math.max(0.5, a * 0.005)));
  return { ok: bad.length === 0, bad };
}

async function runAdDaily(task, prisma) {
  const f = await adFacts(prisma);
  const sig = JSON.stringify({ s: f.status, l: f.latest, t: f.totals && Math.round(f.totals.spend), fl: f.flags.map((x) => `${x.ad}:${x.flag}`) });
  const row = await prisma.agentSetting.findUnique({ where: { agent: '__ad_daily_sig' } });
  if (row?.rules === sig && !task.input?.force) return { result: { mode: 'daily', quiet: true, facts: f, review: 'ไม่มีอะไรเปลี่ยนจากรอบก่อน ไม่แจ้งซ้ำ' }, sessionId: null };
  let text = adPlainText(f);
  let review = 'ใช้ข้อความจากสคริปต์';
  if (f.status !== 'no_data') {
    const writer = {
      speaker: 'ads', rulesAgent: 'ads', tools: [], model: 'haiku',
      schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      async buildPrompt() {
        return `${BRAND_NOTE}

หน้าที่: เขียนสรุปผลโฆษณาประจำวันสั้นๆ 3–5 บรรทัด ภาษาไทยง่ายๆ ให้คนไม่ใช่สายตัวเลขอ่านเข้าใจ จากข้อมูลด้านล่างเท่านั้น
- ใช้ตัวเลขที่อยู่ในข้อมูลเท่านั้น ห้ามคำนวณหรือประมาณตัวเลขใหม่ ห้ามแต่งสาเหตุ ถ้าไม่รู้ให้บอกว่ายังไม่รู้
- ขึ้นต้นด้วยภาพรวมของวัน แล้วเล่าเรื่องที่ script ติดธง (flags) ถ้ามี จบด้วยข้อเสนอ 1 ข้อที่ทำตามได้ทันที
- ไม่ต้องใส่ชื่อฟิลด์หรือศัพท์เทคนิค

ข้อมูล (script คำนวณให้แล้ว):
${JSON.stringify(f, null, 1)}`;
      },
    };
    try {
      const { result } = await runLanguageAgent(writer, { ...task, sessionId: null, feedback: '' }, prisma, deps);
      const chk = adNumbersOk(result.text, f);
      if (chk.ok && String(result.text).trim()) { text = String(result.text).trim(); review = 'ตัวเลขทุกตัวตรงกับข้อมูลจริง'; }
      else review = `ข้อความที่โมเดลเขียนมีตัวเลขที่ไม่อยู่ในข้อมูล (${chk.bad.join(', ') || 'ว่าง'}) จึงใช้ข้อความจากสคริปต์แทน`;
    } catch (e) { review = `โมเดลเขียนไม่สำเร็จ (${e.message.slice(0, 60)}) ใช้ข้อความจากสคริปต์`; }
  }
  await prisma.agentSetting.upsert({ where: { agent: '__ad_daily_sig' }, create: { agent: '__ad_daily_sig', rules: sig }, update: { rules: sig } });
  return { result: { mode: 'daily', text, facts: f, review, flagged: f.flags.length > 0 }, sessionId: null };
}

// Flags are worth a line in the Ads log; a normal day only goes to the chat.
async function postAdDaily(result, prisma, invalidateCache) {
  if (result.quiet || !result.flagged) return '';
  await prisma.adActionLog.create({ data: { id: crypto.randomUUID(), text: `แจ้งเตือนอัตโนมัติ (ข้อมูลวันที่ ${result.facts.latest}): ${result.facts.flags.map((x) => `${x.ad} — ${x.flag}: ${x.detail}`).join(' · ')}`.slice(0, 1500), method: 'ทีม AI (AD) · อัตโนมัติ' } });
  invalidateCache?.('ad-action-log');
  return 'ลงบันทึกหน้า Ads 1 รายการ';
}

// ส่อง's own clock: Mondays 09:00, once per day.
const RIVAL_KEY = '__rival_last';
async function scheduleRival(prisma) {
  const now = bangkokNow();
  if (now.weekday !== 1) return;
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
  if (hm < '09:00') return;
  const row = await prisma.agentSetting.findUnique({ where: { agent: RIVAL_KEY } });
  if (row?.rules === now.date) return;
  await prisma.agentSetting.upsert({ where: { agent: RIVAL_KEY }, create: { agent: RIVAL_KEY, rules: now.date }, update: { rules: now.date } });
  const task = await prisma.agentTask.create({ data: { agent: 'rival', prompt: '', input: { mode: 'weekly' } } });
  await logEvent(prisma, 'rival', 'ถึงเวลา 09:00 วันจันทร์ เริ่มส่องคู่แข่งประจำสัปดาห์', task.id);
}

const AD_SLOT = '08:10';
const AD_DAILY_KEY = '__daily_ad_last';
async function scheduleAdDaily(prisma) {
  const now = bangkokNow();
  if (!isWorkDay(now)) return;
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
  if (hm < AD_SLOT) return;
  const row = await prisma.agentSetting.findUnique({ where: { agent: AD_DAILY_KEY } });
  if (row?.rules === now.date) return;
  await prisma.agentSetting.upsert({ where: { agent: AD_DAILY_KEY }, create: { agent: AD_DAILY_KEY, rules: now.date }, update: { rules: now.date } });
  const task = await prisma.agentTask.create({ data: { agent: 'ads', prompt: 'สรุปผลโฆษณาประจำวัน (อัตโนมัติ)', input: { mode: 'daily' } } });
  await logEvent(prisma, 'ads', `ถึงเวลา ${AD_SLOT} เตรียมสรุปผลโฆษณาประจำวัน`, task.id);
}

// Links page videos posted since she started (2026-06-24) to the card whose
// caption matches the video description. Skips duplicate posts of a video that
// is already linked. With no caption match it guesses by publish date.
const VIDEO_LINK_FROM = new Date('2026-06-24T00:00:00+07:00');
const captionKey = (s) => String(s || '').replace(/\s+/g, '').slice(0, 40);
export async function linkNewVideos(prisma) {
  const cards = await prisma.card.findMany({ select: { id: true, title: true, caption: true, linkedVideoId: true, publishedAt: true } });
  const videos = await prisma.pageVideoInsight.findMany({ where: { createdTime: { gte: VIDEO_LINK_FROM } }, select: { videoId: true, description: true, length: true, createdTime: true } });
  const linked = new Set(cards.map((c) => c.linkedVideoId).filter(Boolean));
  const linkedVideos = videos.filter((v) => linked.has(v.videoId));
  const done = [];
  for (const v of videos) {
    if (linked.has(v.videoId)) continue;
    const key = captionKey(v.description);
    if (!key) continue;
    if (linkedVideos.some((o) => captionKey(o.description) === key && Math.abs((o.length || 0) - (v.length || 0)) < 0.5)) continue;
    const hits = cards.filter((c) => !c.linkedVideoId && captionKey(c.caption) === key);
    let hit = hits.length === 1 ? hits[0] : null;
    if (!hits.length) {
      // No caption match: guess by date, the card published nearest the post (within a day).
      const near = cards.filter((c) => !c.linkedVideoId && c.publishedAt)
        .map((c) => ({ c, gap: Math.abs(new Date(c.publishedAt) - new Date(v.createdTime)) }))
        .filter((x) => x.gap <= 36 * 3600 * 1000).sort((a, b) => a.gap - b.gap);
      if (near.length && (near.length === 1 || near[1].gap > near[0].gap)) hit = near[0].c;
    }
    if (!hit) continue;
    hits.length = 0; hits.push(hit);
    await prisma.card.update({ where: { id: hits[0].id }, data: { linkedVideoId: v.videoId } });
    hits[0].linkedVideoId = v.videoId;
    done.push(hits[0].title);
  }
  return done;
}

// WEB's own clock: on work days at these times it drafts "what I've done"
// since its last run. The draft waits for her approval like any other job.
const DAILY_SLOTS = ['12:00', '16:55'];
const DAILY_KEY = '__daily_last';
async function scheduleDaily(prisma) {
  const now = bangkokNow();
  if (!isWorkDay(now)) return;
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
  const slot = [...DAILY_SLOTS].reverse().find((s) => hm >= s);
  if (!slot) return;
  const key = `${now.date} ${slot}`;
  const row = await prisma.agentSetting.findUnique({ where: { agent: DAILY_KEY } });
  let last = {};
  try { last = JSON.parse(row?.rules || '{}'); } catch {}
  if (last.slot && last.slot >= key) return;
  const until = new Date().toISOString();
  const since = last.until || new Date(`${now.date}T00:00:00+07:00`).toISOString();
  const rules = JSON.stringify({ slot: key, until });
  await prisma.agentSetting.upsert({ where: { agent: DAILY_KEY }, create: { agent: DAILY_KEY, rules }, update: { rules } });
  try {
    const linkedNow = await linkNewVideos(prisma);
    if (linkedNow.length) await logEvent(prisma, 'website', `ผูกคลิปกับการ์ดให้แล้ว: ${linkedNow.join(', ')}`);
  } catch { /* linking is best effort */ }
  const task = await prisma.agentTask.create({ data: { agent: 'website', prompt: `สรุปสิ่งที่ทำ (อัตโนมัติ ${slot})`, input: { mode: 'daily', since, until } } });
  await logEvent(prisma, 'website', `ถึงเวลา ${slot} เตรียมสรุปสิ่งที่ทำตั้งแต่ ${new Date(since).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })}`, task.id);
}

// When she approves a catalog check, the fixed PDF (if the draft made one)
// replaces the catalog on the website. Guards: nothing else may remain in the
// file, and the site's file must still be the one the draft was made from.
async function uploadApprovedCatalog(task, { prisma, tasakiWebPool, logEvent: log }) {
  const fix = task.result?.fix;
  if (!fix?.localFile) return null;
  if (task.result?.uploaded) return { url: task.result.uploaded.url, models: task.result.uploaded.models, already: true };
  if (fix.remaining?.length) throw new Error(`ในไฟล์ยังเหลือชื่อแบรนด์อื่น (${fix.remaining.map((x) => x.term).join(', ')}) แก้ให้หมดก่อนอัปโหลด`);
  const current = await tasakiWebPool.query('select id, model, "manualUrl" from "Product" where id = any($1) and "deletedAt" is null', [(task.result.products || []).map((p) => p.id)]);
  if (!current.rows.length || current.rows.some((r) => r.manualUrl !== task.result.manualUrl)) throw new Error('Catalog บนเว็บถูกเปลี่ยนไปแล้วหลังแคททำร่างนี้ สั่งแคทตรวจใหม่');
  const out = await uploadFixedCatalog({ file: fix.localFile, products: current.rows });
  // Read it back from the website: no other brand may remain.
  const back = await loadPdf(out.url);
  const left = brandHits(back.text).length + back.meta.length;
  const { uploadError: _drop, ...rest } = task.result;
  await prisma.agentTask.update({ where: { id: task.id }, data: { result: { ...rest, uploaded: { url: out.url, models: out.models, at: new Date().toISOString(), brandLeft: left } } } });
  await log(prisma, 'catalog', `อัปโหลด Catalog ที่แก้แล้วขึ้นเว็บแล้ว (${out.models.join(', ')}) → ${out.url} ${left ? '⚠️ ตรวจกลับแล้วยังเจอชื่อแบรนด์อื่น' : 'ตรวจกลับแล้วไม่เจอชื่อแบรนด์อื่น'}`, task.id);
  return { ...out, brandLeft: left };
}

// Advertiser Page IDs for the Meta Ad Library (brand -> [ids]); she can edit the
// JSON in ส่อง's settings key. Seeded from the pages she verified in August.
const RIVAL_PAGES_KEY = '__rival_meta_pages';
const RIVAL_PAGES_SEED = { 'Eminent': ['301863126507696'], 'Star-Aire': ['192549837777053'], 'Tasaki (เรา)': ['170565466319332'], 'Amena': ['736650896464865'], 'Central Air': ['1966566050117433'], 'Saijo Denki': ['626846100719383'] };
// Official website per brand (brand -> domain), editable in ส่อง's settings key.
// A known domain beats whatever the model finds, so a brand isn't skipped just
// because a search didn't surface its site that week.
const RIVAL_DOMAINS_KEY = '__rival_domains';
const RIVAL_DOMAINS_SEED = { 'Daikin': 'www.daikin.co.th', 'Midea': 'www.midea.com', 'Tasaki (เรา)': 'www.tasaki.co.th' };
async function rivalDomains(prisma) {
  const row = await prisma.agentSetting.findUnique({ where: { agent: RIVAL_DOMAINS_KEY } });
  try { return { ...RIVAL_DOMAINS_SEED, ...JSON.parse(row?.rules || '{}') }; } catch { return RIVAL_DOMAINS_SEED; }
}

async function rivalPages(prisma) {
  const row = await prisma.agentSetting.findUnique({ where: { agent: RIVAL_PAGES_KEY } });
  try { return { ...RIVAL_PAGES_SEED, ...JSON.parse(row?.rules || '{}') }; } catch { return RIVAL_PAGES_SEED; }
}

// A catalog job still waiting for her is closed when แคท starts checking the
// same catalog again (the file or the site changed since): she should only ever
// see the newest draft. Closed as "superseded", not as her rejection, so it
// teaches nothing to the team.
async function closeSupersededCatalogDrafts(prisma, task, group) {
  const ids = new Set(group.products.map((p) => p.id));
  const older = await prisma.agentTask.findMany({ where: { agent: 'catalog', status: { in: ['review', 'failed'] }, id: { not: task.id } } });
  for (const t of older) {
    const same = t.input?.manualUrl === group.manualUrl || (t.input?.productIds || []).some((id) => ids.has(id))
      || (t.result?.products || []).some((p) => ids.has(p.id)) || t.result?.manualUrl === group.manualUrl;
    if (!same) continue;
    await prisma.agentTask.update({ where: { id: t.id }, data: { status: 'rejected', decidedAt: new Date(), result: { ...(t.result || {}), superseded: true, supersededBy: task.id } } });
    await logEvent(prisma, 'catalog', `ปิดงานเดิมที่ค้างตรวจ (${String(t.prompt || '').slice(0, 60)}) เพราะแคทตรวจ Catalog เดียวกันใหม่แล้ว`, t.id);
  }
}

// แคท's morning check: a script (no AI) lists the catalog PDFs that are new or
// replaced since their specs were confirmed, and drafts one job per file it
// hasn't already drafted (a rejected draft isn't re-made until the file
// changes again). At most 3 a day so approvals stay readable.
const CATALOG_SLOT = '08:30';
const CATALOG_DAILY_KEY = '__daily_catalog_last';
const CATALOG_SEEN_KEY = '__catalog_seen';
async function scheduleCatalogDaily(prisma) {
  const now = bangkokNow();
  if (!isWorkDay(now)) return;
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
  if (hm < CATALOG_SLOT) return;
  const row = await prisma.agentSetting.findUnique({ where: { agent: CATALOG_DAILY_KEY } });
  if (row?.rules === now.date) return;
  const seenRow = await prisma.agentSetting.findUnique({ where: { agent: CATALOG_SEEN_KEY } });
  let seen = [];
  try { seen = JSON.parse(seenRow?.rules || '[]'); } catch {}
  const stale = await staleCatalogs(deps.tasakiWebPool);
  // A draft she approved while it still had an open question doesn't mark the
  // file synced, so it would sit stale for ever: look at such a file once more
  // (signature|recheck) instead of skipping it as already seen.
  for (const g of stale) {
    if (!seen.includes(g.signature) || seen.includes(`${g.signature}|recheck`)) continue;
    const lastForFile = await prisma.agentTask.findFirst({ where: { agent: 'catalog', status: 'done', decidedAt: { not: null }, input: { path: ['manualUrl'], equals: g.manualUrl } }, orderBy: { decidedAt: 'desc' }, select: { result: true } }).catch(() => null);
    if ((lastForFile?.result?.structural || []).length) { g.signature = `${g.signature}|recheck`; g.reason = `${g.reason} · ตรวจซ้ำ เพราะร่างที่อนุมัติไปยังมีเรื่องค้าง จึงยังไม่ติ๊กว่าซิงก์แล้ว`; }
  }
  const groups = stale.filter((g) => !seen.includes(g.signature)).slice(0, 3);
  await prisma.agentSetting.upsert({ where: { agent: CATALOG_DAILY_KEY }, create: { agent: CATALOG_DAILY_KEY, rules: now.date }, update: { rules: now.date } });
  if (!groups.length) return;
  const rules = JSON.stringify([...seen, ...groups.map((g) => g.signature)].slice(-200));
  await prisma.agentSetting.upsert({ where: { agent: CATALOG_SEEN_KEY }, create: { agent: CATALOG_SEEN_KEY, rules }, update: { rules } });
  for (const g of groups) {
    const names = g.products.map((p) => p.model).join(', ');
    const task = await prisma.agentTask.create({ data: { agent: 'catalog', prompt: `ตรวจ Catalog: ${names} (${g.reason})`, input: { mode: 'daily', manualUrl: g.manualUrl, productIds: g.products.map((p) => p.id) } } });
    await logEvent(prisma, 'catalog', `เจอ Catalog ที่รอซิงก์: ${names} — ${g.reason}`, task.id);
  }
}

// Text-only brand sweep over every catalog on the website (no AI, no cost):
// 6 files a minute until each URL has been scanned once; a re-uploaded file
// has a new URL, so it is scanned the first time it appears. Hits are said in
// the chat; the AI also looks at the page pictures when a file is drafted.
const CATALOG_BRAND_KEY = '__catalog_brand_seen';
async function sweepCatalogBrands(prisma) {
  if (!isWorkingHours()) return;
  const row = await prisma.agentSetting.findUnique({ where: { agent: CATALOG_BRAND_KEY } });
  let seen = [];
  try { seen = JSON.parse(row?.rules || '[]'); } catch {}
  const todo = (await allCatalogs(deps.tasakiWebPool)).filter((c) => !seen.includes(c.manualUrl)).slice(0, 6);
  if (!todo.length) return;
  const lines = [];
  for (const c of todo) {
    try {
      const scanned = await loadPdf(c.manualUrl);
      const hits = brandHits(scanned.text);
      if (scanned.meta.length) lines.push(`• ${c.models}: ชื่อแบรนด์อื่นซ่อนอยู่ในข้อมูลไฟล์ (${scanned.meta.map((m) => `${m.where} ×${m.count}`).join(', ')})`);
      if (hits.length) lines.push(`• ${c.models}: ${hits.slice(0, 5).map((h) => `${h.term} ×${h.count} (หน้า ${h.pages.slice(0, 5).join(',')})`).join(' · ')}`);
      seen.push(c.manualUrl);
    } catch (e) { console.error('brand sweep:', c.manualUrl, e.message); }
  }
  const rules = JSON.stringify(seen.slice(-1000));
  await prisma.agentSetting.upsert({ where: { agent: CATALOG_BRAND_KEY }, create: { agent: CATALOG_BRAND_KEY, rules }, update: { rules } });
  if (lines.length) await logEvent(prisma, 'catalog', `🏷 พบชื่อ/เว็บของแบรนด์อื่น หรือข้อความตัวอย่าง (Lorem) ใน Catalog (สแกนตัวหนังสือ):\n${lines.join('\n')}`, null, { kind: 'handoff', toAgent: 'you' });
}

// Visible products from tasaki-web's own DB. `image` is the real cut-out photo
// on disk (transparent webp/png) — ads composite it as-is, never redrawn.
let catalogCache = { at: 0, rows: null };
async function productCatalog(tasakiWebPool) {
  if (catalogCache.rows && Date.now() - catalogCache.at < 5 * 60 * 1000) return catalogCache.rows;
  const { rows } = await tasakiWebPool.query(`
    select p.model, p."nameTh", t."nameTh" as type, p.btu, left(coalesce(p.description, ''), 160) as description, p."imageUrl"
    from "Product" p join "ProductType" t on t.id = p."typeId"
    where not p.hidden and p."deletedAt" is null
    order by t.id, p.model`);
  catalogCache = { at: Date.now(), rows: rows.map((r) => {
    const local = r.imageUrl ? path.join(WEBSITE_REPO, 'public', r.imageUrl) : null;
    return {
      model: r.model.trim(),
      nameTh: r.nameTh.trim(),
      type: r.type,
      btu: (r.btu || []).join('/') || '-',
      description: r.description.replace(/\s+/g, ' ').trim(),
      image: local && fs.existsSync(local) ? local : null,
    };
  }) };
  return catalogCache.rows;
}

// Work she threw away, with the reason she typed — fed into that agent's next
// prompt so the same miss isn't repeated.
async function rejectLearnings(prisma, agent, limit = 30) {
  const tasks = await prisma.agentTask.findMany({
    where: { status: 'rejected', ...(agent ? { agent } : {}) }, orderBy: { decidedAt: 'desc' }, take: limit * 2,
  });
  return tasks
    .filter((t) => t.result?.rejectReason)
    .slice(0, limit)
    .map((t) => ({ agent: t.agent, title: t.prompt || t.agent, picked: false, reason: t.result.rejectReason, date: t.decidedAt }));
}

// What she has told an agent to change, in her own words: the commands she
// typed to VEC and every ↻ / chat fix on any job. Kept automatically and fed
// into the agent's next prompts so she doesn't have to say it twice. She can
// make the team forget a line (stored as one hidden setting).
const FORGET_KEY = '__forgotten';
const STOCK_REASONS = new Set(['สินค้าดูไม่เนียน/ลอย', 'ฉากไม่สมจริง', 'สีไม่ตรงแบรนด์', 'รกเกินไป', 'ไม่ตรงโจทย์', 'ไม่มีที่ว่างใส่พาดหัว', 'ข้อมูลไม่ถูก', 'ภาษาแข็ง/ไม่เป็นธรรมชาติ', 'ยาวไป', 'ไม่ตรงแบรนด์']);

async function forgottenKeys(prisma) {
  const row = await prisma.agentSetting.findUnique({ where: { agent: FORGET_KEY } }).catch(() => null);
  try { return new Set(JSON.parse(row?.rules || '[]')); } catch { return new Set(); }
}

async function taughtNotes(prisma, agent, limit = 25) {
  const pipeline = agent === 'layout' || agent === 'image';
  const tasks = await prisma.agentTask.findMany({
    where: { agent: pipeline ? 'image' : agent }, orderBy: { createdAt: 'desc' }, take: 60,
  });
  const forgotten = await forgottenKeys(prisma);
  const seen = new Set();
  const out = [];
  const add = (task, tag, text) => {
    const t = String(text || '').trim().replace(/\s+/g, ' ');
    const key = `${task.id}:${tag}`;
    if (t.length < 14 || STOCK_REASONS.has(t) || forgotten.has(key) || seen.has(t)) return;
    seen.add(t);
    out.push({ key, text: t.slice(0, 400), date: task.createdAt });
  };
  for (const task of tasks) {
    if (['demonstration', 'study'].includes(task.input?.mode)) continue;
    // Newest first, so a repeated line keeps its newest copy.
    if (task.feedback) add(task, 'f', task.feedback);
    [...(task.input?.history || [])].reverse().forEach((h, i, all) => add(task, `h${all.length - 1 - i}`, h));
    if (task.agent === 'assemble') add(task, 'p', task.prompt);
  }
  return out.slice(0, limit).reverse();
}

function teachingNote(items) {
  return items.length
    ? `\nสิ่งที่หนิงเคยสั่งแก้ในงานก่อนๆ (คือความต้องการถาวรของหนิง ทำตามทุกงานถัดไป อย่าให้ต้องบอกซ้ำ ถ้าขัดกับคำสั่งล่าสุดให้ยึดคำสั่งล่าสุด):\n${items.map((i) => `- ${i.text}`).join('\n')}\n`
    : '';
}

// Only her reasons go to the agents, not the old task prompts: the reasons
// are the lesson, and old prompts out of context once tripped Claude's
// safety filter.
function learningNote(items) {
  const reasons = [...new Set(items.flatMap((l) => String(l.reason || '').split(/[,،]/).map((r) => r.trim())).filter(Boolean))];
  return reasons.length
    ? `\nเหตุผลที่หนิงเคยไม่ให้ผ่าน (อย่าพลาดแบบเดิมซ้ำ):\n${reasons.map((r) => `- ${r}`).join('\n')}\n`
    : '';
}

// ─── Her settings per agent ──────────────────────────────────────────────────
// Standing rules she edits in each agent's settings panel. Until she saves
// her own, an agent starts from these defaults.
const DEFAULT_RULES = {};

// "@ทุกคน" rules: one list every agent follows, on top of its own rules.
const TEAM = {
  id: 'all', name: 'ทุกคน', role: 'กฎของทั้งทีม', avatar: '/agent-assets/team.svg', engine: 'team',
  about: 'กฎที่ทุก Agent ต้องทำตาม ถูกส่งไปพร้อมกฎของแต่ละตัวทุกครั้ง (ทั้ง Claude และ Codex) เพิ่มได้จากช่องแชทด้วย @ทุกคน หรือแก้ตรงนี้',
};

async function combinedRules(prisma, agent) {
  const own = await agentRules(prisma, agent);
  if (agent.startsWith('__')) return own;
  const team = await agentRules(prisma, TEAM.id);
  return [team.trim() && `(กฎของทั้งทีม)\n${team.trim()}`, own.trim()].filter(Boolean).join('\n');
}

async function agentRules(prisma, agent) {
  const row = await prisma.agentSetting.findUnique({ where: { agent } }).catch(() => null);
  return row ? row.rules : (DEFAULT_RULES[agent] || '');
}



function rulesNote(rules) {
  return rules.trim() ? `\n\nกฎประจำจากผู้ดูแล: ใช้เป็นค่าเริ่มต้น คำสั่งงานและคำสั่งแก้ล่าสุดของผู้ดูแลมาก่อนกฎเดิมเฉพาะเรื่องที่ระบุ เช่น จำนวนไอเดีย กลุ่มเป้าหมาย และข้อความที่ให้ใช้ รักษากฎส่วนอื่นที่ไม่ขัดกัน ห้ามแต่งข้อเท็จจริงหรือหลักฐาน\n${rules.trim()}\n` : '';
}

// ─── Roster ──────────────────────────────────────────────────────────────────
// engine: which CLI runs it. tools: Claude Code tools it may use (all
// read-only). schema: the JSON it must hand back. onApprove: what the server
// does once the user approves (default: nothing, the draft is the deliverable).
export const AGENTS = {
  ads: {
    name: 'แอด',
    role: 'ฝ่ายโฆษณา',
    about: 'อ่านตัวเลขแอดจากหน้า Ads (ย้อนหลังตามจำนวนวันที่เลือก) กับบันทึกสิ่งที่ทำกับบัญชีโฆษณา แล้วสรุปเป็นภาษาง่ายๆ พร้อมข้อเสนอ ทำเองทุกวันทำงานหลัง 08:10 (หลังระบบดึงตัวเลข 08:00): สคริปต์เทียบเมื่อวานกับ 7 วันก่อนและติดธงสิ่งผิดปกติ โมเดลเล็กเขียนสรุปสั้นๆ สคริปต์ตรวจว่าตัวเลขตรงข้อมูลจริง ไม่มีอะไรเปลี่ยนก็ไม่แจ้งซ้ำ ธงสำคัญลงบันทึกหน้า Ads ให้ด้วย',
    avatar: '/agent-assets/takujung-v2/takujung-ads.png',
    engine: 'claude',
    model: 'sonnet',
    tools: [],
    placeholder: 'เช่น สรุปผลโฆษณา 7 วันล่าสุด ตัวไหนคุ้มสุด ควรปรับอะไร',
    async buildPrompt(task, prisma) {
      const days = Math.min(Math.max(Number(task.input?.days) || 7, 1), 60);
      const since = new Date(Date.now() - days * 86400000);
      const [rows, actions] = await Promise.all([
        prisma.adInsight.findMany({ where: { date: { gte: since } }, orderBy: { date: 'asc' } }),
        prisma.adActionLog.findMany({ orderBy: { createdAt: 'desc' }, take: 10 }),
      ]);
      const today = bangkokNow().date;
      const lines = rows.map((r) => `${fmtDate(r.date)}${r.date.toISOString().slice(0, 10) === today ? ' (วันนี้ ยังไม่จบวัน ห้ามเทียบกับวันเต็ม)' : ''} | ${r.campaignName} | ${r.creativeName || r.adId} | spend ฿${r.spend.toFixed(2)} | reach ${r.reach} | impr ${r.impressions} | clicks ${r.clicks} | CTR ${r.ctr.toFixed(3)}% | CPC ฿${r.cpc.toFixed(2)}`);
      return `${BRAND_NOTE}

หน้าที่: อ่านผลโฆษณา Facebook ของ Tasaki แล้วสรุปให้คนที่ไม่ใช่สายตัวเลขอ่านเข้าใจ บอกว่าอะไรเวิร์ก อะไรไม่เวิร์ก และควรทำอะไรต่อ
ใช้เฉพาะตัวเลขด้านล่างเท่านั้น ถ้าไม่มีข้อมูลช่วงไหนให้บอกว่าไม่มี (เช่น แคมเปญถูกหยุดไว้)

ข้อมูล ${days} วันล่าสุด (วันที่ | แคมเปญ | ชิ้นงาน | ...):
${lines.join('\n') || '(ไม่มีข้อมูลในช่วงนี้)'}

สิ่งที่ทำกับบัญชีโฆษณาล่าสุด:
${actions.map((a) => `- ${fmtDate(a.createdAt)} ${a.text}`).join('\n') || '-'}

คำสั่งงาน: ${task.prompt || 'สรุปผลโฆษณาให้หน่อย'}`;
    },
    schema: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        highlights: { type: 'array', items: { type: 'string' } },
        suggestions: { type: 'array', items: { type: 'string' } },
      },
      required: ['summary', 'highlights', 'suggestions'],
    },
    approveLabel: 'รับทราบ',
  },

  website: {
    name: 'เว็บ',
    role: 'ฝ่ายเว็บไซต์',
    about: 'สรุป "สิ่งที่ทำวันนี้" ลง 3 บันทึก: Tasaki Website Updates (จาก git ของเว็บ บอกชื่อรุ่นให้ถูก และอัปเดต Feature หน้าสินค้า Last Update ที่รวมเป็นรายการรายวันในโซนรวมอัพเดท), 🛠 Marketing System Updates (จาก git ของแดชบอร์ด) และสรุปสิ่งที่ทำไปแล้วในหน้า Ads (จากงานโฆษณาที่ทีมทำและหนิงตัดสินใจ) ภาษาไทยง่ายๆ แยกตามเรื่อง ใช้เวลาจริง ทำเองทุกวันทำงาน 12:00 และ 16:55 สคริปต์ตรวจวันที่และรายการซ้ำ Claude Opus ตรวจทาน แล้วลงบันทึกให้เลยไม่ต้องรออนุมัติ (ทำแม้กดหยุดทีมไว้)',
    avatar: '/agent-assets/takujung-v2/takujung-website.png',
    engine: 'claude',
    model: 'haiku',
    tools: [],
    // Script gathers and checks; Haiku only writes; Opus reviews.
    async verify(result, task, prisma) { return task.input?.mode === 'daily' ? verifyDaily(result, task, prisma) : result; },
    placeholder: 'เช่น สรุปสิ่งที่เปลี่ยนบนเว็บวันนี้ (ใส่วันที่ได้ เช่น 2026-10-16)',
    async buildPrompt(task, prisma) {
      if (task.input?.mode === 'daily') return dailyPrompt(task, prisma);
      const date = /^\d{4}-\d{2}-\d{2}$/.test(task.input?.date || '') ? task.input.date : bangkokNow().date;
      const commits = websiteCommits(date);
      if (!commits.length) throw new Error(`ไม่มีการเปลี่ยนแปลงบนเว็บวันที่ ${date}`);
      return `${BRAND_NOTE}

หน้าที่: แปลงบันทึกการแก้เว็บ Tasaki (ภาษาโปรแกรมเมอร์) เป็นภาษาไทยง่ายๆ ที่คนไม่ใช่สายเทคนิคอ่านเข้าใจ
แบ่งเป็นหัวข้อตามเรื่อง หัวข้อละ 1 รายการ ไม่ต้องใส่ชื่อไฟล์หรือศัพท์โปรแกรม ทุกรายการ section = "website" method = ""
date ของแต่ละรายการต้องเป็นเวลาของ commit จริงจากรายการด้านล่าง (ถ้ารวมหลาย commit ให้ใช้เวลาของ commit ล่าสุดในกลุ่ม) คัดลอกมาตรงๆ

การเปลี่ยนแปลงวันที่ ${date}:
${commits.map((c) => `[${c.date}] ${c.subject}\n${c.body}`).join('\n\n')}

${task.prompt ? `หมายเหตุจากผู้สั่ง: ${task.prompt}` : ''}`;
    },
    schema: {
      type: 'object',
      properties: {
        entries: {
          type: 'array',
          items: { type: 'object', properties: { section: { type: 'string', enum: ['website', 'system', 'ads'] }, text: { type: 'string' }, date: { type: 'string' }, method: { type: 'string' } }, required: ['section', 'text', 'date', 'method'] },
        },
      },
      required: ['entries'],
    },
    approveLabel: 'ลงบันทึก',
    async onApprove(task, body, { prisma, invalidateCache }) {
      // Each entry says which log it belongs to (sent back from the card).
      const entries = Array.isArray(body.entries) ? body.entries : task.result?.entries || [];
      const valid = entries.filter((e) => e && typeof e.text === 'string' && e.text.trim());
      const count = { website: 0, system: 0, ads: 0 };
      // Entry dates are snapped to a source's time, so the source is known. A
      // draft made before another summary was approved can still hold sources
      // that summary logged: those entries are skipped, not posted twice.
      const { since, until } = task.input || {};
      const sources = since && until ? await sourcesIn(prisma, since, until) : [];
      const seen = await loggedSources(prisma);
      let skipped = 0;
      for (const e of valid) {
        const when = new Date(e.date);
        const at = Number.isNaN(when.getTime()) ? null : when;
        const text = e.text.trim();
        const from = at ? sources.filter((s) => s.section === (e.section === 'system' || e.section === 'ads' ? e.section : 'website') && Math.abs(s.t - at.getTime()) < 60 * 1000) : [];
        if (from.length && from.every((s) => seen.has(s.key))) { skipped += 1; continue; }
        if (e.section === 'system') { await prisma.marketingChangelog.create({ data: { text, ...(at ? { date: at } : {}) } }); count.system += 1; }
        else if (e.section === 'ads') { await prisma.adActionLog.create({ data: { id: crypto.randomUUID(), text, method: String(e.method || 'ทีม AI').slice(0, 80), ...(at ? { createdAt: at } : {}) } }); count.ads += 1; }
        else { await prisma.websiteChangelog.create({ data: { text, ...(at ? { date: at } : {}) } }); count.website += 1; }
      }
      // She reviewed this whole window: none of its sources come back next run.
      if (sources.length) await markLogged(prisma, sources.map((s) => s.key));
      invalidateCache('website-changelog');
      invalidateCache('marketing-changelog');
      invalidateCache('ad-action-log');
      return `ลงบันทึกแล้ว: เว็บไซต์ ${count.website} · Marketing System ${count.system} · Ads ${count.ads} รายการ${skipped ? ` (ข้าม ${skipped} รายการที่ลงไว้แล้ว)` : ''}`;
    },
  },

  // Watches the website's catalog PDFs. A script finds the ones that are new
  // or replaced since the specs were last confirmed; this agent only reads a
  // PDF and proposes field changes; a script re-checks each proposal against
  // the PDF text and the live row, and nothing is written until she approves.
  catalog: {
    name: 'แคท',
    role: 'ฝ่ายสเปก Catalog',
    about: 'ตรวจทุกเช้าวันทำงาน (08:30) ว่ามี Catalog PDF ใหม่หรือถูกอัปโหลดทับบนเว็บไหม แล้วอ่านตารางสเปกเทียบกับข้อมูลสเปกบนเว็บ ทำเป็นร่างว่าตัวเลขไหนเปลี่ยนจากเดิมเป็นเท่าไร (พร้อมข้อความที่อ้างจาก PDF) สคริปต์ตรวจซ้ำว่าค่าใหม่มีใน PDF จริง หนิงติ๊กรายการที่ถูกแล้วกดอนุมัติ ระบบถึงจะเขียนลงเว็บ (สำรองค่าเดิมไว้ก่อนเสมอ) แก้ได้เฉพาะค่าในแถวสเปกที่มีอยู่ ถ้าใน PDF มีรุ่นเพิ่ม/หายไปจะแจ้งให้จัดการเอง และดูด้วยว่าใน Catalog มีโลโก้หรือชื่อแบรนด์อื่นตกหล่นอยู่ไหม (สคริปต์สแกนตัวหนังสือ แคทดูโลโก้จากภาพหน้า) ทุกไฟล์ใหม่ที่อัปโหลดจะถูกตรวจอัตโนมัติ',
    avatar: '/agent-assets/takujung-v2/takujung-catalog.png',
    engine: 'claude',
    model: 'opus',
    tools: ['Read'],
    placeholder: 'เว้นว่างไว้ได้ จะตรวจ Catalog ที่ยังไม่ซิงก์ให้ 1 ไฟล์ หรือพิมพ์ชื่อรุ่น',
    async buildPrompt(task, prisma, ctx) {
      const pool = (ctx || deps).tasakiWebPool;
      const groups = await staleCatalogs(pool);
      const wanted = String(task.input?.manualUrl || '');
      const typed = String(task.prompt || '').toLowerCase();
      // The PDF may have been replaced since the job was made (new URL for the
      // same product), so the product is the stable key, not the file path.
      const ids = Array.isArray(task.input?.productIds) ? task.input.productIds : [];
      const group = (wanted && groups.find((g) => g.manualUrl === wanted))
        || (wanted && ids.length === 0 ? await groupByUrl(pool, wanted) : null)
        || groups.find((g) => g.products.some((p) => ids.includes(p.id)))
        || groups.find((g) => typed.length > 2 && g.products.some((p) => typed.includes(String(p.model).toLowerCase())))
        || await groupByModelText(pool, typed)
        || groups[0];
      if (!group) throw new Error('ตอนนี้ไม่มี Catalog ที่รอซิงก์ ทุกไฟล์สเปกตรงกับที่ยืนยันไว้แล้ว');
      await closeSupersededCatalogDrafts(prisma, task, group);
      const pinned = { manualUrl: group.manualUrl, productIds: group.products.map((p) => p.id) };
      task.input = { ...(task.input || {}), ...pinned };
      await prisma.agentTask.update({ where: { id: task.id }, data: { input: task.input } }).catch(() => {});
      const pagesDir = path.join(IMAGES_DIR, 'catalog-pages', task.id);
      fs.rmSync(pagesDir, { recursive: true, force: true });
      const [columns, specs, pdf] = await Promise.all([specColumns(pool), groupSpecs(pool, group.products.map((p) => p.id)), loadPdf(group.manualUrl, { pagesDir })]);
      const text = pdf.text;
      if (text.replace(/\s/g, '').length < 200) throw new Error(UNREADABLE_PDF);
      const rows = specs.map((r) => ({
        specId: r.id, product: r.productModel, unitModel: r.unitModel, btu: r.btu,
        values: Object.fromEntries([...columns.keys()].filter((k) => r[k] !== null && r[k] !== '').map((k) => [k, r[k]])),
      }));
      return `${BRAND_NOTE}

หน้าที่: เทียบตารางสเปกใน Catalog PDF (ข้อความที่ดึงออกมาจากไฟล์) กับแถวสเปกที่อยู่บนเว็บ แล้วรายงานเฉพาะค่าที่ "ต่างกันจริง" ตอบเป็นภาษาไทย (ชื่อฟิลด์และค่าตามเดิม)
สินค้าที่ใช้ไฟล์นี้: ${group.products.map((p) => p.model).join(', ')}
เหตุที่ต้องตรวจ: ${group.reason}

กฎ:
- เทียบทีละแถว (ทีละรุ่นย่อย unitModel) ทีละช่องใน columns ด้านล่างเท่านั้น ช่องที่ PDF ไม่ได้พิมพ์ไว้ให้ข้าม ห้ามเดา ห้ามคำนวณหรือแปลงหน่วยเอง ยกเว้นที่ระบุด้านล่าง
- changes: ใส่เฉพาะช่องที่ค่าใน PDF ต่างจาก oldValue (ค่าบนเว็บตอนนี้ คัดลอกตรงๆ) newValue = ค่าตามที่ PDF พิมพ์ (ตัวเลขล้วนสำหรับช่องตัวเลข ไม่ต้องใส่หน่วยหรือจุลภาค) quote = ข้อความสั้นๆ จาก PDF ที่คัดลอกมาตรงๆ เป็นหลักฐาน
- ขนาด (indoorDimensionMm/outdoorDimensionMm) ในเว็บเรียงเป็น "W x H x D" ถ้า PDF พิมพ์ W/D/H ต้องสลับให้ตรงรูปแบบเว็บ ถ้าเลขชุดเดียวกันแค่เรียงต่างกัน ไม่ถือว่าเปลี่ยน
- ความต่างแค่รูปแบบ (ช่องว่าง จุลภาค ตัวพิมพ์ใหญ่เล็ก ทศนิยมท้าย 0) ไม่ต้องรายงาน
- ชื่อรุ่นย่อย (ช่อง unitModel): ถ้าชื่อใน PDF ต่างจากเว็บแต่จับคู่แถวได้ชัดเจน (รหัสขนาด/ตัวอักษรกลาง น้ำหนัก ระบบไฟ จำนวนพัดลม ท่อน้ำ ตรงกัน และจับคู่ได้ 1 ต่อ 1) ให้เสนอเปลี่ยน unitModel ในแถวนั้นเป็นชื่อตาม PDF ได้เลย ไม่ต้องรอคน ถ้าจับคู่ไม่ได้ชัดหรือมีหลายแถวที่เป็นไปได้ ให้ใส่ structural
- หน่วย: ช่องที่ชื่อลงท้าย W เว็บเก็บเป็นวัตต์ ถ้า PDF พิมพ์เป็น kW ให้คูณ 1000 ให้เอง (เช่น 0.70 kW → newValue 700) และ quote ตัวเลขตามที่ PDF พิมพ์ ถ้าแปลงแล้วเท่าค่าเดิมไม่ต้องรายงาน
- ช่องที่ PDF ไม่ได้พิมพ์ไว้ ห้ามรายงานหรือตั้งคำถามถึงช่องนั้น (เช่น เว็บมีค่าแต่ PDF ไม่มี) ปล่อยไว้ตามเดิม
- รุ่นใน PDF ที่เป็นของสินค้าอื่น (ไม่ใช่สินค้าที่ใช้ไฟล์นี้ตามรายชื่อด้านบน เช่น ไฟล์รวม AW2/CW2) ให้ข้ามเฉยๆ ไม่ต้องรายงาน
- structural: ใส่เฉพาะปัญหาที่ทำเองไม่ได้จริงๆ เช่น PDF มีรุ่นย่อยของสินค้านี้ที่ไม่มีแถวในเว็บ, แถวในเว็บที่ PDF ไม่มีแล้วและจับคู่ไม่ได้, ตารางอ่านไม่ออก/ข้อความเพี้ยน ถ้าไม่มีให้ส่งว่าง
- brandVisual: เปิดดูภาพหน้า Catalog ด้วยเครื่องมือ Read (รายชื่อไฟล์ด้านล่าง) แล้วรายงานโลโก้หรือชื่อแบรนด์ของผู้ผลิตเครื่องปรับอากาศ/เครื่องทำความเย็น (หรือบริษัทแม่ของเขา) ที่ไม่ใช่ Tasaki ที่ยังเหลือในภาพ (เช่น โลโก้บนหน้าปก ท้ายหน้า บนตัวเครื่อง/คอมเพรสเซอร์ในรูป ฉลากบนเครื่อง) ไม่ต้องรายงานป้ายหรือโลโก้ของสถานที่/บริษัทอื่นที่ติดมากับรูปฉากหลัง (เช่น ป้ายบนตึก) หรือโลโก้ลูกค้า ใส่ page (เลขหน้าตามชื่อไฟล์ภาพ p-N), what (สิ่งที่เห็น), rect = กรอบที่ล้อมโลโก้/ชื่อนั้นพอดี เป็นพิกเซล [ซ้าย, บน, ขวา, ล่าง] อ่านจากเส้นกริดสีชมพูที่วาดทุก 100 พิกเซลบนภาพ (ตัวเลขกำกับ x,y ที่มุมช่อง) ตรวจให้แน่ใจว่ากรอบครอบตัวโลโก้จริง ถ้ากะกรอบไม่ได้ ให้ใส่ [] ไม่นับโลโก้ Tasaki, ตรามาตรฐาน (ISO, TISI/มอก., AHRI, Eurovent, CE) และชื่อสารทำความเย็น ถ้าไม่เจอให้ส่งว่าง ห้ามเดา รายงานเฉพาะที่เห็นชัด
- summary: สรุป 1–2 ประโยค ภาษาง่ายๆ ว่าไฟล์นี้เทียบแล้วเป็นอย่างไร (เช่น "สเปกตรงเดิมทุกค่า" หรือ "เปลี่ยน 3 ค่า ใน 2 รุ่น") ตัวเลขต้องมาจากข้อมูลเท่านั้น

columns (ชื่อช่อง: ชนิด): ${JSON.stringify(Object.fromEntries(columns))}

แถวสเปกบนเว็บตอนนี้ (values เฉพาะช่องที่มีค่า):
${JSON.stringify(rows)}

ภาพหน้า Catalog สำหรับตรวจโลโก้ (เปิดด้วย Read ทุกหน้า หน้าละ 1 ไฟล์):
${pdf.images.join('\n') || '(ไม่มีภาพ)'}

ภาพหน้าแบบละเอียด 150 dpi (ไม่มีกริด) ใช้อ่านตาราง ช่องที่รวมเซลล์ สัญลักษณ์/ตรามาตรฐานในแต่ละคอลัมน์ ถ้าข้อความอ่านแล้วไม่ชัดว่าค่าไหนเป็นของรุ่นไหน ให้เปิดภาพนี้ดูก่อน ตอบเองให้ได้ ใส่ structural เฉพาะเมื่อดูภาพนี้แล้วก็ยังตัดสินไม่ได้ (ห้ามอ้างว่า "ภาพความละเอียดต่ำ"):
${(pdf.details || []).join('\n') || '(ไม่มีภาพ)'}

${pdf.ocr ? `หมายเหตุ: ไฟล์นี้ตัวหนังสือถูกแปลงเป็นเส้น (outline) ข้อความด้านล่างจึงได้จาก OCR ภาพหน้า อาจอ่านตัวเลข/ตัวอักษรผิดบางตัว (เช่น 8↔g, 0↔O, 1↔I) ก่อนเสนอค่าใหม่ทุกค่า ให้เปิดภาพหน้าดูยืนยันว่าตัวเลขตรง ถ้าภาพไม่ชัดพอจะยืนยัน อย่าเสนอค่านั้น ให้ใส่ structural แทน และอย่าถือว่าค่าที่ OCR อ่านไม่ออกคือค่าที่หายไป

` : ''}ข้อความจาก Catalog PDF (${group.manualUrl})${pdf.ocr ? ' — จาก OCR' : ''}:
${clipPdfText(text)}`;
    },
    schema: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        changes: { type: 'array', items: { type: 'object', properties: { specId: { type: 'string' }, field: { type: 'string' }, oldValue: { type: 'string' }, newValue: { type: 'string' }, quote: { type: 'string' } }, required: ['specId', 'field', 'oldValue', 'newValue', 'quote'] } },
        structural: { type: 'array', items: { type: 'string' } },
        brandVisual: { type: 'array', items: { type: 'object', properties: { page: { type: 'number' }, what: { type: 'string' }, rect: { type: 'array', items: { type: 'number' } } }, required: ['page', 'what', 'rect'] } },
      },
      required: ['summary', 'changes', 'structural', 'brandVisual'],
    },
    // The script, not the model, decides what is believable.
    async verify(result, task) {
      const pool = deps.tasakiWebPool;
      const groups = await staleCatalogs(pool);
      const group = groups.find((g) => g.manualUrl === task.input?.manualUrl) || (task.input?.manualUrl ? await groupByUrl(pool, task.input.manualUrl) : null);
      if (!group) throw new Error('Catalog ไฟล์นี้ถูกซิงก์หรือเปลี่ยนไปแล้ว สั่งตรวจใหม่');
      const [columns, specs, pdf] = await Promise.all([specColumns(pool), groupSpecs(pool, group.products.map((p) => p.id)), loadPdf(group.manualUrl)]);
      const text = pdf.text;
      if (text.replace(/\s/g, '').length < 200) throw new Error(UNREADABLE_PDF);
      const { kept, dropped } = checkChanges(result.changes, specs, columns, text);
      const structural = (result.structural || []).map(String).filter(Boolean);
      // Another brand left in the file: fix a copy with PDFCraft (never uploads).
      const hits = brandHits(text);
      const metaHits = pdf.meta;
      const pagesDir = path.join(IMAGES_DIR, 'catalog-pages', task.id);
      const pageImages = fs.existsSync(pagesDir) ? fs.readdirSync(pagesDir).filter((f) => /^p-\d+\.png$/.test(f)).map((f) => path.join(pagesDir, f)) : [];
      let fix = null;
      if (hits.length || metaHits.length || (result.brandVisual || []).length) {
        try {
          fix = await fixCatalogBrands({ manualUrl: group.manualUrl, visual: result.brandVisual, pageImages, outDir: path.join(IMAGES_DIR, 'catalog-fix', task.id), urlBase: `/uploads/agent-images/catalog-fix/${task.id}` });
        } catch (e) { fix = { error: String(e.message || e).slice(0, 300) }; }
      }
      return {
        manualUrl: group.manualUrl,
        products: group.products.map((p) => ({ id: p.id, model: p.model })),
        reason: group.reason, rowsCompared: specs.length,
        summary: String(result.summary || '').trim(), changes: kept, structural,
        fix,
        brand: { text: hits, meta: metaHits, visual: (result.brandVisual || []).slice(0, 8).map((b) => ({ page: Number(b.page) || 0, what: String(b.what || '').slice(0, 200), rect: Array.isArray(b.rect) ? b.rect.map(Number) : [] })).filter((b) => b.what) },
        ocr: !!pdf.ocr,
        review: (pdf.ocr ? 'ไฟล์นี้ตัวหนังสือเป็นเส้น อ่านด้วย OCR จากภาพ ดูตัวเลขกับ PDF อีกครั้งก่อนอนุมัติ · ' : '')
          + (dropped.length ? `สคริปต์ตัด ${dropped.length} รายการที่ตรวจไม่ผ่าน: ${dropped.slice(0, 5).join(' · ')}` : 'ทุกค่าใหม่พบใน PDF และค่าเดิมตรงกับเว็บ'),
      };
    },
    approveLabel: 'เขียนสเปกลงเว็บ',
    async onApprove(task, body, { tasakiWebPool }) {
      const r = task.result || {};
      const all = r.changes || [];
      const keep = Array.isArray(body.keep) ? new Set(body.keep.map(Number)) : null;
      const changes = all.filter((_, i) => !keep || keep.has(i));
      const complete = !(r.structural || []).length && changes.length === all.length;
      const { backupFile } = await applyChanges(tasakiWebPool, {
        products: r.products || [], changes, markSynced: complete, by: 'ทีม AI (แคท) + หนิงอนุมัติ',
        backupDir: path.join(ROOT, 'catalog-sync-backups'),
      });
      const where = (r.products || []).map((p) => p.model).join(', ');
      const saved = backupFile ? ` · สำรองค่าเดิมที่ ${backupFile}` : '';
      // Her ✓ also puts the fixed PDF on the website (if the draft made one).
      let uploaded = '';
      if (r.fix?.localFile) {
        try {
          const up = await uploadApprovedCatalog(task, { ...deps, tasakiWebPool });
          uploaded = up ? ` · อัปโหลด Catalog ที่แก้แล้วขึ้นเว็บแล้ว${up.brandLeft ? ' (⚠️ ตรวจกลับยังเจอชื่อแบรนด์อื่น)' : ' ตรวจกลับสะอาด'}` : '';
        } catch (e) {
          const msg = String(e.message || e).slice(0, 300);
          await deps.prisma.agentTask.update({ where: { id: task.id }, data: { result: { ...task.result, uploadError: msg } } }).catch(() => {});
          uploaded = ` · ⚠️ อัปโหลด Catalog ไม่สำเร็จ: ${msg}`;
        }
      }
      if (!complete) return `เขียนแล้ว ${changes.length} ค่า (${where}) แต่ยังไม่ติ๊กว่าซิงก์ครบ เพราะ${(r.structural || []).length ? 'มีเรื่องที่ต้องจัดการเอง' : 'หนิงไม่ได้ติ๊กครบทุกค่า'}${saved}${uploaded}`;
      return `${changes.length ? `เขียนสเปกลงเว็บ ${changes.length} ค่า` : 'สเปกตรงเดิมทุกค่า'} และติ๊กว่าซิงก์แล้ว (${where})${saved}${uploaded}`;
    },
  },

  // Weekly competitor watch for /competitors. The agent searches; scripts decide
  // what counts (robots.txt is fetched and classified by script, a keyword is a
  // hit only with evidence on tasaki.co.th) and the result is logged directly.
  rival: {
    name: 'ส่อง',
    role: 'ฝ่ายส่องคู่แข่ง',
    about: 'ทุกวันจันทร์ 09:00 อัปเดตหน้า ส่องคู่แข่ง: (2) AI Search — หาเว็บของแต่ละแบรนด์ สคริปต์ดึง robots.txt จริงมาตัดสินเปิด/ปิดบอท AI (รวมกรณีปิดเฉพาะเนื้อหาภาษาไทย) ส่วนส่องเปิดอย่างน้อย 2 หน้าของเว็บนั้นแล้วอัปเดตคะแนนเนื้อหาและรายละเอียด ปรับคะแนนทีละไม่เกิน 15 ต้องมีหลักฐานหน้าเว็บ รวมแบรนด์เราด้วย เก็บโน้ตเดิมไว้ต่อท้าย (3) คีย์เวิร์ด — เช็คซ้ำคำที่เก่าที่สุดสัปดาห์ละ 8 คำด้วย WebSearch (ไม่ปรับตามผู้ใช้) นับว่าติดเฉพาะเมื่อมีลิงก์หลักฐานบน tasaki.co.th และไม่แตะช่อง Ads (4) โน้ตข่าวคู่แข่ง ไม่เกิน 3 เรื่อง พร้อมลิงก์ ไม่ซ้ำของเดิม ลงบันทึกเองเลย (1) Meta Ads — เปิด Facebook Ad Library ด้วย Chrome แบบไม่มีหน้าจอ อ่านจำนวนโฆษณา Active ของแต่ละเพจ (ต้องมี Page ID ของแบรนด์นั้น) แบรนด์ที่ยังไม่มี Page ID จะแจ้งในแชท',
    avatar: '/agent-assets/takujung-v2/takujung-chief.png',
    engine: 'claude',
    model: 'sonnet',
    tools: ['WebSearch', 'WebFetch'],
    placeholder: 'เว้นว่างไว้ได้ จะตรวจตามรอบ หรือพิมพ์เรื่องที่อยากให้ส่อง',
    async buildPrompt(task, prisma) {
      const brands = await prisma.competitorMetric.findMany({ where: { section: 'ai_search' }, orderBy: { brand: 'asc' } });
      const keywords = await prisma.seoKeyword.findMany({ orderBy: [{ checkedAt: { sort: 'asc', nulls: 'first' } }, { sortOrder: 'asc' }], take: 8 });
      const notes = await prisma.competitorSeoNote.findMany({ orderBy: { createdAt: 'desc' }, take: 12 });
      const known = await rivalDomains(prisma);
      task.input = { ...(task.input || {}), keywordIds: keywords.map((k) => k.id) };
      await prisma.agentTask.update({ where: { id: task.id }, data: { input: task.input } }).catch(() => {});
      return `${BRAND_NOTE}

หน้าที่: ส่องคู่แข่งแอร์ในไทยประจำสัปดาห์ ตอบภาษาไทยง่ายๆ ใช้ WebSearch / WebFetch ค้นข้อมูลจริงเท่านั้น ห้ามเดา
${task.prompt ? `เรื่องที่หนิงสั่งเพิ่ม: ${task.prompt}\n` : ''}
1) domains + ประเมินเนื้อหา: ทุกแบรนด์ในรายชื่อด้านล่าง (รวมแบรนด์เรา) หาเว็บหลักทางการในไทย (ชื่อโดเมนอย่างเดียว เช่น example.co.th) ถ้าในรายชื่อมี domain อยู่แล้วให้ใช้โดเมนนั้นเลย ถ้าเป็น null และไม่แน่ใจโดเมนให้ข้ามแบรนด์นั้น ห้ามเดา สคริปต์ดึง robots.txt เองจากโดเมนที่ให้ ส่วนคุณใช้ WebFetch เปิดหน้าแรกและอย่างน้อย 2 หน้าในเว็บนั้น (เช่น เครื่องมือคำนวณ BTU/ค่าไฟ, บทความความรู้, error code, สเปก/แคตตาล็อก) แล้วให้คะแนนเนื้อหา 0–100 ว่า "AI ดึงไปตอบลูกค้าได้ดีแค่ไหน" เทียบเชิงสัมพัทธ์กับคู่แข่ง
เกณฑ์ที่หนิงใช้: มี BTU calc / ค่าไฟ calc / comparison tool / error code / บทความความรู้เจาะจง / สเปกละเอียด / e-brochure / case study / certification ยิ่งครบยิ่งสูง; เว็บเก่าหรือทิ้งร้าง (table layout, SSL มีปัญหา) หรือเนื้อหาเน้นโปรโมทตัวเองหักคะแนน; เข้าถึงไม่ได้ (บล็อก/403) = 0 ห้ามนำเรื่อง "ไม่มีรีวิวบุคคลที่ 3" มาคิดคะแนน (หนิงตัดออกแล้ว) คะแนนปัจจุบันให้ใช้เป็นหลักยึด อย่าเปลี่ยนเกิน 15 แต้มถ้าไม่มีหลักฐานชัดเจนว่าเว็บเปลี่ยนไป
ส่งต่อแบรนด์: brand, domain, score, note (ไม่เกิน 2 ประโยค เล่าสิ่งที่เห็นจริง ไม่ซ้ำคำเดิมทั้งก้อน), evidence_urls (หน้าที่เปิดดูจริง อยู่ในโดเมนนั้น) ถ้าเปิดหน้าไม่ได้ให้ score = -1
แบรนด์ (คะแนน/โน้ตปัจจุบัน): ${JSON.stringify(brands.map((b) => ({ brand: b.brand, domain: known[b.brand] || null, score: b.score, note: b.note.replace(/\s+/g, ' ').slice(0, 160) })))}

2) keywords: ค้นแต่ละคำด้านล่างด้วย WebSearch แล้วดูว่า tasaki.co.th ติดผลค้นหาธรรมชาติหรือไม่ organic = true เฉพาะเมื่อเจอหน้าของ tasaki.co.th ในผลค้นหาจริง และต้องใส่ evidence_url เป็นลิงก์หน้านั้น ถ้าไม่เจอให้ organic = false และ evidence_url ว่าง note = สรุปสั้นๆ ว่าใครติดอยู่ (ไม่เกิน 1 ประโยค) ห้ามรายงานเรื่องโฆษณา
คำ: ${JSON.stringify(keywords.map((k) => k.keyword))}

3) news: ข่าวหรือความเคลื่อนไหวของคู่แข่งแอร์ในไทยช่วง 2 สัปดาห์ล่าสุดที่ธุรกิจ Tasaki ควรรู้ (สินค้าใหม่ โปรโมชั่น แคมเปญ ราคา ตัวแทน) ไม่เกิน 3 เรื่อง แต่ละเรื่อง text ไม่เกิน 2 ประโยคพร้อม url ที่มาจริง ไม่ต้องรายงานเรื่องที่ซ้ำกับโน้ตเดิมด้านล่าง ถ้าไม่มีอะไรใหม่ให้ส่งว่าง
โน้ตเดิม: ${JSON.stringify(notes.map((n) => n.text.slice(0, 140)))}

4) summary: สรุป 2–3 ประโยคว่าสัปดาห์นี้เจออะไร`;
    },
    schema: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        domains: { type: 'array', items: { type: 'object', properties: { brand: { type: 'string' }, domain: { type: 'string' }, score: { type: 'number' }, note: { type: 'string' }, evidence_urls: { type: 'array', items: { type: 'string' } } }, required: ['brand', 'domain', 'score', 'note', 'evidence_urls'] } },
        keywords: { type: 'array', items: { type: 'object', properties: { keyword: { type: 'string' }, organic: { type: 'boolean' }, evidence_url: { type: 'string' }, note: { type: 'string' } }, required: ['keyword', 'organic', 'evidence_url', 'note'] } },
        news: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, url: { type: 'string' } }, required: ['text', 'url'] } },
      },
      required: ['summary', 'domains', 'keywords', 'news'],
    },
    // Scripts decide what is believable before anything is written.
    async verify(result, task, prisma) {
      const out = { summary: String(result.summary || '').trim(), aiSearch: [], keywords: [], news: [], skipped: [] };
      const rows = await prisma.competitorMetric.findMany({ where: { section: 'ai_search' } });
      const known = await rivalDomains(prisma);
      for (const d of result.domains || []) {
        const row = rows.find((r) => r.brand.toLowerCase() === String(d.brand).toLowerCase());
        if (!row) continue;
        const rb = await fetchRobots(known[row.brand] || d.domain);
        if (rb.value === 'unknown') { out.skipped.push(`${row.brand}: ${rb.detail}`); continue; }
        // Content score: only with evidence pages on that brand's own domain, small steps
        // unless access changed. Our own row is assessed the same way (her call).
        const ours = false;
        const sameSite = (u) => { try { const h = new URL(u).hostname.replace(/^www\./, ''); return h === rb.host.replace(/^www\./, '') || h.endsWith(`.${rb.host.replace(/^www\./, '')}`); } catch { return false; } };
        const evidence = (d.evidence_urls || []).filter(sameSite).slice(0, 4);
        let score = row.score;
        let scoreNote = '';
        if (rb.value === 'blocked') { score = 0; scoreNote = 'ปิดบอท'; }
        else if (!ours && Number.isFinite(d.score) && d.score >= 0 && evidence.length >= 1) {
          const step = Math.max(-15, Math.min(15, Math.round(d.score) - (row.score ?? Math.round(d.score))));
          score = Math.max(0, Math.min(100, (row.score ?? Math.round(d.score)) + step));
          if (Math.round(d.score) !== score) scoreNote = `ประเมิน ${Math.round(d.score)} แต่ปรับทีละไม่เกิน 15`;
        } else if (!ours) out.skipped.push(`${row.brand}: ส่องเปิดหน้าเว็บในโดเมนนี้ไม่ได้ จึงไม่เปลี่ยนคะแนน`);
        out.aiSearch.push({
          id: row.id, brand: row.brand, host: rb.host, from: row.value, to: rb.value, changed: row.value !== rb.value, detail: rb.detail,
          scoreFrom: row.score, scoreTo: score, scoreNote, content: ours ? '' : String(d.note || '').trim().slice(0, 400), evidence,
        });
      }
      const kws = await prisma.seoKeyword.findMany({ where: { id: { in: task.input?.keywordIds || [] } } });
      for (const k of result.keywords || []) {
        const row = kws.find((x) => x.keyword.trim().toLowerCase() === String(k.keyword).trim().toLowerCase());
        if (!row) continue;
        const hit = k.organic && onTasakiDomain(k.evidence_url);
        if (k.organic && !hit) out.skipped.push(`${row.keyword}: ไม่มีลิงก์หลักฐานบน tasaki.co.th จึงไม่นับว่าติด`);
        out.keywords.push({ id: row.id, keyword: row.keyword, from: row.organic, to: Boolean(hit), url: hit ? k.evidence_url : '', note: String(k.note || '').slice(0, 240) });
      }
      const old = await prisma.competitorSeoNote.findMany({ orderBy: { createdAt: 'desc' }, take: 40 });
      for (const n of (result.news || []).slice(0, 3)) {
        if (!n.text?.trim() || !/^https?:\/\//.test(n.url || '')) continue;
        if (old.some((o) => similar(o.text, n.text) > 0.45)) continue;
        out.news.push({ text: n.text.trim().slice(0, 500), url: n.url });
      }
      // Meta Ads: headless Chrome reads the Ad Library per advertiser page.
      const pages = await rivalPages(prisma);
      const metaRows = await prisma.competitorMetric.findMany({ where: { section: 'meta_ads' } });
      out.metaAds = []; out.metaNoPage = [];
      for (const row of metaRows) {
        const ids = pages[row.brand];
        if (!ids?.length) { out.metaNoPage.push(row.brand); continue; }
        let total = 0; let failed = false;
        for (const id of ids) { const n = await adCount(id); if (n == null) failed = true; else total += n; }
        if (failed) { out.skipped.push(`Meta Ads ${row.brand}: อ่านจาก Ad Library ไม่ได้`); continue; }
        out.metaAds.push({ id: row.id, brand: row.brand, from: Number(row.value) || 0, to: total, pages: ids.length });
      }
      out.metaAdsLast = out.metaAds.length ? new Date().toISOString() : null;
      out.review = `สคริปต์ดึง robots.txt เอง ${out.aiSearch.length} แบรนด์ · คีย์เวิร์ดนับติดเฉพาะมีลิงก์ tasaki.co.th · ข่าวตัดของซ้ำแล้ว${out.skipped.length ? ` · ข้าม: ${out.skipped.slice(0, 4).join(' / ')}` : ''}`;
      return out;
    },
    approveLabel: 'ลงบันทึก',
    async onApprove(task, body, { prisma, invalidateCache }) {
      const r = task.result || {};
      const now = new Date();
      const day = now.toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short' });
      let ai = 0; let kw = 0; let nt = 0; let ma = 0; let sc = 0;
      for (const a of r.aiSearch || []) {
        const row = await prisma.competitorMetric.findUnique({ where: { id: a.id } });
        if (!row) continue;
        const robots = `robots.txt เช็คอัตโนมัติ ${day} (${a.host}): ${a.detail}`;
        // New assessment first; the previous text is kept (shortened) so her own notes aren't lost.
        const before = row.note.replace(/\s*robots\.txt เช็คอัตโนมัติ[^\n]*/g, '').replace(/^\[ส่องประเมิน[^\]]*\][^\n]*\n?/, '').replace(/^ก่อนหน้า: /, '').trim();
        const head = a.content ? `[ส่องประเมิน ${day}] ${a.content}${a.scoreNote ? ` (${a.scoreNote})` : ''}` : '';
        const note = [head, robots, before ? `ก่อนหน้า: ${before.slice(0, 280)}${before.length > 280 ? '…' : ''}` : ''].filter(Boolean).join('\n');
        const data = { checkedAt: now, note: note.slice(0, 1500) };
        if (a.changed) { data.value = a.to; ai += 1; }
        if (a.scoreTo !== a.scoreFrom) { data.score = a.scoreTo; sc += 1; }
        await prisma.competitorMetric.update({ where: { id: a.id }, data });
      }
      for (const k of r.keywords || []) {
        const row = await prisma.seoKeyword.findUnique({ where: { id: k.id } });
        if (!row) continue;
        const label = k.to ? `🌱 ติด (เช็คอัตโนมัติ ${day}, WebSearch) ${k.url}` : `ยังไม่ติด (เช็คอัตโนมัติ ${day}, WebSearch) ${k.note}`;
        await prisma.seoKeyword.update({ where: { id: k.id }, data: { organic: k.to, checkedAt: now, note: `${label}\n${row.note}`.slice(0, 1500) } });
        if (k.to !== k.from) kw += 1;
      }
      for (const m of r.metaAds || []) {
        const row = await prisma.competitorMetric.findUnique({ where: { id: m.id } });
        if (!row) continue;
        await prisma.competitorMetric.update({ where: { id: m.id }, data: { value: String(m.to), verified: true, checkedAt: now, note: `Ad Library เช็คอัตโนมัติ ${day} (headless Chrome, ${m.pages} เพจ): ${m.from} → ${m.to}`.slice(0, 500) } });
        ma += 1;
      }
      for (const n of r.news || []) {
        await prisma.competitorSeoNote.create({ data: { text: `📰 ข่าวคู่แข่ง (ส่อง ${day}): ${n.text}\n${n.url}` } });
        nt += 1;
      }
      invalidateCache('competitor-metrics');
      invalidateCache('competitor-seo-notes');
      invalidateCache('seo-keywords');
      return `ลงบันทึกแล้ว: AI Search เปลี่ยนสถานะ ${ai} · คะแนน ${sc} แบรนด์ (เช็ค ${(r.aiSearch || []).length}) · คีย์เวิร์ดเปลี่ยน ${kw} (เช็ค ${(r.keywords || []).length}) · Meta Ads อัปเดต ${ma} แบรนด์ · ข่าว ${nt} เรื่อง`;
    },
  },
};

// ─── Engines ─────────────────────────────────────────────────────────────────
// Typos in her comments that read like something else to the AI (e.g.
// "ฟอร์น" for ฟอนต์ sounds like "porn" and got prompts blocked by Claude's
// safety filter). Fixed in every prompt before it leaves the Mac.
const TYPO_FIXES = [[/ฟอร์นท์|ฟอร์นต์|ฟอร์น|ฟร้อนท์|ฟร้อน|ฟ้อนต์|ฟ้อน/g, 'ฟอนต์'], [/ทุเรส/g, 'ไม่สวยเลย']];
function fixTypos(text) {
  return TYPO_FIXES.reduce((t, [re, to]) => t.replace(re, to), text);
}

// Her pause switch: nothing new starts, and whatever is running is stopped
// and put back in the queue to restart from the beginning on resume.
let paused = false;
const children = new Set();
const PAUSE_KEY = '__paused';

// Runs a CLI and keeps the Mac from idle-sleeping only while it works.
function runProcess(bin, args, { cwd, input, timeoutMs = TASK_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env: { ...process.env, ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' } });
    children.add(child);
    const awake = spawn('/usr/bin/caffeinate', ['-i', '-w', String(child.pid)], { stdio: 'ignore' });
    awake.on('error', () => {});
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { clearTimeout(timer); children.delete(child); reject(e); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      children.delete(child);
      if (signal) return reject(new Error(paused ? 'หยุดตามที่หนิงสั่ง' : 'ใช้เวลานานเกินไป ระบบหยุดงานนี้'));
      resolve({ code, stdout, stderr });
    });
    if (input) child.stdin.end(fixTypos(input)); else child.stdin.end();
  });
}

async function languageRequest(agent, task, prisma, context, resume = false) {
  const rules = await combinedRules(prisma, agent.rulesAgent || task.agent);
  const prompt = resume
    ? `ผู้สั่งงานส่งกลับมาให้แก้: ${task.feedback}\nปรับงานเดิมตามนี้แล้วส่งใหม่ในรูปแบบเดิม`
    : (await agent.buildPrompt(task, prisma, context))
      + (agent.exactEdit
        ? `\n\nแนวทางแบรนด์สำหรับอ้างอิง: ${rules}\nงานนี้เป็นการแก้เฉพาะจุด คำสั่งปัจจุบันของผู้สอนมาก่อนค่าเริ่มต้น ห้ามนำค่าเริ่มต้นมาทับคุณสมบัติที่ไม่ได้สั่งแก้ เช่น อย่าเพิ่มความหนาขอบข้อความเพียงเพราะกฎมีค่าความหนาขอบ\n`
        : rulesNote(rules))
      + learningNote(await rejectLearnings(prisma, task.agent, 20))
      + teachingNote(await taughtNotes(prisma, agent.rulesAgent || task.agent))
      + (agent.speaker === null ? '' : THINKING_NOTE)
      + recentNote(task)
      + revisionContext(task);
  const schema = agent.speaker === null ? agent.schema : {
    ...agent.schema,
    properties: { rationale: { type: 'string' }, ...agent.schema.properties },
    required: ['rationale', ...(agent.schema.required || [])],
  };
  return { prompt, schema };
}

// Pictures she attached in the chat, saved under uploads/agent-images/inputs.
const INPUTS_DIR = path.join(IMAGES_DIR, 'inputs');
const ATTACH_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const MAX_ATTACH = 4;
const MAX_ATTACH_BYTES = 6 * 1024 * 1024;

function saveAttachments(list) {
  if (!Array.isArray(list) || !list.length) return [];
  if (list.length > MAX_ATTACH) throw new Error(`แนบภาพได้สูงสุด ${MAX_ATTACH} ภาพ`);
  fs.mkdirSync(INPUTS_DIR, { recursive: true });
  return list.map((a) => {
    const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(typeof a?.data === 'string' ? a.data : '');
    if (!m) throw new Error('แนบได้เฉพาะภาพ PNG, JPG หรือ WebP');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > MAX_ATTACH_BYTES) throw new Error('ภาพแนบใหญ่เกิน 6 MB');
    const name = `${crypto.randomUUID()}.${ATTACH_TYPES[m[1]]}`;
    fs.writeFileSync(path.join(INPUTS_DIR, name), buf);
    return `/uploads/agent-images/inputs/${name}`;
  });
}

// The last few hours of her jobs with one agent, for recentNote(). Pictures
// from those jobs come along too, newest first, unless she attached new ones.
const RECENT_HOURS = 6;
async function recentThread(prisma, agent) {
  const rows = await prisma.agentTask.findMany({
    where: { agent, createdAt: { gte: new Date(Date.now() - RECENT_HOURS * 3600e3) } },
    orderBy: { createdAt: 'desc' },
    take: 8,
  });
  return rows.filter((t) => t.input?.mode !== 'demonstration').slice(0, 5).reverse().map((t) => ({
    prompt: (t.prompt || '').slice(0, 300),
    fixes: [...(t.input?.history || []), ...(t.feedback ? [t.feedback] : [])].map((f) => f.slice(0, 300)),
    status: t.status,
    outcome: String(t.result?.rejectReason || t.error || t.result?.summary || '').slice(0, 300),
    pictures: t.input?.attachments?.length || 0,
    attachments: t.input?.attachments || [],
  }));
}

function attachmentFiles(task) {
  return (Array.isArray(task?.input?.attachments) ? task.input.attachments : [])
    .map((u) => path.join(ROOT, 'public', String(u).split('?')[0]))
    .filter((f) => f.startsWith(IMAGES_DIR + path.sep) && fs.existsSync(f));
}

export async function runLanguageAgent(agent, task, prisma, context) {
  const refs = attachmentFiles(task);
  if (refs.length) agent = { ...agent, images: [...(agent.images || []), ...refs] };
  const id = agent.engineAgent || agent.rulesAgent || task.agent;
  const engine = effectiveEngine(await enginePreferences(prisma), id);
  await logEvent(prisma, agent.speaker || id, `ใช้ ${engine === 'codex' ? 'Codex' : 'Claude'} ทำงาน`, task.id);
  return engine === 'codex'
    ? runCodexLanguage(agent, task, prisma, context)
    : runClaude(agent, task, prisma, context);
}

async function recordLanguageResult(agent, task, prisma, output) {
  const { rationale, ...result } = output;
  if (rationale && agent.speaker !== null) {
    await logEvent(prisma, agent.speaker || task.agent, rationale, task.id, { kind: 'think' });
  }
  return result;
}

async function runClaude(agent, task, prisma, context) {
  const bin = claudeBin();
  if (!bin) throw new Error('ไม่พบ Claude Code บนเครื่องนี้');
  const session = claudeSession(task.sessionId);
  const revising = Boolean(session && task.feedback);
  const request = await languageRequest(agent, task, prisma, context, revising);
  const { schema } = request;
  // Codex gets images as attachments; Claude opens the same files with Read.
  const images = agent.images || [];
  const tools = images.length && !agent.tools.includes('Read') ? [...agent.tools, 'Read'] : agent.tools;
  const prompt = images.length
    ? `${request.prompt}\n\nภาพที่แนบมา ให้เปิดดูด้วยเครื่องมือ Read ก่อนตอบ: ${images.join(' , ')}`
    : request.prompt;
  const args = [
    '-p', '--output-format', 'json', '--model', agent.model || 'sonnet',
    '--json-schema', JSON.stringify(schema), '--strict-mcp-config',
    '--tools', tools.join(','),
    ...(tools.length ? ['--allowedTools', tools.join(',')] : []),
    ...(agent.disallowed?.length ? ['--disallowedTools', agent.disallowed.join(',')] : []),
    ...(revising ? ['--resume', session] : []),
  ];
  const { code, stdout, stderr } = await runProcess(bin, args, { cwd: ROOT, input: prompt, timeoutMs: agent.timeoutMs });
  let out;
  try { out = JSON.parse(stdout); } catch { throw new Error((stderr || stdout).trim().slice(-500) || 'Claude ไม่ตอบกลับ'); }
  if (code !== 0 || out.is_error || !out.structured_output) {
    throw new Error(String(out.result || stderr || out.subtype || 'Claude ทำงานไม่สำเร็จ').slice(-500));
  }
  return { result: await recordLanguageResult(agent, task, prisma, out.structured_output), sessionId: out.session_id ? `claude:${out.session_id}` : null };
}

async function runCodexLanguage(agent, task, prisma, context) {
  const bin = codexBin();
  if (!bin) throw new Error('ไม่พบ Codex บนเครื่องนี้');
  const { prompt, schema } = await languageRequest(agent, task, prisma, context);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasaki-agent-'));
  try {
    const schemaFile = path.join(dir, 'schema.json');
    const outputFile = path.join(dir, 'result.json');
    fs.writeFileSync(schemaFile, JSON.stringify(codexSchema(schema)));
    const args = [
      'exec', '--ignore-user-config', '--skip-git-repo-check', '--ephemeral',
      '--sandbox', 'read-only', '-c', 'approval_policy="never"',
      // No tools are needed for data-only agents; image inspectors receive
      // their inputs as attachments. Read-capable agents keep sandboxed reads.
      ...(!agent.tools.length ? ['-c', 'features.shell_tool=false'] : []),
      '--output-schema', schemaFile, '--output-last-message', outputFile,
      ...((agent.images || []).map((file) => `--image=${file}`)),
    ];
    const { code, stdout, stderr } = await runProcess(bin, args, {
      cwd: ROOT,
      input: `${prompt}\n\nคุณทำหน้าที่ร่าง/วิเคราะห์เท่านั้น ห้ามแก้ไฟล์หรือข้อมูล ห้ามเรียกบริการเพื่อโพสต์หรือเปลี่ยนข้อมูล ภาพที่ต้องตรวจแนบมาพร้อมข้อความแล้ว`,
    });
    if (code !== 0) throw new Error((stderr || stdout).trim().slice(-800) || 'Codex ทำงานไม่สำเร็จ');
    let out;
    try { out = JSON.parse(fs.readFileSync(outputFile, 'utf8')); }
    catch { throw new Error('Codex ไม่ได้ส่งผลลัพธ์ JSON ตามรูปแบบที่กำหนด'); }
    // Codex revisions rebuild full context instead of resuming Claude sessions.
    return { result: await recordLanguageResult(agent, task, prisma, out), sessionId: null };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}



// ─── Image line ──────────────────────────────────────────────────────────────
// ผัง plans the pieces → พิมพ์ paints the background → ผัง looks at that real
// background and places everything → พิมพ์ paints the cut-outs → ประกอบ
// assembles → ผัง checks. Every check (its own, or her ↻ comment) is split
// into jobs for the agent that owns each problem: ผัง moves/resizes, พิมพ์
// edits one piece starting from its previous picture with a concrete change,
// ประกอบ adjusts the real unit's light/colour and the shadow, and brand-kit
// questions go to her. Nothing is regenerated from the same prompt.


const CLOUD_SECONDS = 40;



function speakerFor(task) {
  return task.agent;
}

// ─── Runner ──────────────────────────────────────────────────────────────────
let busy = false;
// Set by registerAgentTeam: what buildPrompt/onApprove can reach (prisma, the
// tasaki-web DB pool, cache invalidation).
let deps = {};

// extra: { kind: 'think' | 'handoff', toAgent ('you' = her), detail, image }
async function logEvent(prisma, agent, text, taskId = null, extra = {}) {
  try {
    await prisma.agentEvent.create({
      data: { agent, text, taskId, kind: extra.kind || 'log', toAgent: extra.toAgent || null, detail: extra.detail ? String(extra.detail).slice(0, 20000) : null, image: extra.image || null },
    });
  } catch {}
}

// Phrased as a decision summary: asking a model to reveal its "thinking"
// trips Claude's safety filter (looks like reasoning extraction).
const THINKING_NOTE = '\n\nช่อง rationale: สรุปเหตุผลของการตัดสินใจหลักในงานนี้ 2–4 ประโยค ภาษาไทย ให้หนิงอ่านประกอบการตรวจงาน';

async function runsToday(prisma) {
  return prisma.agentTask.count({ where: { startedAt: { gte: startOfBangkokDay() } } });
}

// What an agent says to her in the chat when it finishes: the answer itself
// (short), not just "done". The full result stays on the review card.
function chatReply(task, result) {
  const r = result || {};
  const clip = (t, n = 700) => { const x = String(t || '').trim(); return x.length > n ? `${x.slice(0, n)}…` : x; };
  const more = '\n👉 ดูเต็มๆ ได้ที่การ์ดใน “รออนุมัติ”';
  const titles = (r.ideas || []).slice(0, 5).map((i) => `• ${i.title || i.headline || ''}`).filter((x) => x.length > 2);
  switch (task.agent) {
    case 'catalog': return `${clip(r.summary, 400)}\nต่างจากเว็บ ${(r.changes || []).length} ค่า${(r.structural || []).length ? ` · มี ${(r.structural || []).length} เรื่องที่ต้องจัดการเอง` : ''}${brandLine(r.brand)}${r.fix?.file ? `\n🛠 แคทแก้ PDF ให้แล้ว (ยังไม่ได้อัปโหลดขึ้นเว็บ)${(r.fix.previews || []).map((v) => `\n🖼 ${v.page} ${v.url}`).join('')}\n📎 ${r.fix.file}` : ''}${more}`;
    case 'ads': return `${clip([r.summary, ...(r.highlights || []).slice(0, 3).map((x) => `• ${x}`)].filter(Boolean).join('\n'), 800)}${more}`;
    case 'website': return `สรุปความเปลี่ยนแปลงเว็บให้ ${(r.entries || []).length} รายการ${more}`;
    default: return 'ส่งงานให้หนิงตรวจแล้ว';
  }
}

// One line for the chat when a catalog still shows another maker's name or logo.
function brandLine(b) {
  const parts = [...(b?.text || []).map((h) => `${h.term} ×${h.count} (หน้า ${h.pages.join(',')})`), ...(b?.visual || []).map((v) => `โลโก้/ชื่อในภาพ หน้า ${v.page}: ${v.what}`)];
  return parts.length ? `\n🏷 พบชื่อ/โลโก้แบรนด์อื่น หรือข้อความตัวอย่างใน Catalog: ${parts.join(' · ')}` : '';
}

// Chat report of the weekly competitor watch (and the Meta Ads reminder).
function rivalReply(r, posted) {
  const last = r.metaAdsLast ? new Date(r.metaAdsLast) : null;
  const days = last ? Math.floor((Date.now() - last.getTime()) / 86400000) : null;
  const lines = [r.summary || 'ส่องคู่แข่งประจำสัปดาห์เสร็จแล้ว'];
  const flips = (r.aiSearch || []).filter((a) => a.changed).map((a) => `${a.brand}: ${a.from} → ${a.to}`);
  const scores = (r.aiSearch || []).filter((a) => a.scoreTo !== a.scoreFrom).map((a) => `${a.brand} ${a.scoreFrom ?? '—'}→${a.scoreTo}`);
  if (scores.length) lines.push(`🤖 คะแนนเนื้อหา AI Search: ${scores.join(', ')}`);
  if (flips.length) lines.push(`🤖 AI Search เปลี่ยน: ${flips.join(', ')}`);
  const newHits = (r.keywords || []).filter((k) => k.to && !k.from).map((k) => k.keyword);
  if (newHits.length) lines.push(`🌱 คีย์เวิร์ดที่เพิ่งติด: ${newHits.join(', ')}`);
  if ((r.news || []).length) lines.push(`📰 ข่าวคู่แข่งใหม่ ${(r.news || []).length} เรื่อง (ดูในหน้าส่องคู่แข่ง)`);
  if (posted) lines.push(`(${posted})`);
  const ads = (r.metaAds || []).map((m) => `${m.brand} ${m.from}→${m.to}`);
  if ((r.metaAds || []).length) lines.push(`📢 Meta Ads (Ad Library): ${ads.join(', ')}`);
  if ((r.metaNoPage || []).length) lines.push(`📢 ยังไม่มี Page ID ของ ${r.metaNoPage.join(', ')} — ส่งเลข Page ID (จาก URL ใน Ad Library ที่ view_all_page_id=…) ให้ผม จะเช็คให้ทุกสัปดาห์`);
  if (r.review) lines.push(`🔎 ${r.review}`);
  return lines.join('\n');
}

function dailyReply(result, posted) {
  const icon = { website: '🌐', system: '🛠', ads: '📈' };
  const lines = (result.entries || []).map((e) => `${icon[e.section] || '•'} ${e.text.length > 140 ? `${e.text.slice(0, 140)}…` : e.text}`);
  return lines.length
    ? `ลงบันทึกให้แล้ว ${posted.replace(/^ลงบันทึกแล้ว:\s*/, '')}\n${lines.join('\n')}${result.review ? `\n🔎 ${result.review}` : ''}`
    : `ไม่มีอะไรใหม่ต้องลงบันทึก${result.review ? ` (${result.review})` : ''}`;
}

async function tick(prisma) {
  if (busy) return;
  // An explicit "run now" applies only to that WEB summary. Other agents
  // and automatic summaries retain their normal working hours.
  const working = isWorkingHours();
  const immediateWeb = await prisma.agentTask.findFirst({
    where: { status: 'queued', agent: 'website', input: { path: ['runNow'], equals: true } },
    orderBy: { createdAt: 'asc' },
  });
  if (!working && !immediateWeb) return;
  if (DAILY_LIMIT && await runsToday(prisma) >= DAILY_LIMIT) return;
  // WEB's routine summaries are short; they don't wait behind image jobs, and
  // they keep running while she has the rest of the team paused.
  const task = immediateWeb || await prisma.agentTask.findFirst({ where: { status: 'queued', OR: [{ agent: 'website' }, { agent: 'ads', input: { path: ['mode'], equals: 'daily' } }] }, orderBy: { createdAt: 'asc' } })
    || (paused
      // A job she asked for explicitly while the team was paused still runs.
      ? await prisma.agentTask.findFirst({ where: { status: 'queued', input: { path: ['allowWhilePaused'], equals: true } }, orderBy: { createdAt: 'asc' } })
      : await prisma.agentTask.findFirst({ where: { status: 'queued' }, orderBy: { createdAt: 'asc' } }));
  if (!task) return;
  const agent = AGENTS[task.agent];
  busy = true;
  const started = Date.now();
  try {
    await prisma.agentTask.update({ where: { id: task.id }, data: { status: 'running', startedAt: new Date(), error: '' } });
    const first = speakerFor(task, 'plan');
    await logEvent(prisma, first, `${AGENTS[first]?.name || agent.name} รับงาน: ${(task.prompt || agent.role).slice(0, 80)}`, task.id);
    const { result, sessionId } = task.agent === 'ads' && task.input?.mode === 'daily' ? await runAdDaily(task, prisma)
        : await runLanguageAgent(agent, task, prisma, deps).then(async (out) => (agent.verify ? { ...out, result: await agent.verify(out.result, task, prisma) } : out));
    // Routine summaries don't wait for approval: checked by script + Opus,
    // then posted straight to the three logs (her call, 2026-10-20).
    // A catalog that matches the website on every value, with nothing left to
    // ask and no other brand found, is ticked synced without waiting (her call,
    // 2026-10-30). Value changes still wait for her ✓.
    const catalogClean = task.agent === 'catalog' && !result?.changes?.length && !result?.structural?.length && !result?.fix
      && !result?.brand?.text?.length && !result?.brand?.meta?.length && !result?.brand?.visual?.length;
    const auto = (task.input?.mode === 'daily' && (task.agent === 'website' || task.agent === 'ads')) || task.agent === 'rival' || catalogClean;
    const posted = !auto ? ''
      : catalogClean ? await agent.onApprove({ ...task, result }, {}, deps)
      : task.agent === 'ads' ? await postAdDaily(result, prisma, deps.invalidateCache)
        : task.agent === 'rival' ? await agent.onApprove({ ...task, result }, {}, deps)
          : result?.entries?.length ? await agent.onApprove({ ...task, result }, { entries: result.entries }, deps) : '';
    await prisma.agentTask.update({
      where: { id: task.id },
      data: { status: auto ? 'done' : 'review', result, sessionId: sessionId || null, rounds: task.rounds + 1, finishedAt: new Date(), durationMs: Date.now() - started, ...(auto ? { decidedAt: new Date() } : {}) },
    });
    // An image job reaches her from PLAN, who planned it and checked the result.
    if (!(task.agent === 'ads' && result?.quiet)) {
      await logEvent(prisma, speakerFor(task, 'review'), auto ? (catalogClean ? `${result.summary}\n✓ ติ๊กซิงก์ให้อัตโนมัติแล้ว: ${posted}${result.ocr ? '\n(อ่านด้วย OCR เพราะตัวหนังสือในไฟล์เป็นเส้น)' : ''}` : task.agent === 'rival' ? rivalReply(result, posted) : task.agent === 'ads' ? `${result.text}${posted ? `\n(${posted})` : ''}\n🔎 ${result.review}` : dailyReply(result, posted)) : chatReply(task, result), task.id, { kind: 'handoff', toAgent: 'you', image: result?.images?.[0] || null });
    }
  } catch (e) {
    // Back to the queue only when the pause button itself cut the job short;
    // any other failure is a real failure (retrying it every 5 s looped 50+ times).
    if (paused && /หยุดตามที่หนิงสั่ง/.test(String(e.message || e))) {
      await prisma.agentTask.update({ where: { id: task.id }, data: { status: 'queued', error: '' } }).catch(() => {});
      await logEvent(prisma, task.agent, `${agent.name} หยุดงานไว้ก่อนตามที่หนิงสั่ง งานรอคิวอยู่ จะเริ่มใหม่เมื่อกด “ให้ทีมทำงานต่อ”`, task.id);
      return;
    }
    await prisma.agentTask.update({
      where: { id: task.id },
      data: { status: 'failed', error: String(e.message || e).slice(0, 2000), finishedAt: new Date(), durationMs: Date.now() - started },
    }).catch(() => {});
    const stageNow = (await prisma.agentTask.findUnique({ where: { id: task.id } }).catch(() => null))?.result?.stage;
    const who = speakerFor(task, stageNow);
    await logEvent(prisma, who, `${AGENTS[who]?.name || agent.name} ทำงานไม่สำเร็จ: ${String(e.message || e).slice(0, 120)}`, task.id);
  } finally {
    busy = false;
  }
}

// ─── Routes ──────────────────────────────────────────────────────────────────
// Names she picked replace the built-in ones everywhere (cards, @ menu, logs).
// Stored like engine choices: reserved AgentSetting rows, no migration.
const NAME_PREFIX = '__name:';
const DEFAULT_NAMES = Object.fromEntries(Object.entries(AGENTS).map(([id, a]) => [id, a.name]));

async function loadAgentNames(prisma) {
  const rows = await prisma.agentSetting.findMany({ where: { agent: { startsWith: NAME_PREFIX } } });
  for (const id of Object.keys(AGENTS)) AGENTS[id].name = DEFAULT_NAMES[id];
  for (const r of rows) {
    const id = r.agent.slice(NAME_PREFIX.length);
    if (AGENTS[id] && r.rules) AGENTS[id].name = r.rules;
  }
}


// ─── Her saves in VectorCraft refresh the picture ────────────────────────────
// The pictures on the page are PNGs rendered from the layered .vectorcraft
// files. When she edits one in VectorCraft and saves, the PNG is re-rendered in
// place and the page reloads it (pictureVersions → ?v= on every <img>).
// The team's own writes are ignored: nothing is re-rendered while a job runs,
// and .history backups are skipped.
const pictureVersions = new Map();



// What the clocks above do, for the "งานรูทีน" panel. `key` is the setting row
// that remembers the last run; `days` use the same numbers as WORK_DAYS.
const ROUTINES = [
  { agent: 'catalog', days: WORK_DAYS, satToo: true, times: [CATALOG_SLOT], text: 'ตรวจ Catalog PDF ที่ใหม่หรือถูกอัปโหลดทับ เทียบสเปกกับเว็บ', key: CATALOG_DAILY_KEY },
  { agent: 'ads', days: WORK_DAYS, satToo: true, times: [AD_SLOT], text: 'สรุปผลโฆษณาประจำวัน', key: AD_DAILY_KEY },
  { agent: 'rival', days: [1], times: ['09:00'], text: 'ส่องคู่แข่งประจำสัปดาห์', key: RIVAL_KEY },
  { agent: 'website', days: WORK_DAYS, satToo: true, times: DAILY_SLOTS, text: 'สรุปสิ่งที่ทำลง 3 บันทึก และผูกคลิปที่โพสต์กับการ์ด', key: DAILY_KEY },
];

async function routineStatus(prisma) {
  const rows = await prisma.agentSetting.findMany({ where: { agent: { in: ROUTINES.map((r) => r.key) } } });
  const last = Object.fromEntries(rows.map((r) => [r.agent, r.rules]));
  return ROUTINES.map(({ key, ...r }) => {
    let lastRun = null;
    if (key === DAILY_KEY) { try { lastRun = JSON.parse(last[key] || '{}').slot || null; } catch {} }
    else lastRun = last[key] || null;
    return { ...r, lastRun };
  });
}

export function registerAgentTeam(app, { prisma, invalidateCache, tasakiWebPool }) {
  deps = { prisma, invalidateCache, tasakiWebPool, logEvent };
  loadAgentNames(prisma).catch((e) => console.error('agent names:', e.message));
  loadWorkSaturdays(prisma).catch((e) => console.error('work saturdays:', e.message));
  setInterval(() => { loadWorkSaturdays(prisma).catch(() => {}); }, 60 * 1000);
  prisma.agentSetting.findUnique({ where: { agent: PAUSE_KEY } }).then((r) => { paused = r?.rules === 'on'; }).catch(() => {});
  if (RUNNER_ON) {
    // Anything left "running" belonged to a server that died mid-task.
    prisma.agentTask.updateMany({ where: { status: 'running' }, data: { status: 'queued' } }).catch(() => {});
    setInterval(() => { tick(prisma).catch((e) => console.error('agent runner:', e.message)); }, POLL_MS);
    setInterval(() => { scheduleDaily(prisma).catch((e) => console.error('daily summary:', e.message)); }, 60 * 1000);
    setInterval(() => { scheduleAdDaily(prisma).catch((e) => console.error('ad daily:', e.message)); }, 60 * 1000);
    setInterval(() => { scheduleRival(prisma).catch((e) => console.error('rival weekly:', e.message)); }, 60 * 1000);
    setInterval(() => { scheduleCatalogDaily(prisma).catch((e) => console.error('catalog daily:', e.message)); }, 60 * 1000);
    setInterval(() => { sweepCatalogBrands(prisma).catch((e) => console.error('catalog brands:', e.message)); }, 60 * 1000);
  }

  const requireRunner = (req, res, next) => (RUNNER_ON ? next() : res.status(403).json({ error: 'ทีม AI ใช้ได้เฉพาะบนเครื่อง Mac ของฝ่ายการตลาด' }));

  app.get('/api/agents', async (req, res) => {
    try {
      const engines = await enginePreferences(prisma);
      const [tasks, events, today, learnings, products, recent] = await Promise.all([
        prisma.agentTask.findMany({ orderBy: { createdAt: 'desc' }, take: 60 }),
        prisma.agentEvent.findMany({ where: { createdAt: { gte: startOfBangkokDay() } }, orderBy: { createdAt: 'desc' }, take: 100 }),
        RUNNER_ON ? runsToday(prisma) : 0,
        rejectLearnings(prisma, null, 30).then((r) => r.slice(0, 90)),
        RUNNER_ON ? productCatalog(tasakiWebPool).catch(() => []) : [],
        prisma.agentEvent.findMany({
          where: { kind: { in: ['think', 'handoff'] }, agent: { not: 'you' }, createdAt: { gte: new Date(Date.now() - CLOUD_SECONDS * 1000) } },
          orderBy: { createdAt: 'desc' }, take: 200, select: { agent: true, kind: true, toAgent: true, text: true, taskId: true, createdAt: true },
        }),
      ]);
      // Each agent's cloud is live only: 🛠️ while a step is actually running,
      // 🧠 / 📤 for CLOUD_SECONDS after the thought or handoff happens, then gone.
      const bubbles = {};
      const slot = (id) => (bubbles[id] ||= {});
      for (const e of recent) {
        const b = slot(e.agent);
        if (e.kind === 'think' && !b.think) b.think = e;
        if (e.kind === 'handoff' && !b.handoff) b.handoff = e;
      }
      for (const t of tasks.filter((x) => x.status === 'running')) slot(t.agent).doing = { text: `ทำงาน: ${(t.prompt || '').slice(0, 80)}`, taskId: t.id };
      const cardIds = [...new Set(tasks.map((t) => t.input?.cardId).filter(Boolean))];
      const cards = cardIds.length ? await prisma.card.findMany({ where: { id: { in: cardIds } }, select: { id: true, title: true } }) : [];
      const cardTitles = Object.fromEntries(cards.map((c) => [c.id, c.title]));
      res.json({
        runner: RUNNER_ON,
        working: isWorkingHours(),
        paused,
        pictures: Object.fromEntries(pictureVersions),
        hours: { days: WORK_DAYS, start: WORK_START_HOUR, end: WORK_END_HOUR },
        passedAgents: await loadPassedAgents(prisma),
        workSaturdays: [...workSaturdays].filter((d) => d >= bangkokNow().date).sort(),
        routines: await routineStatus(prisma),
        usage: { today, limit: DAILY_LIMIT },
        agents: Object.entries(AGENTS).map(([id, a]) => ({
          id, name: a.name, role: a.role, avatar: a.avatar,
          engine: a.engine === 'claude' ? effectiveEngine(engines, id) : a.engine, placeholder: a.placeholder,
          // Codex runs whatever its CLI defaults to; Claude agents name their model.
          model: a.engine === 'claude' && effectiveEngine(engines, id) === 'claude' ? a.model || 'sonnet' : null,
          needsCard: Boolean(a.needsCard), decides: Boolean(a.decides), approveLabel: a.approveLabel,
          pipelineStage: null, vectorEditor: false, orderable: true,
          commandable: false,
        })),
        tasks: tasks.map((t) => ({ ...t, cardTitle: cardTitles[t.input?.cardId] || null })),
        events,
        learnings,
        bubbles,
        team: { id: TEAM.id, name: TEAM.name, role: TEAM.role, avatar: TEAM.avatar, orderable: false },
        products: products.filter((p) => p.image).map((p) => ({ model: p.model, nameTh: p.nameTh, type: p.type })),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Side log: every agent's events, newest first, fetched incrementally.
  app.get('/api/agents/log', async (req, res) => {
    try {
      const since = req.query.since ? new Date(String(req.query.since)) : new Date(Date.now() - 48 * 3600e3);
      const rows = await prisma.agentEvent.findMany({
        where: { createdAt: { gt: Number.isNaN(since.getTime()) ? new Date(0) : since } },
        orderBy: { createdAt: 'desc' },
      });
      res.json({ events: rows.map((e) => ({ ...e, detail: e.detail ? e.detail.slice(0, 3000) : null })) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // The team conversation for one task: who thought / handed over what.
  app.get('/api/agents/tasks/:id/thread', async (req, res) => {
    try {
      const events = await prisma.agentEvent.findMany({ where: { taskId: req.params.id }, orderBy: { createdAt: 'asc' } });
      res.json({ events });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/agents/tasks', requireRunner, async (req, res) => {
    const { agent, prompt } = req.body;
    const def = AGENTS[agent];
    if (!def) return res.status(400).json({ error: 'สั่งฝ่ายนี้โดยตรงไม่ได้' });
    let text = typeof prompt === 'string' ? prompt.trim() : '';
    const raw = req.body.input && typeof req.body.input === 'object' ? req.body.input : {};
    // Only plain values from the browser; file paths are always resolved here.
    const input = {};
    for (const k of ['cardId', 'date', 'days', 'productModel', 'sourceTaskId', 'headline', 'subhead']) {
      if (typeof raw[k] === 'string' || typeof raw[k] === 'number') input[k] = raw[k];
    }
    if (!text && !def.needsCard && agent !== 'website' && agent !== 'ads' && agent !== 'catalog' && agent !== 'rival') return res.status(400).json({ error: 'ใส่คำสั่งงานก่อน' });
    if (def.needsCard && !input.cardId) return res.status(400).json({ error: 'เลือกการ์ดก่อน' });
    try {
      // @WEB always covers all three logs: the chosen day, up to now if today.
      if (agent === 'website') {
        const day = /^\d{4}-\d{2}-\d{2}$/.test(String(input.date || '')) ? input.date : bangkokNow().date;
        const end = new Date(`${day}T23:59:59+07:00`);
        input.mode = 'daily';
        input.since = new Date(`${day}T00:00:00+07:00`).toISOString();
        input.until = (end > new Date() ? new Date() : end).toISOString();
        if (raw.runNow === true) input.runNow = true;
      }
      const attachments = saveAttachments(req.body.attachments);
      const recent = await recentThread(prisma, agent);
      if (recent.length) input.recent = recent.map(({ attachments: _, ...r }) => r);
      const carried = [...recent].reverse().flatMap((r) => r.attachments);
      if (attachments.length || carried.length) input.attachments = attachments.length ? attachments : [...new Set(carried)].slice(0, 4);
      const task = await prisma.agentTask.create({ data: { agent, prompt: text || '', input } });
      await logEvent(prisma, 'you', `${text || def.role}${attachments.length ? ` 📎 ${attachments.length} ภาพ` : ''}`, task.id, { kind: 'handoff', toAgent: agent, image: attachments[0] || null, detail: Object.keys(input).length ? JSON.stringify(input, null, 2) : null });
      res.status(201).json(task);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/agents/tasks/:id/approve', requireRunner, async (req, res) => {
    try {
      const task = await prisma.agentTask.findUnique({ where: { id: req.params.id } });
      if (!task || task.status !== 'review') return res.status(400).json({ error: 'งานนี้ไม่ได้อยู่ในสถานะรอตรวจ' });
      const def = AGENTS[task.agent];
      const note = def.onApprove ? await def.onApprove(task, req.body || {}, deps) : 'อนุมัติแล้ว';
      await prisma.agentTask.update({ where: { id: task.id }, data: { status: 'done', decidedAt: new Date() } });
      const said = typeof req.body?.comment === 'string' ? req.body.comment.trim().slice(0, 600) : '';
      await logEvent(prisma, 'you', `✓ ผ่าน — ${note}${said ? ` · คอมเมนต์: ${said}` : ''}`, task.id, { kind: 'handoff', toAgent: task.agent });
      res.json({ ok: true, note });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ↻ ให้แก้ — from the review card or a chat follow-up. The fix she gave
  // last round moves into input.history so the next round still knows the
  // original ask, every earlier fix and every picture she attached.
  app.post('/api/agents/tasks/:id/revise', requireRunner, async (req, res) => {
    const feedback = typeof req.body?.feedback === 'string' ? req.body.feedback.trim() : '';
    if (!feedback) return res.status(400).json({ error: 'บอกด้วยว่าอยากให้แก้อะไร' });
    try {
      const task = await prisma.agentTask.findUnique({ where: { id: req.params.id } });
      if (!task || task.status !== 'review') return res.status(400).json({ error: 'งานนี้ไม่ได้อยู่ในสถานะรอตรวจ' });
      const added = saveAttachments(req.body.attachments);
      const input = { ...(task.input || {}) };
      if (task.feedback) input.history = [...(input.history || []), task.feedback].slice(-10);
      if (added.length) input.attachments = [...(input.attachments || []), ...added].slice(-8);
      // catalog re-reads the current PDF from scratch; a resumed chat would still hold the old file.
      await prisma.agentTask.update({ where: { id: task.id }, data: { status: 'queued', feedback, input, ...(task.agent === 'catalog' ? { sessionId: null } : {}) } });
      await logEvent(prisma, 'you', `↻ ให้แก้: ${feedback}${added.length ? ` 📎 ${added.length} ภาพ` : ''}`, task.id, { kind: 'handoff', toAgent: task.agent, image: added[0] || null });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Retry of the upload when the automatic one at approval failed.
  app.post('/api/agents/tasks/:id/upload-catalog', requireRunner, async (req, res) => {
    try {
      const task = await prisma.agentTask.findUnique({ where: { id: req.params.id } });
      if (!task || task.agent !== 'catalog') return res.status(400).json({ error: 'ไม่ใช่งานของแคท' });
      res.json(await uploadApprovedCatalog(task, deps));
    } catch (e) { res.status(400).json({ error: String(e.message || e).slice(0, 400) }); }
  });

  app.post('/api/agents/tasks/:id/reject', requireRunner, async (req, res) => {
    try {
      const task = await prisma.agentTask.findUnique({ where: { id: req.params.id } });
      if (!task || !['review', 'queued', 'failed', 'waiting'].includes(task.status)) return res.status(400).json({ error: 'ยกเลิกงานนี้ไม่ได้' });
      const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
      await prisma.agentTask.update({
        where: { id: task.id },
        data: { status: 'rejected', decidedAt: new Date(), ...(reason ? { result: { ...(task.result || {}), rejectReason: reason } } : {}) },
      });
      await logEvent(prisma, 'you', `✕ ไม่ผ่าน${reason ? ` — ${reason}` : ''}`, task.id, { kind: 'handoff', toAgent: task.agent });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // The server runs on her Mac, so it can hand an agent image straight to the
  // desktop app (e.g. to add the Thai headline in VectorCraft).
  // ── Settings panel: what each agent is told behind the scenes + her rules ──
  app.get('/api/agents/:id/settings', async (req, res) => {
    const def = AGENTS[req.params.id] || (req.params.id === TEAM.id ? TEAM : null);
    if (!def) return res.status(404).json({ error: 'ไม่รู้จักฝ่ายนี้' });
    try {
      const rules = await agentRules(prisma, req.params.id);
      const engines = await enginePreferences(prisma);
      const canChooseEngine = def.engine === 'claude' || req.params.id === TEAM.id;
      const engine = canChooseEngine ? effectiveEngine(engines, req.params.id) : def.engine;
      const saved = await prisma.agentSetting.findUnique({ where: { agent: req.params.id } });
      let prompt = '';
      if (def.buildPrompt) {
        try {
          prompt = await def.buildPrompt({ id: 'preview', agent: req.params.id, prompt: '(คำสั่งงานของคุณจะอยู่ตรงนี้)', input: {} }, prisma, deps);
        } catch (e) { prompt = `(ดูตัวอย่างไม่ได้ตอนนี้: ${e.message})`; }
      }
      const learned = await rejectLearnings(prisma, req.params.id, 30);
      res.json({
        id: req.params.id, name: def.name, defaultName: DEFAULT_NAMES[req.params.id] || def.name, role: def.role, about: def.about || '', engine,
        canChooseEngine, enginePreference: engines[req.params.id] || 'default',
        teamEngine: engines.all || 'claude',
        model: engine === 'codex' ? 'Codex CLI' : def.model || (engine === 'claude' ? 'sonnet' : engine === 'team' ? 'ใช้กับทุกตัว' : 'ไม่ใช้ AI'),
        tools: def.tools || [], rules, isDefault: !saved, defaultRules: DEFAULT_RULES[req.params.id] || '',
        updatedAt: saved?.updatedAt || null, prompt, learned,
        taught: req.params.id === TEAM.id ? [] : await taughtNotes(prisma, req.params.id, 40),
        usesRules: Boolean(def.buildPrompt || req.params.id === TEAM.id),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });


  // 🧹 Everything still waiting (queued, or waiting for a file) is cancelled.
  // A job that is running is left alone; no reason is stored, so nothing is
  // "learned" from a clear-out.
  app.post('/api/agents/clear-pending', requireRunner, async (req, res) => {
    try {
      const out = await prisma.agentTask.updateMany({ where: { status: { in: ['queued', 'waiting'] } }, data: { status: 'rejected', decidedAt: new Date() } });
      if (out.count) await logEvent(prisma, 'you', `🧹 ล้างงานค้าง ${out.count} งาน`);
      res.json({ ok: true, cleared: out.count });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Adds or removes one company-calendar Saturday ("YYYY-MM-DD").
  app.post('/api/agents/work-saturdays', async (req, res) => {
    try {
      const date = String(req.body?.date || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T12:00:00+07:00`).getDay() !== 6) return res.status(400).json({ error: 'ต้องเป็นวันเสาร์' });
      await loadWorkSaturdays(prisma);
      if (req.body?.on === false) workSaturdays.delete(date); else workSaturdays.add(date);
      const rules = JSON.stringify([...workSaturdays].sort());
      await prisma.agentSetting.upsert({ where: { agent: SAT_KEY }, create: { agent: SAT_KEY, rules }, update: { rules } });
      res.json({ workSaturdays: [...workSaturdays].sort() });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // She alone decides which agents have passed training.
  app.post('/api/agents/passed', async (req, res) => {
    try {
      const id = String(req.body?.agent || '');
      if (!AGENTS[id]) return res.status(400).json({ error: 'ไม่พบเอเจนต์' });
      const set = new Set(await loadPassedAgents(prisma));
      if (req.body?.on === false) set.delete(id); else set.add(id);
      const rules = JSON.stringify([...set]);
      await prisma.agentSetting.upsert({ where: { agent: PASSED_KEY }, create: { agent: PASSED_KEY, rules }, update: { rules } });
      res.json({ passedAgents: [...set] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/agents/pause', requireRunner, async (req, res) => {
    paused = Boolean(req.body?.paused);
    try {
      if (paused) await prisma.agentSetting.upsert({ where: { agent: PAUSE_KEY }, create: { agent: PAUSE_KEY, rules: 'on' }, update: { rules: 'on' } });
      else await prisma.agentSetting.deleteMany({ where: { agent: PAUSE_KEY } });
      if (paused) {
        for (const child of children) child.kill('SIGTERM');
      }
      await logEvent(prisma, 'you', paused ? '⏸ หยุดทีมไว้ก่อน' : '▶ ให้ทีมทำงานต่อ');
      res.json({ ok: true, paused });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/agents/taught/forget', requireRunner, async (req, res) => {
    const key = typeof req.body?.key === 'string' ? req.body.key : '';
    if (!/^[0-9a-f-]{36}:(f|p|h\d+)$/.test(key)) return res.status(400).json({ error: 'ข้อมูลไม่ถูกต้อง' });
    try {
      const keys = await forgottenKeys(prisma);
      keys.add(key);
      const rules = JSON.stringify([...keys].slice(-300));
      await prisma.agentSetting.upsert({ where: { agent: FORGET_KEY }, create: { agent: FORGET_KEY, rules }, update: { rules } });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/agents/:id/name', requireRunner, async (req, res) => {
    const id = req.params.id;
    if (!AGENTS[id]) return res.status(404).json({ error: 'ไม่รู้จักฝ่ายนี้' });
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    // @mentions match the name up to the first space, so no spaces or @.
    if (name && (/[\s@]/.test(name) || name.length > 20)) return res.status(400).json({ error: 'ชื่อต้องไม่มีช่องว่างหรือ @ และยาวไม่เกิน 20 ตัวอักษร' });
    if (name && Object.entries(AGENTS).some(([other, a]) => other !== id && a.name === name)) return res.status(400).json({ error: `ชื่อ ${name} มี Agent อื่นใช้อยู่แล้ว` });
    try {
      const old = AGENTS[id].name;
      const agent = `${NAME_PREFIX}${id}`;
      if (!name || name === DEFAULT_NAMES[id]) await prisma.agentSetting.deleteMany({ where: { agent } });
      else await prisma.agentSetting.upsert({ where: { agent }, create: { agent, rules: name }, update: { rules: name } });
      await loadAgentNames(prisma);
      await logEvent(prisma, 'you', `เปลี่ยนชื่อ ${old} เป็น ${AGENTS[id].name}`);
      res.json({ ok: true, name: AGENTS[id].name, defaultName: DEFAULT_NAMES[id] });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/agents/:id/engine', requireRunner, async (req, res) => {
    const id = req.params.id;
    if (id !== TEAM.id && AGENTS[id]?.engine !== 'claude') {
      return res.status(400).json({ error: 'ฝ่ายนี้ใช้เครื่องมือเฉพาะ สลับ Claude/Codex ไม่ได้' });
    }
    if (!['claude', 'codex', 'default'].includes(req.body?.engine)) {
      return res.status(400).json({ error: 'เลือก Claude, Codex หรือค่าเริ่มต้น' });
    }
    try {
      await saveEngine(prisma, id, req.body.engine);
      const engines = await enginePreferences(prisma);
      const engine = effectiveEngine(engines, id);
      await logEvent(prisma, 'you', `ตั้งเครื่องมือของ ${id === TEAM.id ? 'ทั้งทีม' : AGENTS[id].name} เป็น ${req.body.engine === 'default' ? 'ค่าเริ่มต้น' : engine}`);
      res.json({ ok: true, engine, enginePreference: engines[id] || 'default' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/agents/:id/settings', requireRunner, async (req, res) => {
    const def = AGENTS[req.params.id] || (req.params.id === TEAM.id ? TEAM : null);
    if (!def) return res.status(404).json({ error: 'ไม่รู้จักฝ่ายนี้' });
    const rules = typeof req.body?.rules === 'string' ? req.body.rules.slice(0, 8000) : '';
    try {
      await prisma.agentSetting.upsert({ where: { agent: req.params.id }, update: { rules }, create: { agent: req.params.id, rules } });
      await logEvent(prisma, req.params.id, `แก้กฎของ ${def.name}`);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // "@ผัง …" from the chat box: her words become a standing rule, dated, so
  // the agent follows it from its next job on.
  app.post('/api/agents/:id/settings/note', requireRunner, async (req, res) => {
    const def = AGENTS[req.params.id] || (req.params.id === TEAM.id ? TEAM : null);
    const text = typeof req.body?.text === 'string' ? req.body.text.trim().slice(0, 1000) : '';
    if (!def || !text) return res.status(400).json({ error: 'พิมพ์ด้วยว่าจะบอกอะไร' });
    try {
      const current = await agentRules(prisma, req.params.id);
      const stamp = new Date().toLocaleDateString('th-TH', { day: 'numeric', month: 'short', timeZone: 'Asia/Bangkok' });
      const rules = `${current.trim()}\n- (หนิงสั่ง ${stamp}) ${text}`.trim();
      await prisma.agentSetting.upsert({ where: { agent: req.params.id }, update: { rules }, create: { agent: req.params.id, rules } });
      await logEvent(prisma, 'you', `${text} (บันทึกเป็นกฎแล้ว)`, null, { kind: 'handoff', toAgent: req.params.id });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // She says what to change in plain words; Claude rewrites the rule list.
  // Returned as a draft — nothing is saved until she presses บันทึก.
  app.post('/api/agents/:id/settings/adjust', requireRunner, async (req, res) => {
    const def = AGENTS[req.params.id];
    const request = typeof req.body?.request === 'string' ? req.body.request.trim() : '';
    if (!def || !request) return res.status(400).json({ error: 'บอกด้วยว่าอยากให้ปรับอะไร' });
    const current = typeof req.body?.rules === 'string' ? req.body.rules : await agentRules(prisma, req.params.id);
    // Not a team agent itself: no rules or learnings of its own appended.
    const editor = {
      speaker: null,
      rulesAgent: '__editor',
      engineAgent: req.params.id,
      model: 'haiku',
      tools: [],
      schema: { type: 'object', properties: { rules: { type: 'string' }, summary: { type: 'string' } }, required: ['rules', 'summary'] },
      async buildPrompt() {
        return `คุณช่วยแก้ "กฎ" ที่ผู้ดูแลการตลาดตั้งให้ AI ชื่อ ${def.name} (${def.role}) หน้าที่: ${def.about || def.role}
กฎปัจจุบัน (เป็นรายการขึ้นต้นด้วย "- "):
${current || '(ยังไม่มี)'}

ผู้ดูแลขอให้ปรับว่า: ${request}

เขียนรายการกฎใหม่ทั้งหมด ภาษาไทย กระชับ ชัดเจน ทำตามได้จริง เก็บกฎเดิมที่ยังใช้ได้ไว้ แก้หรือลบข้อที่ขัดกับคำขอ
summary: บอกสั้นๆ ว่าเปลี่ยนอะไร`;
      },
    };
    try {
      const { result } = await runLanguageAgent(editor, { id: 'adjust', agent: '__editor', prompt: '', sessionId: null, feedback: '' }, prisma, deps);
      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });


  const APPS = { vectorcraft: 'VectorCraft', effectcraft: 'EffectCraft', filmcraft: 'FilmCraft', pdfcraft: 'PdfCraft' };
  app.post('/api/agents/open-in-app', requireRunner, (req, res) => {
    const src = typeof req.body?.src === 'string' ? req.body.src : '';
    const appName = APPS[req.body?.app] || 'VectorCraft';
    const file = path.join(ROOT, 'public', src);
    if (!src.startsWith('/uploads/agent-images/') || !file.startsWith(IMAGES_DIR + path.sep) || !fs.existsSync(file)) {
      return res.status(400).json({ error: 'ไม่พบไฟล์ภาพ' });
    }
    execFile('open', ['-a', appName, file], (err) => {
      if (err) return res.status(500).json({ error: `เปิด ${appName} ไม่ได้` });
      res.json({ ok: true });
    });
  });


  app.post('/api/agents/tasks/:id/retry', requireRunner, async (req, res) => {
    try {
      const task = await prisma.agentTask.findUnique({ where: { id: req.params.id } });
      if (!task || !['failed', 'waiting'].includes(task.status)) return res.status(400).json({ error: 'ลองใหม่ได้เฉพาะงานที่ไม่สำเร็จหรือรอไฟล์' });
      await prisma.agentTask.update({ where: { id: task.id }, data: { status: 'queued', error: '' } });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}

export { adFacts, adNumbersOk, adPlainText };

