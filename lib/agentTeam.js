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
import { createVectorTeaching } from './vectorTeaching.js';
import { createLiveVector } from './vectorLive.js';
import { attachApprovedGraphicImage } from './graphicAgentImages.js';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { campaignBrief } from './campaigns.js';
import { kitCatalog, kitFile, fitRect, textStyleSteps, loadTextStylesStep, TEXT_STYLES, kitNote } from './vectorKit.js';
import { LAYOUT_RULES, IMAGE_RULES, ASSEMBLE_RULES, VECTOR_RULES } from './imageTeamRules.js';
import { fixCatalogBrands } from './catalogFix.js';
import { guideSteps } from './adGuides.js';
import { sceneBrief, genSize } from './sceneBrief.js';
import { buildFromTemplate, templateDoc, VARIANTS } from './adRecipe.js';
import { fetchRobots, onTasakiDomain, adCount } from './rivalWatch.js';
import { staleCatalogs, allCatalogs, groupByUrl, groupByModelText, uploadFixedCatalog, specColumns, groupSpecs, loadPdf, UNREADABLE_PDF, brandHits, clipPdfText, checkChanges, applyChanges } from './catalogSync.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const IMAGES_DIR = path.join(ROOT, 'public', 'uploads', 'agent-images');
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
    out = execFileSync('git', ['log', '--all', '--no-merges', `--since=${since}`, `--until=${until}`, '--name-only', '--pretty=%x1e%aI%x1f%s%x1f%b%x1f'], { cwd: repo, encoding: 'utf8' });
  } catch { return []; }
  return out.split('\x1e').map((r) => r.trim()).filter(Boolean).map((r) => {
    const [when, subject, body, names] = r.split('\x1f');
    // File names say what a vague subject doesn't; media/assets are noise.
    const files = [...new Set((names || '').split('\n').map((f) => f.trim()).filter((f) => f && !/\.(png|jpe?g|webp|svg|mp4|mov|pdf|ecproj|fcproj)$/i.test(f)))];
    return { date: when, subject, body: (body || '').replace(/Co-Authored-By:.*$/gim, '').trim(), files: files.slice(0, 40) };
  });
}

// "What I've done" for one window of time, from where it's actually recorded:
// the two git repos, the ad work the team did that she decided on, and what is
// already in each log (so nothing is posted twice).
async function dailySources(prisma, since, until) {
  try { execFileSync('git', ['pull', '--ff-only'], { cwd: WEBSITE_REPO, stdio: 'ignore', timeout: 30000 }); } catch {}
  const range = { gte: new Date(since), lte: new Date(until) };
  // The team's own routine runs (e.g. AD's daily brief) get a decidedAt too but
  // she never decided them: they are not "ad work she approved".
  const decided = (await prisma.agentTask.findMany({ where: { agent: { in: ['ads', 'adideas', 'image', 'motion', 'caption'] }, decidedAt: range }, orderBy: { decidedAt: 'asc' } }))
    .filter((t) => t.input?.mode !== 'daily');
  return {
    website: gitCommits(WEBSITE_REPO, since, until),
    dashboard: gitCommits(ROOT, since, until),
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
section:
- "website" = งานบนเว็บ Tasaki (จาก commit ของเว็บ) method = ""
- "system" = ฟีเจอร์หรือการแก้ของแดชบอร์ดการตลาด (จาก commit ของแดชบอร์ด) ขึ้นต้นด้วยชื่อหน้า เช่น "หน้า 🧑‍💼 ทีม AI: ..." method = ""
- "ads" = งานโฆษณา: ผลที่ดึงมาดู การตัดสินใจ ไอเดียที่เลือก/ไม่เลือก ครีเอทีฟที่ทำ ใส่ตัวเลขสำคัญ method = "ตัดสินใจ" ถ้าเป็นการตัดสินใจ ไม่งั้น "ทีม AI (ชื่อ Agent)"
  · งานที่หนิงอนุมัติต้องมีครบทุกชิ้น ห้ามตกหล่น (เช่น สรุปผลโฆษณา ใส่ยอดเงินและตัวเลขหลัก)
  · ร่างภาพ/คลิปที่หนิงปัดตก คือการฝึกทีม ให้รวมเป็นรายการเดียวต่อวัน สั้นๆ ว่าลองอะไรไปกี่ชิ้นและติดเรื่องหลักอะไร ห้ามแยกทีละชิ้น

1) commit ของเว็บ Tasaki:
${fmt(src.website)}

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
  const rows = await prisma.adInsight.findMany({ where: { date: { gte: since } }, orderBy: { date: 'asc' } });
  const dayOf = (r) => r.date.toISOString().slice(0, 10);
  const today = bangkokNow().date;
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
  if (f.status === 'no_data') return f.latest ? `ยังไม่มีข้อมูลโฆษณาใหม่ ข้อมูลล่าสุดคือวันที่ ${f.latest} (ทุกแคมเปญอาจถูกหยุดไว้)` : 'ยังไม่มีข้อมูลโฆษณาในระบบ';
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

const AD_SLOT = '09:05';
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

const AD_CAMPAIGNS = ['Awareness', 'กระตุ้นยอดขาย', 'ความน่าเชื่อถือ'];

// Every real photo of one model, by what it shows (the website admin tags
// gallery photos fcu / cu / remote; the main image counts as the FCU when no
// gallery photo is tagged so). A script answers "which file is the outdoor
// unit" exactly, so no AI has to search or guess.
// "fcu" is also the main photo of products that aren't split units (chillers,
// cassettes …), so it's named for both.
const ROLE_TH = { fcu: 'ตัวเครื่องหลัก/คอยล์เย็น (ตัวในห้อง)', cu: 'คอยล์ร้อน (ตัวนอกบ้าน)', remote: 'รีโมต' };
async function productPhotos(tasakiWebPool, model) {
  if (!model) return [];
  const { rows } = await tasakiWebPool.query('select "imageUrl", "imageUrls", "galleryImageMeta" from "Product" where model = $1 and "deletedAt" is null limit 1', [model]);
  const p = rows[0];
  if (!p) return [];
  const meta = p.galleryImageMeta || {};
  const local = (u) => path.join(WEBSITE_REPO, 'public', u);
  const tagged = (p.imageUrls || []).filter((u) => ROLE_TH[meta[u]?.role]).map((u) => ({ role: meta[u].role, url: u, file: local(u) }));
  if (!tagged.some((t) => t.role === 'fcu') && p.imageUrl) tagged.unshift({ role: 'fcu', url: p.imageUrl, file: local(p.imageUrl) });
  const seen = new Set();
  return tagged.filter((t) => fs.existsSync(t.file) && !seen.has(t.role) && seen.add(t.role));
}

// ─── Creative devices ───────────────────────────────────────────────────────
// What makes the ads she likes (design-references/) stop a thumb: not a prettier
// room but a device — scale play, weightless people, cut-away rooms, colour-coded
// personas. A script offers PLAN three it hasn't used lately; PLAN must pick one
// and give a hook. The reference pictures are competitors' ads: they go to GEN
// only as composition/energy guides, never to copy.
const REF_DIR = path.join(ROOT, 'design-references');
const refPath = (f) => (f.includes('/') ? path.join(ROOT, f) : path.join(REF_DIR, f));
// Her approved formula (café Solar ad, 2026-10-22): the default for every
// picture. The other devices are only used when she picks one herself.
const BLUEPRINT = 'shop-blueprint';
// From 2026-10-28 she is the planner herself (her words: "นับแต่นี้ ฉันจะเป็นแผน"):
// no ผัง planning call, no ผัง scoring loop. Her prompt is the scene brief.
const HER_PLAN_KEY = '__her_plan';
// Composition changes from ad to ad (the headline never does): the variant after
// the one used last, remembered in a hidden setting; a ↻ redo keeps its own.
async function nextVariant(prisma, task) {
  if (task.result?.work?.plan?.variant) return VARIANTS.find((v) => v.key === task.result.work.plan.variant) || VARIANTS[0];
  const row = await prisma.agentSetting.findUnique({ where: { agent: '__last_variant' } }).catch(() => null);
  const i = (Math.max(-1, VARIANTS.findIndex((v) => v.key === row?.rules)) + 1) % VARIANTS.length;
  await prisma.agentSetting.upsert({ where: { agent: '__last_variant' }, update: { rules: VARIANTS[i].key }, create: { agent: '__last_variant', rules: VARIANTS[i].key } });
  return VARIANTS[i];
}
async function herIsPlan(prisma) {
  const row = await prisma.agentSetting.findUnique({ where: { agent: HER_PLAN_KEY } }).catch(() => null);
  return row ? row.rules !== 'off' : true;
}
function herPlan(task, product, photos) {
  const hero = { role: product.role || photos[0]?.role || 'fcu', what: product.model, matchesAttached: true, why: '' };
  return {
    hero, supports: [], device: BLUEPRINT, hook: '', proof: { title: '', items: [], dropped: 0 }, alternatives: [],
    lightConfidence: 'low', measured: [], camera: '', concept: String(task.prompt || '').slice(0, 300), light: 'front', lightSource: 'her', planLight: 'front',
    background: { prompt: sceneBrief(frame(), String(task.prompt || '').trim()) }, elements: [],
    product: { rect: [376, 872, 337, 150] }, headlineZone: [60, 470, 960, 300], subheadZone: [60, 760, 640, 60], textStyles: [], kit: [], logoPanel: '',
  };
}
// The example ads behind a device, so ผัง sees them and doesn't plan from words alone.
function deviceRefFiles(keys, max = 4) {
  return [...new Set(keys.flatMap((k) => (CREATIVE_DEVICES.find((d) => d.key === k) || {}).refs || []))]
    .map(refPath).filter((f) => fs.existsSync(f)).slice(0, max);
}
function deviceRefNote(start, files) {
  return files.length ? `\nภาพแนบลำดับที่ ${start}–${start + files.length - 1} คือแอดตัวอย่างของแนวทางสร้างสรรค์ (${files.map((f) => path.basename(f)).join(', ')}) ใช้เป็นมาตรฐานความกล้า สเกล และพลังงานของภาพ ห้ามคัดลอกโลโก้ ตัวหนังสือ สินค้า หรือสีแบรนด์ของเขา` : '';
}
const CREATIVE_DEVICES = [
  { key: BLUEPRINT, label: 'สูตรแอดร้านกาแฟที่หนิงชอบ', desc: 'ถ่ายหน้าร้าน/ห้องใกล้ๆ ให้ร้านเต็มภาพ ไม่ถอยไกล คน 1 คนขนาดกลางหน้าตาเป็นมิตรอยู่หลังกระจก/เคาน์เตอร์ แอร์จริงตัวใหญ่ราว 37% ของความกว้างภาพบนผนังในร้านที่มองเห็นผ่านกระจก ของจริงที่เล่าจุดขาย (เช่น แผงโซลาร์บนหลังคา เสาไฟ) เส้นพลังงานเรืองแสงโยงเข้าแอร์ ใบค่าไฟ/ป้ายรุ่นเป็นของประกอบ ท้องฟ้าด้านบนเว้นให้พาดหัวตัวใหญ่ ทำตามภาพตัวอย่างนี้ได้ทุกครั้ง ไม่ต้องหนีให้ต่าง', refs: ['public/uploads/agent-images/cafe-solar-test/export/cafe-solar-9x16.png', 'public/uploads/agent-images/barber-solar-ad/scene.png'] },
  { key: 'giant-scale', label: 'สเกลเกินจริง', desc: 'ของเล็กถูกขยายเป็นยักษ์ในห้อง (เช่น มือถือ รีโมต หรือฟินคอยล์ขนาดเท่าตู้) คนตัวเล็กอยู่เทียบ ใช้อธิบายฟีเจอร์ได้ในมองเดียว', refs: ['tasaki-giant-phone.jpg', 'daikin-giant-phone.jpg'] },
  { key: 'floating', label: 'ลอยตัวไร้น้ำหนัก', desc: 'คนลอยหรือกระโดดกลางห้อง มุมกว้างมองลงจากด้านบนหรือเฉียง สื่อสบายเบาตัว พลังงานสูง', refs: ['daikin-floating-live.jpg'], fits: ['fcu', 'remote'] },
  { key: 'iso-rooms', label: 'ห้องตัดขวางไอโซเมตริก', desc: 'หลายห้อง/หลายสถานการณ์ในภาพเดียว แต่ละห้องสีต่างกันและเล่าเรื่องต่างกัน มองจากมุมสูงแบบตุ๊กตา', refs: ['daikin-iso-rooms.jpg'] },
  { key: 'persona-panels', label: 'แผงสีแยกบุคลิก', desc: '3–4 แผงสีสด แต่ละแผงเป็นคนคนละบุคลิกหรือคนละสถานการณ์ใช้ชีวิต สินค้าอยู่ด้านบนเหนือทุกแผง', refs: ['daikin-dark-panels.jpg', 'daikin-four-personas.jpg'] },
  { key: 'dark-drama', label: 'พื้นเข้มไฟสด', desc: 'พื้นหลังดำหรือเข้ม ไฟสีสดตัดกับสินค้า ตัวหนังสือตัวใหญ่หนา ให้ความรู้สึกพรีเมียมและดุดัน', refs: ['daikin-dark-panels.jpg'] },
  { key: 'light-beams', label: 'ลำแสงหรือสายลมเต็มภาพ', desc: 'ลำแสง/เส้นลมสีฟ้าแผ่จากสินค้าเต็มภาพ คนเคลื่อนไหวอยู่ในลำแสง ท่าไดนามิก (เช่น เดินก้าวยาว ชี้นิ้ว)', refs: ['tasaki-cool-beams-phone.jpg'], fits: ['fcu'] },
  { key: 'group-studio', label: 'กลุ่มคนในสตูดิโอสว่าง', desc: '3–4 คนต่างบุคลิก ท่าไดนามิก นั่ง/ยืนบนแท่งบล็อกสีขาว พื้นหลังขาวสะอาดเล็กน้อย', refs: ['daikin-group-voucher.jpg', 'daikin-four-personas.jpg'] },
  { key: 'tiles-3d', label: 'ไอคอน 3 มิติลอยรอบสินค้า', desc: 'กล่องไอคอนมุมมนสามมิติลอยรอบสินค้าและคน แต่ละกล่องบอกฟีเจอร์หนึ่งอย่าง มีเงานุ่ม', refs: ['daikin-group-voucher.jpg'] },
  { key: 'proof-sheet', label: 'แผ่นพิสูจน์จุดขาย', desc: 'ฉากชายหาด/สถานที่จริงด้านบนมีสินค้าจริง พาดหัวใหญ่ ภาพซูมของส่วนสำคัญเป็นพระเอกกลางภาพ แล้วแถบข้อมูลพิสูจน์ด้านล่าง (ใช้เฉพาะข้อมูลจริงของสินค้า)', refs: ['daikin-corrosion-proof.jpg'], fits: ['cu', 'fcu'] },
  { key: 'macro-story', label: 'ซูมใกล้เล่าเรื่อง', desc: 'ภาพมาโครของส่วนที่เป็นจุดขาย (ฟินคอยล์ ละอองไอเกลือ) เป็นพระเอกเต็มภาพ สินค้าจริงเป็นภาพรองที่บอกว่ามาจากเครื่องไหน', refs: [], fits: ['cu'] },
  { key: 'worker-story', label: 'ช่างหรือเจ้าของบ้านกับตัวเครื่อง', desc: 'คนทำกิจกรรมกับตัวเครื่องจริง (ตรวจ ล้าง ติดตั้ง สัมผัส) บรรยากาศจริง มีเรื่องเล่า ไม่ใช่ยืนยิ้มข้างเครื่อง', refs: [], fits: ['cu'] },
];
const CLICHES = 'คนยืนหรือนั่งยิ้มมองกล้องข้างสินค้า ชุดเสื้อขาวกางเกงกรมท่า ห้องนั่งเล่นสว่างเรียบๆ ที่มีโซฟา คนเดียวในภาพมุมกล้องระดับสายตา';

async function recentDevices(prisma, n = 6) {
  const rows = await prisma.agentTask.findMany({ where: { agent: 'image' }, orderBy: { createdAt: 'desc' }, take: 20 }).catch(() => []);
  const out = [];
  for (const t of rows) {
    const d = t.result?.plan?.device || t.result?.work?.plan?.device;
    if (d) out.push(d);
    if (out.length >= n) break;
  }
  return out;
}

// For ideas: every visible model -> the photo roles it really has on disk.
async function catalogRoles(tasakiWebPool) {
  const { rows } = await tasakiWebPool.query('select model, "imageUrl", "imageUrls", "galleryImageMeta" from "Product" where not hidden and "deletedAt" is null');
  const out = new Map();
  for (const p of rows) {
    const meta = p.galleryImageMeta || {};
    const exists = (u) => u && fs.existsSync(path.join(WEBSITE_REPO, 'public', u));
    const roles = new Set((p.imageUrls || []).filter((u) => ROLE_TH[meta[u]?.role] && exists(u)).map((u) => meta[u].role));
    if (!roles.has('fcu') && exists(p.imageUrl)) roles.add('fcu');
    out.set(p.model.trim(), [...roles]);
  }
  return out;
}

// After Sonnet writes ideas, a script checks what can be checked exactly:
// the model exists, the hero photo really exists, supports are real, and the
// idea isn't a repeat of one she already saw.
async function verifyIdeas(result, task, prisma) {
  const roles = await catalogRoles(deps.tasakiWebPool).catch(() => new Map());
  const past = await adLearnings(prisma).catch(() => []);
  const notes = [];
  const ideas = [];
  for (const idea of result.ideas || []) {
    const model = String(idea.productModel || '').trim();
    const have = roles.get(model);
    if (!have) { notes.push(`ตัด "${idea.title}" เพราะไม่มีรุ่น ${model} ในเว็บ`); continue; }
    if (!have.includes(idea.heroRole)) { notes.push(`ตัด "${idea.title}" เพราะ ${model} ไม่มีรูปจริงของ${ROLE_TH[idea.heroRole] || idea.heroRole}`); continue; }
    const supportRoles = [...new Set((idea.supportRoles || []).filter((r) => r !== idea.heroRole && have.includes(r)))].slice(0, 2);
    const warn = [];
    if (String(idea.headline || '').length > 32) warn.push('พาดหัวยาวเกิน 32 ตัวอักษร');
    const twin = past.find((l) => similar(l.title, idea.title) > 0.6 || similar(l.title, idea.headline) > 0.6);
    if (twin) warn.push(`คล้ายไอเดียเก่า "${twin.title}" (${twin.picked ? 'เคยเลือก' : `เคยไม่เลือก${twin.reason ? `: ${twin.reason}` : ''}`})`);
    ideas.push({ ...idea, productModel: model, supportRoles, warnings: warn });
  }
  if (ideas.length) await reviewIdeas(ideas, task, prisma, notes);
  return { ...result, ideas, review: notes.join(' · ') };
}

const IDEA_FIELDS = ['headline', 'subhead', 'primaryText', 'proof'];

async function productFacts(tasakiWebPool, models) {
  const { rows } = await tasakiWebPool.query('select model, description, "catalogContent" from "Product" where model = any($1) and "deletedAt" is null', [models]);
  return rows.map((r) => {
    const c = r.catalogContent || {};
    const lists = ['coverBullets', 'standard', 'standardFanCoil', 'standardCondensing', 'protection', 'option', 'optionFanCoil']
      .flatMap((k) => (Array.isArray(c[k]) ? c[k] : []).map((x) => (typeof x === 'string' ? x : x?.title || '')).filter(Boolean));
    return `${r.model}: คำอธิบายในเว็บ: ${r.description.replace(/\s+/g, ' ').trim()}\n  ข้อความในแคตตาล็อก: ${lists.join(' / ') || '-'}`;
  }).join('\n');
}

async function reviewIdeas(ideas, task, prisma, notes) {
  const facts = await productFacts(deps.tasakiWebPool, [...new Set(ideas.map((x) => x.productModel))]).catch(() => '');
  const shown = [];
  for (const [i, idea] of ideas.entries()) {
    const ph = (await productPhotos(deps.tasakiWebPool, idea.productModel).catch(() => [])).find((x) => x.role === idea.heroRole);
    if (ph) shown.push({ i, file: ph.file });
  }
  const reviewer = {
    speaker: 'adideas', rulesAgent: 'adideas', model: 'opus', tools: [], images: shown.map((x) => x.file),
    schema: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: {
      index: { type: 'number' }, verdict: { type: 'string', enum: ['ok', 'fix', 'drop'] }, why: { type: 'string' }, askHer: { type: 'string' },
      ...Object.fromEntries(IDEA_FIELDS.map((f) => [f, { type: 'string' }])),
    }, required: ['index', 'verdict', 'why', 'askHer', ...IDEA_FIELDS] } } }, required: ['items'] },
    async buildPrompt() {
      return `คุณคือผู้ตรวจทาน (Claude) ไอเดียแอดภาพนิ่งที่ IDE เขียนมา ตรวจตรรกะก่อนถึงหนิง แก้เท่าที่จำเป็น
คำสั่งงานของหนิงรอบนี้: ${String(task.prompt || '').slice(0, 1500)}
คำสั่งแก้ล่าสุดของหนิง (มาก่อนโจทย์เดิมและกฎค่าเริ่มต้นในเรื่องที่สั่งแก้): ${String(task.feedback || '').slice(0, 3000) || '(ไม่มี)'}
ถ้าหนิงให้ข้อความโฆษณามาโดยตรง ให้รักษาข้อความนั้นในร่าง หากเป็นคำอ้างเชิงตัวเลขที่ยังไม่มีหลักฐานในข้อมูล ให้แยกสิ่งที่ต้องยืนยัน/เงื่อนไขก่อนเผยแพร่ไว้ใน askHer ห้ามเงียบแล้วเปลี่ยนมุมขาย ห้ามรับรองว่าใช้ได้กับทุกกรณี และห้ามแต่งหลักฐานเพิ่ม
ถ้าคำสั่งคือให้แก้ไอเดียเดิมที่หนิงเลือกไว้ ห้ามตัดหรือติเพราะซ้ำมุมเดิม
ใช้ fix ก่อนเสมอ drop ได้เฉพาะเมื่อแก้แล้วก็ยังผิดหลักจริงๆ
ข้อมูลสินค้าจริงจากเว็บ (ใช้ยืนยันทุกคำอ้าง):
${facts || '(ไม่มี)'}
ถ้าข้อมูลสินค้าขัดกันเอง หรือคำอ้างในไอเดียขึ้นกับข้อมูลที่ขัดกัน ห้ามเดา ให้ใส่คำถามสั้นๆ ถึงหนิงใน askHer (ไม่มีให้ "")
ตรวจทุกข้อ:
1. ข้อเท็จจริงของสินค้าและหลักการแอร์ เช่น คอยล์ร้อนอยู่นอกบ้านและเป่าลมร้อนออก ห้ามมีลมเย็น / คอยล์เย็นติดผนังในห้องและมีลมเย็น / ห้ามอ้างสเปกที่ไม่มีในข้อมูล
2. proof (จุดขายที่ภาพต้องพิสูจน์) ต้องทำให้เห็นในภาพได้จริง ภาพคิดโดยฝ่ายผัง ไม่ใช่ไอเดีย ตรวจแค่ว่าจุดขายตรงกับรูปจริงที่แนบ (${shown.map((x, n) => `ภาพแนบที่ ${n + 1} = พระเอกของไอเดีย ${x.i}`).join(', ') || 'ไม่มีภาพแนบ'}) ถ้าจุดขายมองไม่เห็นในรูปจริง (เช่น แผงฟินอยู่ด้านหลัง) ให้ proof บอกว่าต้องพิสูจน์ด้วยกราฟิก ห้ามเขียนว่ารูปจริงจะเห็น
3. เป็นแอดภาพนิ่ง ห้ามมีกฎของคลิปวิดีโอ (safe zone, ซับ)
4. headline, subhead, primaryText ต้องพูดถึงชิ้นที่เป็นพระเอกให้ถูก และไม่ขัดกับภาพ
5. เทียบกับเหตุผลที่หนิงเคยปัดตก (อยู่ในกฎและบทเรียนด้านล่าง) อย่าให้พลาดแบบเดิม
verdict: ok = ใช้ได้ (ช่องข้อความใส่ "" ทั้งหมด), fix = แก้ (ใส่เฉพาะช่องที่แก้เป็นข้อความใหม่ทั้งช่อง ช่องที่ไม่แก้ใส่ ""), drop = ผิดจนแก้ไม่ได้ why บอกสั้นๆ ว่าแก้อะไรเพราะอะไร
ห้ามเปลี่ยน productModel, heroRole, supportRoles

ไอเดีย:
${ideas.map((idea, i) => `${i}. ${JSON.stringify({ title: idea.title, productModel: idea.productModel, heroRole: idea.heroRole, supportRoles: idea.supportRoles, ...Object.fromEntries(IDEA_FIELDS.map((f) => [f, idea[f]])) })}`).join('\n')}`;
    },
  };
  try {
    const { result } = await runLanguageAgent(reviewer, { ...task, sessionId: null, feedback: '', input: { ...(task.input || {}), attachments: [] } }, prisma, deps);
    for (const item of result.items || []) {
      const idea = ideas[Number(item.index)];
      if (!idea) continue;
      if (String(item.askHer || '').trim()) idea.askHer = item.askHer.trim();
      if (item.verdict === 'drop') { idea.dropped = true; notes.push(`ผู้ตรวจทานตัด "${idea.title}": ${item.why}`); continue; }
      if (item.verdict !== 'fix') continue;
      const changed = IDEA_FIELDS.filter((f) => String(item[f] || '').trim() && item[f].trim() !== String(idea[f] || '').trim());
      for (const f of changed) idea[f] = item[f].trim();
      if (changed.length) notes.push(`ผู้ตรวจทานแก้ "${idea.title}": ${item.why}`);
    }
    for (let i = ideas.length - 1; i >= 0; i--) if (ideas[i].dropped) ideas.splice(i, 1);
  } catch (e) {
    notes.push(`ตรวจทานด้วย Opus ไม่สำเร็จ (${e.message.slice(0, 80)}) ใช้ผลที่สคริปต์ตรวจแล้ว`);
  }
}

// Raised when the picture can't be made from real files yet: the job waits
// for the file instead of failing or inventing the product.
class WaitingForFile extends Error {}

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

async function adPerformance(prisma, days) {
  const rows = await prisma.adInsight.findMany({ where: { date: { gte: new Date(Date.now() - days * 86400000) } } });
  const by = new Map();
  for (const r of rows) {
    const key = `${r.campaignName} | ${r.creativeName || r.adId}`;
    const a = by.get(key) || { spend: 0, clicks: 0, impressions: 0, reach: 0 };
    a.spend += r.spend; a.clicks += r.clicks; a.impressions += r.impressions; a.reach += r.reach;
    by.set(key, a);
  }
  return [...by].map(([k, a]) => `${k} | ฿${a.spend.toFixed(0)} | คลิก ${a.clicks} | CTR ${a.impressions ? ((a.clicks / a.impressions) * 100).toFixed(2) : 0}% | CPC ${a.clicks ? `฿${(a.spend / a.clicks).toFixed(2)}` : '-'}`).join('\n');
}

// Her past picks/skips on ad ideas, newest first — the "learning" fed back in.
async function adLearnings(prisma, limit = 60) {
  const tasks = await prisma.agentTask.findMany({
    where: { agent: 'adideas', status: 'done' }, orderBy: { decidedAt: 'desc' }, take: 30,
  });
  return tasks
    .flatMap((t) => (t.result?.decisions || []).map((d) => ({ ...d, date: t.decidedAt })))
    .slice(0, limit);
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
const DEFAULT_RULES = {
  adideas: `- เสนอทีละ 1 ไอเดียต่อรอบเท่านั้น ให้ผู้ดูแลตัดสินก่อน แล้วรอบถัดไปค่อยเสนอใหม่โดยเรียนรู้จากเหตุผลล่าสุด
- พาดหัวสั้นมาก 2–4 คำ (ไม่เกินประมาณ 12 ตัวอักษรไทย) อ่านจบใน 1 วินาที เช่น "เย็นล้ำ สั่งได้" "อากาศสะอาด ทุกลมหายใจ"
- บรรทัดรองสั้น 1 บรรทัด ไม่เกิน 8 คำ เช่น "ควบคุมง่าย สั่งได้ทุกที่ ทุกเวลา"
- ข้อความโฆษณา (primary text) ไม่เกิน 2–3 ประโยคสั้น`,
  layout: LAYOUT_RULES,
  // ประกอบ has no AI: these "- ชื่อ: ค่า" lines are its brand kit, read by
  // brandKit() below. Fonts/colours come from tasaki-web (brand.md + the
  // Frutiger Thai files the site ships), not from anyone's guess.
  motion: `- ความยาวคลิป (วินาที): 6
- ซูมเข้าทั้งฉาก (%): 6
- แอร์สแนปเข้าที่วินาที: 0.4
- ระยะเวลาสแนป (วินาที): 0.2
- แอร์ตกจากด้านบน (px): 90`,
  assemble: ASSEMBLE_RULES,
  image: IMAGE_RULES,
  vector: VECTOR_RULES,
};

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

const MOTION_KEYS = {
  'ความยาวคลิป (วินาที)': 'duration', 'ซูมเข้าทั้งฉาก (%)': 'push', 'แอร์สแนปเข้าที่วินาที': 'snapAt',
  'ระยะเวลาสแนป (วินาที)': 'snapLen', 'แอร์ตกจากด้านบน (px)': 'drop',
};

function parseKit(text, keys) {
  return Object.fromEntries(text.split('\n').map((line) => {
    const m = /^\s*-?\s*([^:]+):\s*(.+)$/.exec(line);
    const key = m && keys[m[1].trim()];
    return key ? [key, m[2].trim()] : null;
  }).filter(Boolean));
}

async function motionKit(prisma) {
  const kit = { ...parseKit(DEFAULT_RULES.motion, MOTION_KEYS), ...parseKit(await agentRules(prisma, 'motion'), MOTION_KEYS) };
  const num = (v, min, max, d) => Math.min(max, Math.max(min, Number.isFinite(Number(v)) ? Number(v) : d));
  return {
    duration: num(kit.duration, 2, 30, 6), push: num(kit.push, 0, 30, 6) / 100,
    snapAt: num(kit.snapAt, 0, 10, 0.4), snapLen: num(kit.snapLen, 0.03, 2, 0.2), drop: num(kit.drop, 0, 600, 90),
  };
}

const KIT_KEYS = {
  'ฟอนต์พาดหัว': 'headlineFont', 'ฟอนต์บรรทัดรอง': 'subheadFont', 'ฟอนต์ชื่อรุ่น': 'modelFont',
  'สีพาดหัวบรรทัดแรก': 'headline1', 'สีพาดหัวบรรทัดสอง': 'headline2',
  'สีบรรทัดรอง': 'subhead', 'สีชื่อรุ่น': 'model', 'สีแถบโลโก้': 'panel',
};

// ประกอบ's settings → { headlineFont: {font, style}, headline1: '#fff', … }.
async function brandKit(prisma) {
  const parse = (text) => Object.fromEntries(text.split('\n').map((line) => {
    const m = /^\s*-?\s*([^:]+):\s*(.+)$/.exec(line);
    const key = m && KIT_KEYS[m[1].trim()];
    if (!key) return null;
    const value = m[2].trim();
    if (key.endsWith('Font')) {
      const [font, style] = value.split('/').map((x) => x.trim());
      return [key, { font, style: style || 'Bold' }];
    }
    return [key, value];
  }).filter(Boolean));
  return { ...parse(DEFAULT_RULES.assemble), ...parse(await agentRules(prisma, 'assemble')) };
}

function rulesNote(rules) {
  return rules.trim() ? `\n\nกฎประจำจากผู้ดูแล: ใช้เป็นค่าเริ่มต้น คำสั่งงานและคำสั่งแก้ล่าสุดของผู้ดูแลมาก่อนกฎเดิมเฉพาะเรื่องที่ระบุ เช่น จำนวนไอเดีย กลุ่มเป้าหมาย และข้อความที่ให้ใช้ รักษากฎส่วนอื่นที่ไม่ขัดกัน ห้ามแต่งข้อเท็จจริงหรือหลักฐาน\n${rules.trim()}\n` : '';
}

// ─── Roster ──────────────────────────────────────────────────────────────────
// engine: which CLI runs it. tools: Claude Code tools it may use (all
// read-only). schema: the JSON it must hand back. onApprove: what the server
// does once the user approves (default: nothing, the draft is the deliverable).
export const AGENTS = {
  // Image ads are the one thing she can take from idea to live entirely on her
  // own, so this is the team's main idea job. Every pick/skip (with her reason)
  // is kept on the task and fed back into the next round — see adLearnings().
  adideas: {
    name: 'ปิ๊ง',
    role: 'ฝ่ายไอเดียแอด (ภาพ)',
    about: 'คิดมุมขาย พาดหัว และข้อความโฆษณา โดยไม่คิดภาพ (ภาพทั้งหมดผังเป็นคนคิด) อ่านรายการสินค้าจริงและรูปจริงที่แต่ละรุ่นมี (คอยล์เย็น/คอยล์ร้อน/รีโมต) จากฐานข้อมูลเว็บ ผลแอด 30 วันล่าสุด และเหตุผลที่คุณเคยเลือก/ไม่เลือก แล้วเสนอไอเดียแอดภาพนิ่ง แต่ละไอเดียระบุพระเอก (รูปจริงชิ้นไหน) สิ่งที่ต้องเห็นในภาพ ตัวรอง แคมเปญ พาดหัว ข้อความโฆษณา และภาพ สคริปต์ตรวจว่ารูปมีจริงและไม่ซ้ำไอเดียเก่าก่อนส่งถึงคุณ เลือกแล้วผังทำตามโดยไม่ต้องเดาใหม่',
    avatar: '/agent-assets/takujung-v2/takujung-adideas.png',
    engine: 'claude',
    model: 'sonnet',
    // No file reading: it once picked a video rule (safe zone) out of project
    // notes. Everything it needs is in the prompt; web search stays for trends.
    tools: ['WebSearch', 'WebFetch'],
    placeholder: 'เช่น ขอไอเดียแอดภาพ 5 แบบ เน้นกระตุ้นยอดขายแอร์ติดผนังอินเวอร์เตอร์',
    async buildPrompt(task, prisma, deps) {
      const [products, perf, learnings, roles] = await Promise.all([
        productCatalog(deps.tasakiWebPool),
        adPerformance(prisma, 30),
        adLearnings(prisma),
        catalogRoles(deps.tasakiWebPool).catch(() => new Map()),
      ]);
      return `${BRAND_NOTE}

หน้าที่: เสนอไอเดียโฆษณาแบบภาพนิ่ง (Facebook/Instagram) ให้ผู้ดูแลการตลาดเลือก งานนี้เธอทำเองคนเดียวทั้งหมด จึงห้ามเสนออะไรที่ต้องพึ่งฝ่ายอื่น ต้องถ่ายคน หรือต้องออกไปถ่ายหน้างาน
ภาพจะทำจาก "ฉากที่ AI สร้าง + รูปสินค้าจริงวางทับ" ดังนั้นสินค้าต้องเป็นรุ่นที่มีในรายการด้านล่างเท่านั้น (ใส่ model ให้ตรงตัวอักษร) ทุกไอเดียต้องบอกว่า "พระเอก" คือรูปจริงชิ้นไหน และ "จุดขายที่ภาพต้องพิสูจน์" คืออะไร (ภาพทั้งหมด ฉาก คน แสง ฝ่ายผังเป็นคนคิดเอง ห้ามเขียนคำบรรยายภาพ)
ทุกไอเดียต้องทำมาเพื่อแอดโดยเฉพาะ (หยุดนิ้วได้ใน 1 วินาที มีมุมขายชัด) ไม่ใช่คอนเทนต์ออร์แกนิก
campaign เลือกจาก: ${AD_CAMPAIGNS.join(', ')}
ห้ามใช้ข้อมูลสเปกหรือตัวเลขที่ไม่มีในรายการสินค้า

ทุกไอเดียต้องตัดสินให้ชัด เพราะทีมภาพจะทำตามนี้ตรงๆ:
- heroRole = รูปจริงที่เป็นพระเอก เลือกจาก "รูปจริงที่มี" ของรุ่นนั้นเท่านั้น (fcu = คอยล์เย็น/ตัวในห้อง, cu = คอยล์ร้อน/ตัวนอกบ้าน, remote = รีโมต) จุดขายอยู่ที่ชิ้นไหน ชิ้นนั้นคือพระเอก เช่น ฟินคอยล์ทนไอเกลือของคอยล์ร้อน = cu
- proof = จุดขายที่ภาพต้องพิสูจน์ให้คนดูเชื่อพาดหัว เขียนเป็นข้อความสั้นๆ ว่าเรื่องอะไร (เช่น "ฟินคอยล์เคลือบสีฟ้าป้องกันการกัดกร่อนจากไอเกลือ") ห้ามบอกว่าภาพหน้าตาเป็นอย่างไร ฝ่ายผังจะคิดวิธีแสดงเอง
- supportRoles = รูปจริงตัวรอง (ไม่เกิน 2 ไม่ซ้ำพระเอก) ใส่เฉพาะเมื่อช่วยขายจริง ไม่จำเป็นให้ว่าง
- primaryText ต้องพูดถึงชิ้นที่เป็นพระเอกให้ถูก (คอยล์ร้อนอยู่นอกบ้าน คอยล์เย็นอยู่ในห้อง) และไม่พูดถึงสิ่งที่ภาพทำไม่ได้
- ถ้ารุ่นนั้นไม่มีรูปจริงของชิ้นที่จุดขายต้องการ ห้ามเสนอไอเดียนั้น

สินค้าที่มี (model | ชื่อ | ประเภท | BTU | รูปจริงที่มี | คำอธิบาย):
${products.map((p) => `${p.model} | ${p.nameTh} | ${p.type} | ${p.btu} | ${(roles.get(p.model) || []).map((r) => ROLE_TH[r]).join(', ') || 'ไม่มี'} | ${p.description}`).join('\n')}

ผลแอดที่ผ่านมา (30 วัน รวมต่อชิ้นงาน):
${perf || '(ไม่มีข้อมูล)'}

สิ่งที่ผู้ดูแลเคยเลือก/ไม่เลือก และเหตุผล (เรียนรู้จากตรงนี้ อย่าเสนอแบบที่เคยถูกปัดตกด้วยเหตุผลเดิมซ้ำ):
${learnings.map((l) => `- ${l.picked ? 'เลือก' : 'ไม่เลือก'}: ${l.title}${l.reason ? ` — เหตุผล: ${l.reason}` : ''}`).join('\n') || '(ยังไม่มี)'}

คำสั่งงาน: ${task.prompt || 'เสนอไอเดียแอดภาพ 1 แบบ'}`;
    },
    schema: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        ideas: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              campaign: { type: 'string', enum: AD_CAMPAIGNS },
              productModel: { type: 'string' },
              heroRole: { type: 'string', enum: ['fcu', 'cu', 'remote'] },
              supportRoles: { type: 'array', items: { type: 'string', enum: ['fcu', 'cu', 'remote'] } },
              proof: { type: 'string' },
              headline: { type: 'string' },
              subhead: { type: 'string' },
              primaryText: { type: 'string' },
              why: { type: 'string' },
            },
            required: ['title', 'campaign', 'productModel', 'heroRole', 'supportRoles', 'proof', 'headline', 'subhead', 'primaryText', 'why'],
          },
        },
      },
      required: ['summary', 'ideas'],
    },
    decides: true,
    async verify(result, task, prisma) { return verifyIdeas(result, task, prisma); },
    approveLabel: 'ยืนยัน แล้วส่งไอเดียที่เลือกไปทำภาพ',
    async onApprove(task, body, { prisma, invalidateCache, tasakiWebPool, logEvent: log }) {
      const ideas = task.result?.ideas || [];
      const decisions = ideas.map((idea, i) => {
        const d = (Array.isArray(body.decisions) ? body.decisions : [])[i] || {};
        return { title: idea.title, picked: Boolean(d.picked), reason: typeof d.reason === 'string' ? d.reason.trim() : '' };
      });
      const picked = decisions.map((d, i) => (d.picked ? i : -1)).filter((i) => i >= 0);
      const products = await productCatalog(tasakiWebPool);
      const base = Date.now();
      for (const [n, i] of picked.entries()) {
        const idea = ideas[i];
        const product = products.find((p) => p.model === idea.productModel);
        const graphic = await prisma.graphicDesignCard.create({
          data: {
            title: idea.title.trim(),
            description: `แคมเปญ: ${idea.campaign}\nสินค้า: ${idea.productModel} (พระเอก: ${ROLE_TH[idea.heroRole] || '-'})\nจุดขายที่ภาพต้องพิสูจน์: ${idea.proof || idea.mustShow || '-'}\nพาดหัว: ${idea.headline}\nบรรทัดรอง: ${idea.subhead || '-'}\nข้อความโฆษณา: ${idea.primaryText}${idea.visual ? `\nภาพ: ${idea.visual}` : ''}`,
            column: 'todo',
            usage: ['facebook_ads', 'instagram_ads'],
            order: base + n,
          },
          omit: { imageUrl: true },
        });
        const imageTask = await prisma.agentTask.create({
          data: {
            agent: 'image',
            prompt: `แอด "${idea.title}" (${idea.campaign}) จุดขายที่ภาพต้องพิสูจน์: ${idea.proof || idea.mustShow || idea.why}\nข้อความโฆษณา: ${idea.primaryText}${idea.visual ? `\nแนวภาพจากไอเดียเดิม: ${idea.visual}` : ''}`,
            input: { graphicCardId: graphic.id, productImage: product?.image || null, productModel: idea.productModel, headline: idea.headline, subhead: idea.subhead || '', heroRole: idea.heroRole || null, supportRoles: idea.supportRoles || [], proof: idea.proof || idea.mustShow || '', planOnly: true },
          },
        });
        await log(prisma, 'adideas', `ส่งไอเดีย "${idea.title}" ให้ ${AGENTS.layout.name} วางผังและทำภาพ (พระเอก: ${ROLE_TH[idea.heroRole] || '-'})`, imageTask.id, { kind: 'handoff', toAgent: 'layout' });
      }
      await prisma.agentTask.update({ where: { id: task.id }, data: { result: { ...task.result, decisions } } });
      invalidateCache('graphic-cards');
      // "ขออันถัดไป": the next round starts after this decision is stored, so
      // it already sees the reason she just gave.
      if (body.next) {
        const next = await prisma.agentTask.create({ data: { agent: 'adideas', prompt: task.prompt, input: task.input || {} } });
        await log(prisma, 'you', `ขอไอเดียถัดไปจาก ${AGENTS.adideas.name}`, next.id, { kind: 'handoff', toAgent: 'adideas' });
      }
      return picked.length
        ? `เลือก ${picked.length} ไอเดีย สร้างการ์ดใน Graphic Design และส่งไปทำภาพแล้ว`
        : 'ไม่ได้เลือกไอเดียไหน บันทึกเหตุผลไว้ให้ปิ๊งเรียนรู้แล้ว';
    },
  },

  // Video ideas that need people/other departments/on-site shooting are hers
  // to plan; the team only proposes product-only clips and infographics that
  // can be made at the desk from the website's product data.
  productvideo: {
    name: 'วีดี',
    role: 'ฝ่ายวิดีโอสินค้าล้วน',
    about: 'เสนอไอเดียคลิปแนวตั้งที่ใช้แค่ภาพสินค้า กราฟิก และอินโฟกราฟิก ไม่มีคน ไม่ต้องออกไปถ่าย ใช้ข้อมูลจากรายการสินค้าในฐานข้อมูลเว็บ',
    avatar: '/agent-assets/takujung-v2/takujung-productvideo.png',
    engine: 'claude',
    model: 'sonnet',
    tools: ['Read', 'Grep', 'Glob'],
    placeholder: 'เช่น ไอเดียคลิปอินโฟกราฟิกเทียบ BTU กับขนาดห้อง ใช้สินค้าล้วน ไม่มีคน',
    async buildPrompt(task, prisma, deps) {
      const [products, recent] = await Promise.all([
        productCatalog(deps.tasakiWebPool),
        prisma.card.findMany({ orderBy: { createdAt: 'desc' }, take: 40, select: { title: true } }),
      ]);
      return `${BRAND_NOTE}

หน้าที่: เสนอไอเดียคลิปสั้นแนวตั้ง (9:16) ที่ใช้แค่ภาพสินค้า กราฟิก อินโฟกราฟิก และโมชั่น ทำได้ทั้งหมดในโปรแกรมตัดต่อ
ห้ามมีคน ห้ามต้องออกไปถ่ายหน้างาน ห้ามต้องพึ่งฝ่ายอื่น ใช้เฉพาะข้อมูลจากรายการสินค้าด้านล่าง
แต่ละไอเดียบอก: ชื่อการ์ด, สินค้า (model ตรงตัวอักษร), ลำดับฉากสั้นๆ (scenes) และทำไมคนจะดูจนจบ
ห้ามซ้ำกับการ์ดที่มีอยู่:
${recent.map((c) => `- ${c.title}`).join('\n')}

สินค้าที่มี (model | ชื่อ | ประเภท | BTU | คำอธิบาย):
${products.map((p) => `${p.model} | ${p.nameTh} | ${p.type} | ${p.btu} | ${p.description}`).join('\n')}

คำสั่งงาน: ${task.prompt || 'เสนอไอเดียคลิปสินค้าล้วน 3 แบบ'}`;
    },
    schema: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        ideas: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              productModel: { type: 'string' },
              scenes: { type: 'array', items: { type: 'string' } },
              why: { type: 'string' },
            },
            required: ['title', 'productModel', 'scenes', 'why'],
          },
        },
      },
      required: ['summary', 'ideas'],
    },
    decides: true,
    approveLabel: 'ยืนยัน แล้วสร้างการ์ดที่เลือกในบอร์ด',
    async onApprove(task, body, { prisma, invalidateCache }) {
      const ideas = task.result?.ideas || [];
      const decisions = ideas.map((idea, i) => {
        const d = (Array.isArray(body.decisions) ? body.decisions : [])[i] || {};
        return { title: idea.title, picked: Boolean(d.picked), reason: typeof d.reason === 'string' ? d.reason.trim() : '' };
      });
      const base = Date.now();
      let made = 0;
      for (const [i, d] of decisions.entries()) {
        if (!d.picked) continue;
        const idea = ideas[i];
        await prisma.card.create({
          data: {
            title: idea.title.trim(),
            description: `สินค้า: ${idea.productModel}\n${idea.scenes.map((s, n) => `${n + 1}. ${s}`).join('\n')}\n\n${idea.why}`,
            column: 'idea',
            order: base + made,
            tags: ['product', 'motion'],
          },
        });
        made += 1;
      }
      await prisma.agentTask.update({ where: { id: task.id }, data: { result: { ...task.result, decisions } } });
      invalidateCache('cards');
      return made ? `สร้างการ์ด ${made} ใบในคอลัมน์ไอเดีย` : 'ไม่ได้เลือกไอเดียไหน บันทึกเหตุผลไว้แล้ว';
    },
  },

  caption: {
    name: 'แคป',
    role: 'ฝ่ายแคปชัน',
    about: 'อ่านชื่อ รายละเอียด แท็ก และแพลตฟอร์มของการ์ดที่เลือก แล้วเขียนแคปชันพร้อมแฮชแท็ก',
    avatar: '/agent-assets/takujung-v2/takujung-caption.png',
    engine: 'claude',
    model: 'sonnet',
    tools: ['Read', 'Grep', 'Glob'],
    needsCard: true,
    placeholder: 'เช่น ขอแคปชันสนุกๆ สั้นๆ มีคำถามชวนคอมเมนต์ท้ายโพสต์',
    async buildPrompt(task, prisma) {
      const card = await prisma.card.findUnique({ where: { id: task.input?.cardId || '' } });
      if (!card) throw new Error('ไม่พบการ์ดที่เลือก');
      return `${BRAND_NOTE}

หน้าที่: เขียนแคปชันโพสต์ Facebook/Instagram/TikTok สำหรับคลิปนี้ พร้อมแฮชแท็กท้ายแคปชัน
ชื่อการ์ด: ${card.title}
รายละเอียด (ข้อมูลภายใน ห้ามคัดลอกไปโพสต์ตรงๆ): ${card.description || '-'}
แท็ก: ${card.tags.join(', ') || '-'}
แพลตฟอร์ม: ${card.platforms.join(', ') || '-'}
แคปชันเดิม: ${card.caption || '(ยังไม่มี)'}

คำสั่งงาน: ${task.prompt || 'เขียนแคปชันให้หน่อย'}`;
    },
    schema: {
      type: 'object',
      properties: { caption: { type: 'string' }, note: { type: 'string' } },
      required: ['caption', 'note'],
    },
    approveLabel: 'บันทึกแคปชันลงการ์ด',
    async onApprove(task, body, { prisma, invalidateCache }) {
      const caption = typeof body.caption === 'string' && body.caption.trim() ? body.caption.trim() : task.result?.caption;
      if (!caption) throw new Error('แคปชันว่าง');
      await prisma.card.update({ where: { id: task.input.cardId }, data: { caption } });
      invalidateCache('cards');
      return 'บันทึกแคปชันลงการ์ดแล้ว';
    },
  },

  ads: {
    name: 'แอด',
    role: 'ฝ่ายโฆษณา',
    about: 'อ่านตัวเลขแอดจากหน้า Ads (ย้อนหลังตามจำนวนวันที่เลือก) กับบันทึกสิ่งที่ทำกับบัญชีโฆษณา แล้วสรุปเป็นภาษาง่ายๆ พร้อมข้อเสนอ ทำเองทุกวันทำงานหลัง 09:05 (หลังระบบดึงตัวเลข 08:15): สคริปต์เทียบเมื่อวานกับ 7 วันก่อนและติดธงสิ่งผิดปกติ โมเดลเล็กเขียนสรุปสั้นๆ สคริปต์ตรวจว่าตัวเลขตรงข้อมูลจริง ไม่มีอะไรเปลี่ยนก็ไม่แจ้งซ้ำ ธงสำคัญลงบันทึกหน้า Ads ให้ด้วย',
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
      const lines = rows.map((r) => `${fmtDate(r.date)} | ${r.campaignName} | ${r.creativeName || r.adId} | spend ฿${r.spend.toFixed(2)} | reach ${r.reach} | impr ${r.impressions} | clicks ${r.clicks} | CTR ${r.ctr.toFixed(3)}% | CPC ฿${r.cpc.toFixed(2)}`);
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
    about: 'สรุป "สิ่งที่ทำวันนี้" ลง 3 บันทึก: Tasaki Website Updates (จาก git ของเว็บ), 🛠 Marketing System Updates (จาก git ของแดชบอร์ด) และสรุปสิ่งที่ทำไปแล้วในหน้า Ads (จากงานโฆษณาที่ทีมทำและหนิงตัดสินใจ) ภาษาไทยง่ายๆ แยกตามเรื่อง ใช้เวลาจริง ทำเองทุกวันทำงาน 12:00 และ 16:55 สคริปต์ตรวจวันที่และรายการซ้ำ Claude Opus ตรวจทาน แล้วลงบันทึกให้เลยไม่ต้องรออนุมัติ (ทำแม้กดหยุดทีมไว้)',
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
      for (const e of valid) {
        const when = new Date(e.date);
        const at = Number.isNaN(when.getTime()) ? null : when;
        const text = e.text.trim();
        if (e.section === 'system') { await prisma.marketingChangelog.create({ data: { text, ...(at ? { date: at } : {}) } }); count.system += 1; }
        else if (e.section === 'ads') { await prisma.adActionLog.create({ data: { id: crypto.randomUUID(), text, method: String(e.method || 'ทีม AI').slice(0, 80), ...(at ? { createdAt: at } : {}) } }); count.ads += 1; }
        else { await prisma.websiteChangelog.create({ data: { text, ...(at ? { date: at } : {}) } }); count.website += 1; }
      }
      invalidateCache('website-changelog');
      invalidateCache('marketing-changelog');
      invalidateCache('ad-action-log');
      return `ลงบันทึกแล้ว: เว็บไซต์ ${count.website} · Marketing System ${count.system} · Ads ${count.ads} รายการ`;
    },
  },

  // Image work is a 4-step line (her spec, 2026-10-19):
  //   1. ผัง (Claude) plans what to generate and where every piece goes
  //   2. พิมพ์ (Codex) generates only those pieces: the background plus each
  //      person/prop as a die-cut with a transparent background
  //   3. ประกอบ (VectorCraft) stacks them with the real product photo into a
  //      named-layer document
  //   4. มูฟ (EffectCraft, optional) turns the same layers into a short clip
  // Steps 1–3 run as one "image" task (result.stage says which is active);
  // ผัง and ประกอบ appear on the roster but can't be ordered on their own.
  layout: {
    name: 'ผัง',
    role: 'วางผังภาพ (Claude)',
    about: 'ขั้นที่ 1 และขั้นตรวจของงานภาพ: อ่านโจทย์และขนาดรูปสินค้าจริง แล้วตัดสินใจว่าต้องเจนฉากหลังแบบไหน มีคน/ของประกอบกี่ชิ้น แต่ละชิ้นวางตรงไหน สินค้าอยู่ตรงไหน เว้นที่พาดหัวตรงไหน — พอประกอบเสร็จ ผังจะเปิดดูภาพจริงแล้วให้คะแนนตามกฎด้านล่างและเหตุผลที่หนิงเคยปัดตก ตรวจสั้นๆ ครั้งเดียวเทียบแอดอ้างอิง (ไม่วนให้คะแนนแก้ซ้ำ) แล้วส่งร่างแรกถึงหนิง',
    avatar: '/agent-assets/takujung-v2/takujung-layout.png',
    engine: 'claude',
    // Opus: PLAN judges every finished ad (her choice, 2026-10-19).
    model: 'opus',
    pipelineStage: 'plan',
  },

  // Rebuilds small raster badges/icons/logos as clean vector files with
  // Codex: measure the raster, re-set the text in Frutiger outlines, redraw the
  // icons as geometry (tracing low-res art left broken letters — 2026-10-24).
  vector: {
    name: 'เวก',
    role: 'แกะภาพเป็นเวกเตอร์ (Codex)',
    about: 'แนบภาพ badge ไอคอน หรือโลโก้ที่เป็นไฟล์ภาพ (PNG/JPG/WebP) แล้วเวกจะใช้ Codex สร้างใหม่เป็นไฟล์เวกเตอร์ SVG ที่คมและครบ: วัดตำแหน่งจากภาพจริง พิมพ์ตัวอักษรใหม่ด้วยฟอนต์ Frutiger ของแบรนด์ วาดไอคอนใหม่เป็นเรขาคณิต (ไม่แกะ trace ตรงๆ เพราะภาพเล็กจะขาดๆ แหว่งๆ) ตรวจเทียบกับต้นฉบับเองก่อนส่ง หนิงกดอนุมัติแล้วไฟล์จะเข้าคลัง design-assets/vector-kit/ ให้ประกอบใช้ต่อ',
    avatar: '/agent-assets/takujung-v2/takujung-vector.png',
    engine: 'codex',
    tools: [],
    placeholder: 'แนบภาพที่จะแกะ แล้วพิมพ์ เช่น badge PM 2.5 หน้าแรก เก็บในโฟลเดอร์ badges',
    approveLabel: 'เก็บเข้าคลัง Vector Kit',
    async onApprove(task) {
      const said = String(task.prompt || '').toLowerCase();
      const folder = ['badges', 'logos', 'labels', 'icons', 'shapes'].includes(task.input?.folder) ? task.input.folder
        : /โลโก้|logo/.test(said) ? 'logos' : /ฉลาก|label/.test(said) ? 'labels' : /ไอคอน|icon/.test(said) ? 'icons' : 'badges';
      const dest = path.join(ROOT, 'design-assets', 'vector-kit', folder);
      fs.mkdirSync(dest, { recursive: true });
      const saved = [];
      for (const url of task.result?.svgs || []) {
        const src = path.join(ROOT, 'public', url.split('?')[0]);
        if (!fs.existsSync(src)) continue;
        const name = path.basename(src).startsWith(`${folder.replace(/s$/, '')}-`) ? path.basename(src) : `${folder.replace(/s$/, '')}-${path.basename(src)}`;
        fs.copyFileSync(src, path.join(dest, name));
        saved.push(name);
        // A kit job may also leave single pieces in parts/ beside the sheet.
        const parts = path.join(path.dirname(src), 'parts');
        if (fs.existsSync(parts)) {
          const to = path.join(dest, path.basename(src, '.svg'));
          fs.mkdirSync(to, { recursive: true });
          for (const f of fs.readdirSync(parts).filter((f) => f.endsWith('.svg'))) { fs.copyFileSync(path.join(parts, f), path.join(to, f)); saved.push(`${path.basename(to)}/${f}`); }
        }
      }
      return saved.length ? `เก็บ ${saved.length} ไฟล์ไว้ที่ design-assets/vector-kit/${folder}/: ${saved.join(', ')}` : 'ไม่มีไฟล์ SVG ให้เก็บ';
    },
  },

  image: {
    name: 'พิมพ์',
    role: 'เจนภาพ/ไดคัท (Codex)',
    about: 'ขั้นที่ 2 ของงานภาพ: เจนเฉพาะชิ้นที่ผังสั่ง คือฉากหลังเต็มภาพ และคน/ของแต่ละชิ้นแบบไดคัทพื้นโปร่งใส ไม่วาดสินค้าเอง ไม่จัดวางเอง',
    avatar: '/agent-assets/takujung-v2/takujung-image.png',
    engine: 'codex',
    pipelineStage: 'generate',
    placeholder: 'เช่น แอร์ติดผนังในห้องนอนเด็ก แม่กำลังห่มผ้าให้ลูก โทนฟ้าขาว (เลือกสินค้าด้านบน)',
    approveLabel: 'ใช้ภาพนี้',
    async onApprove(task, body, { prisma, invalidateCache }) {
      return await attachApprovedGraphicImage(task, body, { prisma, invalidateCache, root: ROOT }) || 'เก็บภาพไว้แล้ว';
    },
  },

  assemble: {
    name: 'ประกอบ',
    role: 'ประกอบเลเยอร์ (VectorCraft)',
    about: 'ประกอบภาพตามผัง และใช้ AI วางแผนแก้ไฟล์ VectorCraft จริงตามคำสอน เลือกงานต้นทางแล้วสั่งแก้ หรือเปิดสำเนาให้คุณแก้และบันทึกเป็นตัวอย่าง เปรียบเทียบตำแหน่ง ฟอนต์ สี และเอฟเฟกต์ก่อน–หลัง บทเรียนจะใช้กับงานแก้ครั้งถัดไปเมื่อคุณตรวจผ่านเท่านั้น ไม่ได้เฝ้าดูเมาส์',
    avatar: '/agent-assets/takujung-v2/takujung-assemble.png',
    engine: 'claude',
    model: 'opus',
    pipelineStage: 'assemble',
    vectorEditor: true,
    placeholder: 'เช่น ย่อแถบโลโก้ให้พ้นแอร์ ลดเงาพาดหัว และขยับข้อความไม่ให้ชนคน',
    approveLabel: 'ถูกต้อง และจำวิธีนี้',
    async onApprove(task, body) {
      const note = await deps.vectorTeaching.approve(task, body);
      const attached = task.input?.mode === 'edit'
        ? await attachApprovedGraphicImage(task, body, { ...deps, root: ROOT }) : null;
      return attached ? `${note} · ${attached}` : note;
    },
  },

  motion: {
    name: 'มูฟ',
    role: 'ทำแอนิเมชัน (EffectCraft)',
    about: 'ขั้นที่ 4 (ทำเมื่อกดปุ่ม): AI ดูภาพที่ประกอบเสร็จแล้ววางจังหวะเคลื่อนไหวของแต่ละเลเยอร์ (สแนปเร็ว ไม่มีเฟด ไม่ทยอยโผล่) จากนั้นสร้างคลิปใน EffectCraft เรนเดอร์เป็น MP4 แล้วเปิดต่อใน FilmCraft เพื่อใส่เพลงได้ ตัวเลขในกฎด้านล่างคือค่าเริ่มต้น เขียนรูปแบบ "- ชื่อ: ค่า" เหมือนเดิม และเพิ่มกฎเป็นข้อความได้',
    avatar: '/agent-assets/takujung-v2/takujung-motion.png',
    engine: 'claude',
    model: 'sonnet',
    fromImageOnly: true,
    approveLabel: 'เก็บคลิปนี้',
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
function runProcess(bin, args, { cwd, input }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env: { ...process.env, ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' } });
    children.add(child);
    const awake = spawn('/usr/bin/caffeinate', ['-i', '-w', String(child.pid)], { stdio: 'ignore' });
    awake.on('error', () => {});
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), TASK_TIMEOUT_MS);
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
    ...(revising ? ['--resume', session] : []),
  ];
  const { code, stdout, stderr } = await runProcess(bin, args, { cwd: ROOT, input: prompt });
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

function craftBin(name) {
  return path.join(os.homedir(), '.local', 'bin', `${name}-cli`);
}

// The picture's frame: canvas size, the safe zone every crop keeps, and the
// crops exported from the one master. A job's frame comes from its campaign.
const FRAMES = {
  feed: { size: [1080, 1350], safe: [0, 0, 1080, 1350], crops: [] },
  // One 9:16 master that crops to 4:5 and 1:1 (her rule, 2026-10-28).
  'story-crops': { size: [1080, 1920], safe: [0, 420, 1080, 1080], crops: [{ name: '4x5', rect: [0, 285, 1080, 1350] }, { name: '1x1', rect: [0, 420, 1080, 1080] }] },
};
const frameStore = new AsyncLocalStorage();
const frame = () => frameStore.getStore() || FRAMES.feed;
const frameFor = (task) => FRAMES[task.input?.frame] || FRAMES.feed;
const safeTop = () => frame().safe[1];
const safeBottom = () => frame().safe[1] + frame().safe[3];
const ratio = ([w, h]) => { const g = (a, b) => (b ? g(b, a % b) : a); const d = g(w, h); return `${w / d}:${h / d}`; };
// What every planner/checker must keep inside the crops, in words.
function safeNote() {
  const f = frame();
  if (!f.crops.length) return '';
  const [x, y, w, h] = f.safe;
  return `\nภาพนี้เป็นภาพหลัก ${f.size[0]}x${f.size[1]} (${ratio(f.size)}) ที่จะถูกครอปเป็น ${f.crops.map((c) => `${c.name.replace('x', ':')} (y ${c.rect[1]}–${c.rect[1] + c.rect[3]})`).join(' และ ')} พาดหัว สินค้าพระเอก คน และจุดขายทั้งหมดต้องอยู่ในกรอบปลอดภัย x ${x}–${x + w}, y ${y}–${y + h} เท่านั้น นอกกรอบ (บนและล่าง) เป็นได้แค่ฉากต่อเนื่อง เช่น ฟ้า แดด หลังคาโซลาร์ พื้น`;
}

function pixelSize(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  const [w, h] = out.trim().split('\n')[0].split(',').map(Number);
  return { w, h };
}

function cleanRect(r) {
  if (!Array.isArray(r) || r.length !== 4 || !r.every((n) => Number.isFinite(Number(n)))) return null;
  const [x, y, w, h] = r.map((n) => Math.round(Number(n)));
  return w > 0 && h > 0 ? [x, y, w, h] : null;
}

// ─── Image line ──────────────────────────────────────────────────────────────
// ผัง plans the pieces → พิมพ์ paints the background → ผัง looks at that real
// background and places everything → พิมพ์ paints the cut-outs → ประกอบ
// assembles → ผัง checks. Every check (its own, or her ↻ comment) is split
// into jobs for the agent that owns each problem: ผัง moves/resizes, พิมพ์
// edits one piece starting from its previous picture with a concrete change,
// ประกอบ adjusts the real unit's light/colour and the shadow, and brand-kit
// questions go to her. Nothing is regenerated from the same prompt.

const PIECES_SCHEMA = {
  type: 'object',
  properties: {
    hero: { type: 'object', properties: { what: { type: 'string' }, role: { type: 'string', enum: ['fcu', 'cu', 'remote', 'none'] }, matchesAttached: { type: 'boolean' }, why: { type: 'string' } }, required: ['what', 'role', 'matchesAttached', 'why'] },
    supports: { type: 'array', items: { type: 'object', properties: { role: { type: 'string', enum: ['fcu', 'cu', 'remote'] }, why: { type: 'string' }, front: { type: 'boolean' } }, required: ['role', 'why', 'front'] } },
    device: { type: 'string' },
    hook: { type: 'string' },
    proof: { type: 'object', properties: { title: { type: 'string' }, items: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, detail: { type: 'string' }, source: { type: 'string' } }, required: ['label', 'detail', 'source'] } } }, required: ['title', 'items'] },
    alternatives: { type: 'array', items: { type: 'object', properties: { device: { type: 'string' }, hook: { type: 'string' } }, required: ['device', 'hook'] } },
    light: { type: 'string', enum: ['left', 'right', 'front'] },
    lightConfidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    camera: { type: 'string' },
    concept: { type: 'string' },
    background: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] },
    elements: {
      type: 'array',
      items: {
        type: 'object',
        properties: { key: { type: 'string' }, name: { type: 'string' }, prompt: { type: 'string' }, front: { type: 'boolean' } },
        required: ['key', 'name', 'prompt', 'front'],
      },
    },
  },
  required: ['hero', 'supports', 'device', 'hook', 'proof', 'alternatives', 'light', 'lightConfidence', 'camera', 'concept', 'background', 'elements'],
};

const RECT = { type: 'array', items: { type: 'number' } };
const PLACE_SCHEMA = {
  type: 'object',
  properties: {
    product: RECT,
    elements: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, rect: RECT }, required: ['key', 'rect'] } },
    headlineZone: RECT,
    subheadZone: RECT,
    kit: { type: 'array', items: { type: 'object', properties: { file: { type: 'string' }, rect: RECT, front: { type: 'boolean' } }, required: ['file', 'rect', 'front'] } },
    logoPanel: { type: 'string' },
    textStyles: { type: 'array', items: { type: 'string' } },
  },
  required: ['product', 'elements', 'headlineZone', 'subheadZone', 'kit', 'logoPanel', 'textStyles'],
};

const TWEAK_LIMITS = {
  productBrightness: [-20, 20], productWarmth: [-20, 20], productContrast: [-20, 20], productSaturation: [-20, 20],
  shadowStrength: [0, 100], shadowBlur: [4, 60], shadowOffsetY: [0, 60],
};
const DEFAULT_TWEAKS = { productBrightness: 0, productWarmth: 0, productContrast: 0, productSaturation: 0, shadowStrength: 45, shadowBlur: 24, shadowOffsetY: 18 };

const ROUTE_SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'number' },
    checks: { type: 'array', items: { type: 'object', properties: { item: { type: 'string' }, pass: { type: 'boolean' }, note: { type: 'string' } }, required: ['item', 'pass', 'note'] } },
    issues: { type: 'array', items: { type: 'string' } },
    assignments: {
      type: 'array',
      items: {
        type: 'object',
        properties: { to: { type: 'string', enum: ['layout', 'image', 'assemble', 'you'] }, piece: { type: 'string' }, instruction: { type: 'string' } },
        required: ['to', 'piece', 'instruction'],
      },
    },
    tweaks: { type: 'object', properties: Object.fromEntries(Object.keys(TWEAK_LIMITS).map((k) => [k, { type: 'number' }])) },
  },
  required: ['score', 'checks', 'issues', 'assignments', 'tweaks'],
};

const cleanKey = (k, i = 0) => (String(k || '').toLowerCase().replace(/[^a-z0-9]/g, '') || `item${i + 1}`).slice(0, 20);

function planBrief(task) {
  const i = task.input || {};
  return `โจทย์: ${task.prompt}
${i.headline ? `พาดหัวที่จะใช้: "${i.headline}"` : ''}${i.subhead ? ` บรรทัดรอง: "${i.subhead}"` : ''}${i.campaignId ? `
แคมเปญ ${i.campaignName || i.campaignId}${i.adName ? ` · แอด ${i.adName}` : ''}: ${i.campaignNote || ''}
ภาพแนบท้ายสุดคืองานของแคมเปญนี้ที่ผ่านแล้ว ทำให้เป็นชุดเดียวกัน (โทน แสง ความพรีเมียม ความชัดของจุดขาย) แต่ห้ามลอกตัวหนังสือ โลโก้ หรือแอร์จากภาพนั้น` : ''}${safeNote()}`;
}

// 1 — ผัง decides which pieces to paint (no positions yet).
async function planPieces(task, prisma, product) {
  const photos = product.photos?.length ? product.photos : (product.file ? [{ role: 'fcu', file: product.file }] : []);
  const measured = photos.map((ph) => ({ role: ph.role, ...(productLight(ph.file) || {}) }));
  const recent = await recentDevices(prisma);
  // She can pin the device (e.g. "do it like this ad"); otherwise a script offers three.
  const facts = await productFacts(deps.tasakiWebPool, [product.model]).catch(() => '');
  const pinned = CREATIVE_DEVICES.find((d) => d.key === task.input?.device);
  const offered = [pinned || CREATIVE_DEVICES.find((d) => d.key === BLUEPRINT)];
  const blueprint = offered[0].key === BLUEPRINT;
  const exampleAds = deviceRefFiles(offered.map((d) => d.key));
  const planner = {
    speaker: 'layout', rulesAgent: 'layout', model: AGENTS.layout.model, tools: [], images: [...photos.map((ph) => ph.file), ...exampleAds], schema: PIECES_SCHEMA,
    async buildPrompt() {
      return `${BRAND_NOTE}${deviceRefNote(photos.length + 1, exampleAds)}

หน้าที่: วางแผนภาพโฆษณา ${frame().size[0]}x${frame().size[1]} (${ratio(frame().size)}) ที่จะประกอบจากชิ้นส่วนแยก ตอนนี้ยังไม่ต้องกำหนดตำแหน่ง (จะวางหลังเห็นฉากจริง)

ขั้นแรก ก่อนคิดฉาก: หาพระเอกของโฆษณา (hero.what) จากโจทย์และพาดหัว คือสินค้า/ส่วนของสินค้าที่คนดูต้องเห็นเด่นที่สุด${task.input?.heroRole ? `\nไอเดียที่หนิงเลือกกำหนดไว้แล้ว ห้ามเปลี่ยน: พระเอก = role "${task.input.heroRole}"${(task.input.supportRoles || []).length ? ` ตัวรอง = ${task.input.supportRoles.map((r) => `"${r}"`).join(', ')}` : ' ไม่มีตัวรอง'}${task.input.proof ? ` จุดขายที่ภาพต้องพิสูจน์: ${task.input.proof} (คุณคิดเองว่าจะแสดงอย่างไร ถ้าไม่ใช่ตัวสินค้าพระเอก ให้สั่ง GEN วาดเป็นชิ้นกราฟิกใน elements)` : ''}` : ''}
สินค้า ${product.model}${product.type ? ` (${product.type}${product.nameTh ? ` — ${product.nameTh}` : ''})` : ''} มีรูปจริงจากฐานข้อมูลเว็บ Tasaki ตามลำดับภาพที่แนบ:
${photos.map((ph, i) => `${i + 1}. role "${ph.role}" = ${ROLE_TH[ph.role] || ph.role}`).join('\n')}
- hero.role = รูปที่เป็นพระเอก เลือกจากรายการนี้เท่านั้น (เช่น โจทย์ขายคอยล์ร้อน/ฟินคอยล์นอกบ้าน = "cu") ถ้าไม่มีรูปไหนตรงพระเอก role = "none"
- hero.matchesAttached = true เมื่อมีรูปตรงพระเอก (role ไม่ใช่ none)
- ถ้า false: why บอกสั้นๆ ว่าขาดไฟล์อะไร background.prompt ให้เป็นค่าว่าง ห้ามเขียนข้อความพักงานลงในพรอมต์ ระบบจะตั้งสถานะ "รอไฟล์สินค้า" เอง ห้ามวางแผนเลี่ยงไปทำภาพที่เน้นอย่างอื่น
- ผู้กำกับความคิด: ภาพนี้ต้อง "หยุดนิ้ว" ไม่ใช่แค่สวยและสมจริง เลือกแนวทางสร้างสรรค์ (device) หลักจาก 3 ตัวนี้เท่านั้น (ใส่ key ใน device):
${offered.map((d) => `  · ${d.key} = ${d.label}: ${d.desc}`).join('\n')}
  hook = จุดหยุดนิ้วของภาพนี้ 1 ประโยค (สิ่งที่คนเห็นแล้วสะดุดและเข้าใจจุดขายทันที) ต้องเกิดจาก device ที่เลือกกับจุดขายของไอเดีย
  alternatives = อีก 2 แนวทางที่ต่างจากตัวหลักจริง (device จากรายการเต็ม: ${CREATIVE_DEVICES.map((d) => d.key).join(', ')} ห้ามซ้ำตัวหลัก) พร้อม hook ของแต่ละแนว ให้หนิงเลือกเปลี่ยนได้
${blueprint ? '  ทำตามแอดตัวอย่างที่หนิงอนุมัติ (ภาพแนบ) เปลี่ยนแค่สถานที่/อาชีพตามโจทย์ ระยะภาพ ขนาดคน ขนาดแอร์ และพาดหัวให้ใกล้เคียงตัวอย่าง' : `  ห้ามทำภาพคลิเช่เหล่านี้ถ้าไม่ใช่ความตั้งใจของ device: ${CLICHES}
  งานล่าสุดใช้ device: ${recent.join(', ') || '(ยังไม่มี)'} ต้องไม่ซ้ำและไม่หน้าตาเหมือน`}
  คนในภาพเปลี่ยนได้ตาม device: จำนวน 0–4 คน บทบาท ชุด ท่าไดนามิก ไม่ต้องยิ้มมองกล้อง ไม่ต้องชุดขาว-กรมท่า (บรรยายด้วยบทบาท ชุด ท่าทาง ห้ามบรรยายรูปร่าง)
- proof (ใช้เมื่อ device = proof-sheet เท่านั้น ถ้าไม่ใช่ให้ title "" และ items ว่าง): แถบข้อมูลพิสูจน์ที่ระบบจะวางเป็นตัวหนังสือจริงที่ด้านล่างภาพ (y ${safeBottom() - 280}–${safeBottom() - 50}) title ไม่เกิน 22 ตัวอักษร items 3–4 ช่อง label ไม่เกิน 18 ตัวอักษร detail ไม่เกิน 40 ตัวอักษร ทุกช่องต้องมาจากข้อมูลสินค้าด้านล่างเท่านั้น source ต้องคัดลอกวลีอย่างน้อย 6 ตัวอักษรจากข้อมูลนั้นมาตรงตัวอักษร (สคริปต์ใช้ตรวจ ช่องที่ source ไม่อยู่ในข้อมูลจะถูกตัดทิ้ง) ห้ามแต่งผลทดสอบ ใบรับรอง จำนวนปี สูตรวัสดุ ถ้าข้อมูลขัดกันเรื่องสีฟิน ให้ใช้เฉพาะข้อความจากคำอธิบายในเว็บ ห้ามอ้างข้อความ "ฟินสีทอง" ของแคตตาล็อก
  ถ้า device = proof-sheet: elements ต้องมีภาพซูมจุดขายขนาดใหญ่ (key macro) เป็นพระเอกกลางภาพ ห้ามมี element ไอคอนหรือตัวหนังสือ และเว้นพื้นที่ล่างสุด (y ${safeBottom() - 290} ลงไป) ไว้ให้แถบข้อมูล ไม่ใส่ฉากสำคัญที่นั่น
  ข้อมูลสินค้าจริง (ใช้ได้เท่านี้):
${facts || '(ไม่มี)'}
- supports: รูปจริงตัวรองจากรายการเดียวกัน ไม่เกิน 2 รูป ใส่เฉพาะเมื่อช่วยสื่อจุดขายจริง (เช่น แอดรีโมตให้คอยล์เย็นเป็นตัวรอง แอดชุดแอร์ครบให้คอยล์ร้อนเป็นตัวรอง) why บอกเหตุผล ห้ามซ้ำกับพระเอก ไม่จำเป็นก็ให้ว่าง ตัวรองต้องเล็กกว่าพระเอกเสมอ
- ถ้า true: ทุกอย่างในภาพมีไว้ส่งพระเอก ฉากต้องทำให้จุดขายในพาดหัวเห็นชัด (เช่น ทนไอเกลือ = เห็นบริบทริมทะเลรอบตัวสินค้า) คน ห้อง และของแต่งเป็นองค์ประกอบรอง ห้ามบรรยายของรองละเอียดกว่าพระเอก
- ห้ามสั่งชิ้นส่วนที่อ้างถึงสินค้าหรือของที่ไม่มีไฟล์จริง (เช่น แสงสะท้อนบนเครื่องที่ไม่ได้แนบ)
- elements (GEN วาด) เป็นกราฟิกหรือของประกอบได้ทุกอย่าง เช่น ภาพแทรกโคลสอัปฟินคอยล์สีฟ้า ไอเกลือ ไอคอน ลมเย็น แต่ห้ามวาดสินค้าพระเอก และห้ามวาดสินค้า Tasaki ที่มีรูปจริงในรายการด้านบน (ให้ใส่ใน supports แทน) ชิ้นที่เป็นกราฟิกให้บอกใน prompt ว่าเป็น illustration/graphic ไม่ใช่ภาพถ่ายสินค้า

รูปสินค้าจริงคือตัวตั้งต้น (แก้มุมหรือแสงในรูปไม่ได้) ฉากต้องปรับตามสินค้า ไม่ใช่สินค้าปรับตามฉาก เปิดดูรูปสินค้าที่แนบก่อน แล้ว:
- light: ทิศแสงที่เห็นในรูปพระเอก (left = แสงมาจากซ้าย, right = จากขวา, front = จากด้านหน้า/สม่ำเสมอ) ดูจากเงาและไฮไลต์บนผิวที่เป็นสีเดียวกัน อย่าดูจากสีของวัสดุ lightConfidence = ความมั่นใจของการประเมินนี้ (high/medium/low)${measured.length ? `\n  สคริปต์วัดความสว่างเฉพาะผิวสีขาวของตัวเครื่อง (ไม่นับใบพัด คอยล์ ฉลาก): ${measured.map((m) => `${m.role}: ${m.confidence === 'none' ? `วัดไม่ได้ (${m.reason || 'ตัวเครื่องไม่ใช่สีขาว'})` : `แสง ${m.side} ความมั่นใจ ${m.confidence}`}`).join(' · ')}\n  ถ้ารูปพระเอกวัดได้ความมั่นใจ high ต้องใช้ทิศนั้น` : ''}
- แสงในฉากต้องเป็นแสงนุ่มกระจาย (soft diffused daylight) จากทิศ light เงานุ่ม เพราะรูปสินค้าถ่ายในสตูดิโอแสงนุ่ม ห้ามแดดแข็งเงาคมตัด ไม่งั้นสินค้าจะดูแปะ
- camera: มุมกล้องของรูปสินค้า (เช่น eye-level straight-on, slightly from below, three-quarter from the left) ฉากต้องถ่ายจากมุมเดียวกัน
- ใช้ light และ camera นี้ในทุกคำสั่ง ทั้งฉาก คน ลมเย็น และเงาของสินค้า และเขียนทั้งสองอย่างลงใน background.prompt ชัดๆ
${blueprint ? `- background.prompt (แอดสูตรร้านที่หนิงอนุมัติ): เขียนเฉพาะ "สถานที่หรือร้าน + อาชีพ + คน 2 คนที่ทำงานอยู่ (หน้าตา ชุด ท่าทางต่างกัน) + ของที่เล่าจุดขาย เช่น แผงโซลาร์บนหลังคา + บริบทนอกร้าน" ภาษาไทย 2–4 ประโยค ห้ามใส่ตำแหน่ง ขนาด พิกเซล มุมกล้อง หรือแอร์ ระบบเติมตำแหน่งและกฎภาพให้เองตามแอดตัวอย่าง` : `- background.prompt: ภาษาอังกฤษ ไม่เกิน 150 คำ ขึ้นต้นด้วยบริบทของพระเอกก่อน แล้วค่อยแสง ฉาก คน ของแต่ง เขียนแบบช่างภาพบรรยายภาพ (มีอะไร อยู่ตรงไหนคร่าวๆ) ไม่ใช้รายการห้ามยาวๆ ห้ามได้ประโยคเดียวท้าย prompt
- background.prompt: คำสั่งเจนภาพฉากเต็มภาพ (ภาษาอังกฤษ) ที่มีคน/สัตว์อยู่ในฉากเลยในภาพเดียว (หนิงสั่ง: เจนคนพร้อมฉากหลัง ไม่แยกไดคัท เพื่อให้แสง เงา และพื้นกลมกลืนจริง) บรรยายคนด้วยบทบาท ชุด ท่าทาง สีหน้า และตำแหน่งในภาพ ห้ามมีแอร์ เครื่องใช้ไฟฟ้า ตัวหนังสือ โลโก้ ต้องมีที่ว่างสำหรับวางพระเอกตามประเภท (คอยล์เย็น = ผนังช่วงบน, คอยล์ร้อน = พื้น แท่น หรือขาแขวนนอกบ้าน, รีโมต = มือคนหรือโต๊ะ) หันเข้ากล้องในมุมเดียวกับรูปพระเอก (camera) ไม่มีคนหรือของบังบริเวณนั้น เว้นพื้นที่เรียบด้านซ้ายกลางสำหรับพาดหัว บอกมุมกล้องและทิศแสงให้ชัด`}
${blueprint ? '- elements: ปล่อยเป็นอาร์เรย์ว่างเสมอ แอดสูตรร้านเจนเฉพาะฉากภาพเดียว ลม เส้นพลังงาน ป้าย และของประกอบอื่นทำเป็นเวกเตอร์ทีหลัง ห้ามสั่งเจนชิ้นไดคัทใดๆ' : `- elements: เฉพาะสิ่งที่ต้องแยกเลเยอร์จริงๆ เช่น ลมเย็น (ไม่ใส่คน เพราะคนอยู่ในภาพฉากแล้ว) key ภาษาอังกฤษตัวเล็ก ชื่อไทย prompt ภาษาอังกฤษระบุ "isolated on transparent background" front=true ถ้าอยู่หน้าสินค้า
- ถ้าพระเอกเป็นคอยล์เย็นติดผนัง ให้มีชิ้นลมเย็นเสมอ (key: airflow) เป็นริบบิ้นโปร่งแสงสีฟ้าอ่อนไหลลงจากช่องลม front=true ถ้าพระเอกไม่ใช่คอยล์เย็นไม่ต้องมี`}
- concept: อธิบายภาพสั้นๆ ภาษาไทย
${planBrief(task)}`;
    },
  };
  const { result } = await runLanguageAgent(planner, { ...task, sessionId: null, feedback: '' }, prisma, deps);
  // The idea she picked already decided the hero and supports: keep them.
  const fixedHero = task.input?.heroRole;
  if (fixedHero && photos.some((ph) => ph.role === fixedHero)) {
    result.hero = { ...(result.hero || {}), role: fixedHero, matchesAttached: true };
    if (Array.isArray(task.input.supportRoles)) {
      result.supports = task.input.supportRoles.map((r) => ({ role: r, why: 'ไอเดียที่หนิงเลือกกำหนด', front: Boolean((result.supports || []).find((x) => x.role === r)?.front) }));
    }
  }
  const decided = decideLight(result, measured);
  const deviceKey = (offered.find((d) => d.key === result.device) || offered[0]).key;
  if (deviceKey === BLUEPRINT) decided.prompt = sceneBrief(frame(), decided.prompt);
  return {
    hero: {
      what: String(result.hero?.what || ''),
      role: photos.some((ph) => ph.role === result.hero?.role) ? result.hero.role : 'none',
      matchesAttached: result.hero?.matchesAttached !== false && photos.some((ph) => ph.role === result.hero?.role),
      why: String(result.hero?.why || ''),
    },
    device: (offered.find((d) => d.key === result.device) || offered[0]).key,
    hook: String(result.hook || '').slice(0, 300),
    alternatives: (result.alternatives || []).filter((x) => CREATIVE_DEVICES.some((d) => d.key === x.device)).slice(0, 2).map((x) => ({ device: x.device, hook: String(x.hook || '').slice(0, 240) })),
    proof: (() => {
      const norm = (t) => String(t || '').replace(/\s+/g, '').toLowerCase();
      const have = norm(facts);
      const items = (result.proof?.items || []);
      const ok = items.filter((i) => i.label && i.detail && norm(i.source).length >= 6 && have.includes(norm(i.source))).slice(0, 4)
        .map((i) => ({ label: String(i.label).slice(0, 20), detail: String(i.detail).slice(0, 44), source: String(i.source).slice(0, 120) }));
      return { title: String(result.proof?.title || '').slice(0, 24), items: ok, dropped: items.length - ok.length };
    })(),
    supports: (result.supports || []).filter((x, i, all) => photos.some((ph) => ph.role === x.role) && x.role !== result.hero?.role && all.findIndex((y) => y.role === x.role) === i).slice(0, 2)
      .map((x) => ({ role: x.role, why: String(x.why || ''), front: Boolean(x.front) })),
    lightConfidence: ['high', 'medium', 'low'].includes(result.lightConfidence) ? result.lightConfidence : 'low',
    measured,
    camera: String(result.camera || ''),
    concept: result.concept,
    light: decided.light,
    lightSource: decided.lightSource,
    planLight: decided.planLight,
    background: { prompt: decided.prompt },
    elements: (deviceKey === BLUEPRINT ? [] : (result.elements || [])).slice(0, 4).map((e, i) => ({ key: cleanKey(e.key, i), name: String(e.name || `ชิ้นที่ ${i + 1}`).slice(0, 40), prompt: String(e.prompt || ''), front: Boolean(e.front) })).filter((e) => e.prompt),
  };
}

// 2/4 — ผัง opens the real background (and the pieces) and places everything
// on what is actually there, instead of guessing coordinates up front.
async function placeOnBackground(task, prisma, product, plan, dir, piecesDir, instruction) {
  const bg = path.join(dir, piecesDir, 'bg.png');
  const pieceFiles = plan.elements.map((e) => ({ ...e, file: path.join(dir, piecesDir, `${e.key}.png`) })).filter((e) => fs.existsSync(e.file));
  const sizes = pieceFiles.map((e) => ({ key: e.key, ...pixelSize(e.file) }));
  const placer = {
    speaker: 'layout', rulesAgent: 'layout', model: AGENTS.layout.model, tools: ['Read'], images: [bg, ...pieceFiles.map((e) => e.file)], schema: PLACE_SCHEMA,
    async buildPrompt() {
      return `${BRAND_NOTE}

หน้าที่: วางตำแหน่งชิ้นส่วนบนฉากหลังจริง ใช้เครื่องมือ Read เปิดดูฉากหลัง ${bg}${pieceFiles.length ? ` และชิ้นไดคัท ${pieceFiles.map((e) => e.file).join(', ')}` : ''} ก่อนตัดสินใจ
วางจากสิ่งที่เห็นจริงในภาพเท่านั้น (ผนังว่างอยู่ตรงไหน พื้นอยู่ระดับไหน โซฟา/หน้าต่างอยู่ตรงไหน) ไม่ใช่จากที่ตั้งใจไว้
- product: [x,y,กว้าง,สูง] ของสินค้าพระเอก (รูปจริง ${ROLE_TH[product.role] || ''} ${product.model}) อัตราส่วนกว้าง:สูง = ${product.w}:${product.h} วางตามประเภท (คอยล์เย็น = บนผนังว่างทั้งตัว ห่างเพดานพอดี, คอยล์ร้อน = ตั้งบนพื้น/แท่น/ขาแขวน, รีโมต = ในมือหรือบนโต๊ะ) ไม่ทับหน้าต่าง ม่าน หรือขอบผนัง ขนาดสมจริงเทียบคนและเฟอร์นิเจอร์ในภาพ
- elements: [x,y,กว้าง,สูง] ของแต่ละชิ้น (${sizes.map((z) => `${z.key} ภาพจริง ${z.w}x${z.h}${plan.elements.find((e) => e.key === z.key)?.real ? ' = รูปสินค้าจริงตัวรอง ห้ามบิดสัดส่วน ต้องเล็กกว่าพระเอก' : ''}`).join(', ') || 'ไม่มี'}) คนต้องยืนบนพื้น/นั่งบนเบาะที่เห็นในภาพจริง ขนาดสมจริง ลมเย็นวางใต้ช่องลมของคอยล์เย็น
- headlineZone: พื้นที่เรียบสำหรับพาดหัวใหญ่ 2 บรรทัด ห้ามทับหน้าคน สินค้า และมุมซ้ายบน (0,${safeTop()})-(420,${safeTop() + 260}) ที่เป็นแถบโลโก้
- subheadZone: พื้นที่บรรทัดรองตัวเล็ก ห้ามทับหน้าคน${plan.proof?.items?.length ? `
- มีแถบข้อมูลพิสูจน์ที่ด้านล่าง y ${safeBottom() - 280}–${safeBottom() - 50} ห้ามวางสินค้า คน หรือชิ้นสำคัญล้ำลงไปในช่วงนี้ ชิ้น macro (ภาพซูม) ให้กว้างอย่างน้อย 45% ของภาพ (≥ 490px) อยู่กลางภาพ ไม่ทับสินค้าพระเอกและพาดหัว` : ''}
- kit: ชิ้นจากคลังที่จะวางจริง [{file, rect [x,y,กว้าง,สูง], front}] เช่น กังหันเป็นมุมภาพ/กรอบ/ป้าย badge จุดขาย ใช้เมื่อช่วยเล่าเรื่องและดูเป็นแบรนด์ ไม่เกิน 4 ชิ้น ห้ามทับหน้าคน สินค้า และพาดหัว ชิ้นที่มีความหมาย (badge ป้าย) ต้องอยู่ในกรอบปลอดภัย กังหันตกแต่งล้นขอบได้ front=true ถ้าอยู่หน้าสินค้า
- logoPanel: ไฟล์กังหันจาก shapes/ ที่จะใช้เป็นพื้นหลังโลโก้ขาวมุมซ้ายบนแทนวงรีน้ำเงินเดิม (เช่น shapes/tasaki-blade-kit/blade-gradient.svg) หรือ "" ใช้กังหันไล่สีน้ำเงินเป็นค่าเริ่มต้น
- textStyles: สไตล์ตัวอักษรแม่แบบของพาดหัวบรรทัด 1 และ 2 (key จากรายการด้านล่าง)${task.input?.textStyle ? ` แคมเปญกำหนดไว้แล้ว = ${task.input.textStyle} ใช้ตามนี้` : ' เลือกให้อ่านชัดบนฉากจริงและเป็นแบรนด์'}
${kitNote()}
${instruction ? `\nงานแก้ที่ได้รับ: ${instruction}` : ''}
${planBrief(task)}`;
    },
  };
  const { result } = await runLanguageAgent(placer, { ...task, sessionId: null, feedback: '' }, prisma, deps);
  const pr = cleanRect(result.product) || plan.product?.rect || [200, 220, 680, 0];
  const height = Math.round(pr[2] * (product.h / product.w));
  const rects = Object.fromEntries((result.elements || []).map((e) => [cleanKey(e.key), cleanRect(e.rect)]));
  return {
    ...plan,
    product: { rect: [pr[0], pr[1] + Math.round(((pr[3] || height) - height) / 2), pr[2], height] },
    elements: plan.elements.map((e) => {
      let rect = rects[e.key] || e.rect || null;
      // A real product photo keeps its proportions and stays smaller than the hero.
      if (rect && e.real) {
        const size = sizes.find((z) => z.key === e.key);
        const w = Math.min(rect[2], Math.round(pr[2] * 0.9));
        if (size) rect = [rect[0], rect[1], w, Math.round(w * (size.h / size.w))];
      }
      return { ...e, rect };
    }),
    headlineZone: cleanRect(result.headlineZone) || plan.headlineZone,
    // Pieces from her kit: only real files, never stretched.
    kit: (result.kit || []).slice(0, 4).flatMap((k) => {
      try { kitFile(k.file); const r = cleanRect(k.rect); return r ? [{ file: k.file, rect: fitRect(k.file, r), front: Boolean(k.front) }] : []; } catch { return []; }
    }),
    logoPanel: (() => { try { return result.logoPanel && /^shapes\//.test(result.logoPanel) && kitFile(result.logoPanel) ? result.logoPanel : ''; } catch { return ''; } })(),
    textStyles: task.input?.textStyle ? [task.input.textStyle, task.input.textStyle] : (result.textStyles || []).filter((k) => TEXT_STYLES[k]).slice(0, 2),
    // With a proof strip the sub line sits just above it.
    subheadZone: plan.proof?.items?.length ? [60, safeBottom() - 384, 640, 60] : (cleanRect(result.subheadZone) || plan.subheadZone),
  };
}

// พิมพ์: new pieces from a prompt; fixes start FROM the previous picture of
// that piece (attached) with ผัง's concrete change, so a fix is a real edit.
function fitToFrame(file) {
  const [w, h] = frame().size;
  execFileSync('/usr/bin/python3', ['-c', 'import sys\nfrom PIL import Image\nim=Image.open(sys.argv[1]).convert("RGB")\nw,h=int(sys.argv[2]),int(sys.argv[3])\nif im.size!=(w,h):\n k=max(w/im.width,h/im.height)\n im=im.resize((round(im.width*k),round(im.height*k)),Image.LANCZOS)\n x=(im.width-w)//2;y=(im.height-h)//2\n im=im.crop((x,y,x+w,y+h))\nim.save(sys.argv[1])', file, String(w), String(h)], { cwd: '/' });
}

async function paintPieces(task, dir, piecesDir, jobs) {
  if (!jobs.length) return;
  const styleRefs = jobs.flatMap((j) => j.styleRefs || []).filter((f) => fs.existsSync(f));
  const bin = codexBin();
  if (!bin) throw new Error('ไม่พบ Codex บนเครื่องนี้');
  const attach = jobs.filter((j) => j.from && fs.existsSync(j.from));
  // The blueprint's own approved ads are the reference: the campaign's web covers would pull the framing off.
  const refs = jobs.some((j) => j.blueprint) ? [] : attachmentFiles(task);
  const styleNote = styleRefs.length
    ? `\nภาพแนบลำดับที่ ${attach.length + refs.length + 1}–${attach.length + refs.length + styleRefs.length} คือแอดตัวอย่าง (ของ Tasaki ที่หนิงอนุมัติ หรือของแบรนด์อื่น) ให้ดูระยะภาพ องค์ประกอบ มุมกล้อง สเกล และพลังงานของภาพ ห้ามคัดลอกโลโก้ ชื่อแบรนด์ ตัวหนังสือ ตัวสินค้า คน หรือสีแบรนด์ของเขา สร้างภาพใหม่ของ Tasaki ตามคำสั่งเท่านั้น`
    : '';
  const lines = jobs.map((j, i) => {
    const out = `${piecesDir}/${j.key}.png`;
    const shape = j.key === 'bg'
      ? `ภาพฉากเต็มภาพ (มีคนในฉากได้ตามคำบรรยาย) เจนด้วย image_gen ที่ขนาด ${genSize(frame().size).join('x')} (อัตราส่วน ${ratio(frame().size)} พอดี) ตั้งแต่แรก แล้วย่อเป็น ${frame().size[0]}x${frame().size[1]} ด้วย Pillow ย่อสัดส่วนเดียวกัน ห้ามครอป ห้ามยืด ห้ามมีแอร์ เครื่องใช้ไฟฟ้า ตัวหนังสือ โลโก้`
      : 'พื้นหลังโปร่งใส (ไดคัท) ตรวจด้วย Pillow ว่ามี alpha จริง ขอบสะอาด ครอปขอบโปร่งใสส่วนเกินออก';
    if (j.from && fs.existsSync(j.from)) {
      return `${i + 1}. ${out} — แก้จากภาพแนบลำดับที่ ${attach.indexOf(j) + 1} (${j.name}) ด้วยโหมดแก้ภาพ: ${j.instruction}
   คงทุกอย่างที่ไม่ได้สั่งแก้ไว้เหมือนเดิม (${shape})`;
    }
    return `${i + 1}. ${out} — ${j.name}: ${j.prompt}${j.instruction ? `\n   เพิ่มเติม: ${j.instruction}` : ''}\n   ${shape}`;
  });
  const prompt = `ใช้เครื่องมือ image_gen ทำชิ้นส่วนภาพตามรายการนี้เท่านั้น ห้ามเพิ่ม ห้ามจัดวางหรือประกอบเอง
${lines.join('\n')}${styleNote}${teachingNote(await taughtNotes(deps.prisma, 'image'))}${refs.length ? `\nภาพแนบลำดับที่ ${attach.length + 1}–${attach.length + refs.length} คือภาพอ้างอิงที่หนิงแนบมา ใช้เป็นแนวทาง (โทน มุมกล้อง ท่าทาง บรรยากาศ) ห้ามลอกตัวหนังสือ โลโก้ หรือแอร์จากภาพอ้างอิง` : ''}${rulesNote(await combinedRules(deps.prisma, 'image'))}
ตอบสั้นๆ ภาษาไทยว่าทำ/แก้อะไรไปบ้าง`;
  await logEvent(deps.prisma, 'layout', jobs.map((j) => (j.from ? `แก้${j.name}: ${j.instruction}` : `เจน${j.name}`)).join(' / '), task.id, { kind: 'handoff', toAgent: 'image', detail: prompt });
  const msgFile = path.join(dir, `${piecesDir}-message.txt`);
  await runProcess(bin, [
    'exec', '--skip-git-repo-check', '--sandbox', 'workspace-write', '-C', dir, '-o', msgFile,
    // --image=… (not "-i …"): -i takes several values and would swallow anything after it.
    ...attach.map((j) => `--image=${j.from}`),
    ...refs.map((f) => `--image=${f}`),
    ...styleRefs.map((f) => `--image=${f}`),
  ], { cwd: dir, input: prompt });
  const missing = jobs.filter((j) => !fs.existsSync(path.join(dir, piecesDir, `${j.key}.png`)));
  if (missing.some((j) => j.key === 'bg')) throw new Error('Codex ไม่ได้ส่งฉากหลังกลับมา');
  // The scene must be exactly the master size: scaled to cover and centred, never stretched.
  fitToFrame(path.join(dir, piecesDir, 'bg.png'));
  let said = '';
  try { said = fs.readFileSync(msgFile, 'utf8').replace(/\[[^\]]*\]\([^)]*\)/g, '').trim(); } catch {}
  await logEvent(deps.prisma, 'image', said || `เสร็จ: ${jobs.map((j) => j.name).join(', ')}`, task.id, { kind: 'handoff', toAgent: 'assemble' });
}

const PIL_TWEAK = `from PIL import Image, ImageEnhance, ImageDraw, ImageFilter
import sys, json
mode = sys.argv[1]
t = json.loads(sys.argv[2])
if mode == 'product':
    im = Image.open(sys.argv[3]).convert('RGBA')
    a = im.getchannel('A')
    rgb = im.convert('RGB')
    rgb = ImageEnhance.Brightness(rgb).enhance(1 + t['productBrightness'] / 100)
    rgb = ImageEnhance.Contrast(rgb).enhance(1 + t['productContrast'] / 100)
    rgb = ImageEnhance.Color(rgb).enhance(1 + t['productSaturation'] / 100)
    w = t['productWarmth'] / 200
    r, g, b = rgb.split()
    r = r.point(lambda v: min(255, int(v * (1 + w))))
    b = b.point(lambda v: min(255, int(v * (1 - w))))
    out = Image.merge('RGB', (r, g, b)).convert('RGBA')
    out.putalpha(a)
    out.save(sys.argv[4])
elif mode == 'light':
    # Light direction from the product's own white casing: only near-white,
    # low-saturation pixels count (dark fans, coils and labels are material,
    # not shading), then a plane fit of brightness across x and y. The fit's
    # strength gives a confidence; a non-white product gives none.
    import numpy as np
    im = Image.open(sys.argv[3]).convert('RGBA')
    im.thumbnail((400, 400))
    a = np.asarray(im)[:, :, 3].astype(float)
    hsv = np.asarray(im.convert('RGB').convert('HSV')).astype(float)
    sat, val = hsv[:, :, 1] / 255, hsv[:, :, 2] / 255
    opaque = a > 200
    white = opaque & (sat < 0.12) & (val > 0.55)
    ys, xs = np.nonzero(opaque)
    if len(xs) == 0:
        print(json.dumps({'side': 'front', 'confidence': 'none', 'reason': 'no opaque pixels'})); sys.exit()
    if opaque.mean() > 0.97:
        print(json.dumps({'side': 'front', 'confidence': 'none', 'reason': 'not a cut-out (no transparent background)'})); sys.exit()
    share = white.sum() / max(1, opaque.sum())
    if white.sum() < 400 or share < 0.25:
        print(json.dumps({'side': 'front', 'confidence': 'none', 'whiteShare': round(float(share), 2), 'reason': 'body is not mostly white'})); sys.exit()
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    wy, wx = np.nonzero(white)
    nx = (wx - x0) / max(1, x1 - x0) * 2 - 1
    ny = (wy - y0) / max(1, y1 - y0) * 2 - 1
    L = val[wy, wx]
    A = np.column_stack([np.ones_like(nx), nx, ny])
    coef, *_ = np.linalg.lstsq(A, L, rcond=None)
    pred = A @ coef
    r2 = 1 - ((L - pred) ** 2).sum() / max(1e-9, ((L - L.mean()) ** 2).sum())
    dx, dy = float(coef[1]) * 2, float(coef[2]) * 2   # brightness change across the whole width / height
    strong = abs(dx) >= 0.06 and r2 >= 0.15
    side = 'front' if abs(dx) < 0.03 else ('right' if dx > 0 else 'left')
    conf = 'high' if strong else ('medium' if abs(dx) >= 0.03 else 'low')
    print(json.dumps({'side': side, 'dx': round(dx, 3), 'dy': round(dy, 3), 'fromAbove': dy < -0.03, 'r2': round(float(r2), 2), 'whiteShare': round(float(share), 2), 'confidence': conf}))
else:
    W, H, x, y, w, h = map(int, sys.argv[3:9])
    im = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    oy = int(t['shadowOffsetY'])
    ox = int(t.get('shadowOffsetX', 8))
    d.rounded_rectangle([x + ox, y + oy, x + w + ox, y + h + oy], radius=int(h * 0.18), fill=(20, 30, 45, int(t['shadowStrength'] * 2.2)))
    im.filter(ImageFilter.GaussianBlur(int(t['shadowBlur']))).save(sys.argv[9])`;

function clampTweaks(t) {
  return Object.fromEntries(Object.entries(TWEAK_LIMITS).map(([k, [lo, hi]]) => {
    const v = Number(t?.[k]);
    return [k, Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : DEFAULT_TWEAKS[k]];
  }));
}

// ประกอบ's own adjustments: light/colour of the real unit (shape, logo and
// label untouched) and the wall shadow. Pillow is in the user site-packages,
// so no -I; cwd '/' keeps task files off the import path.
function runPil(args) {
  return execFileSync('/usr/bin/python3', ['-c', PIL_TWEAK, ...args], { cwd: '/' }).toString();
}

// Final light direction: a clear measurement of the hero's white casing wins;
// PLAN's estimate stands when the measurement is unclear; when the two
// disagree and neither is sure, use soft front light (safest for studio
// product photos). The prompt is told explicitly when the code overrides.
function decideLight(result, measured) {
  const planLight = ['left', 'right', 'front'].includes(result.light) ? result.light : 'front';
  const m = measured.find((x) => x.role === result.hero?.role);
  let light = planLight;
  let lightSource = 'plan';
  if (m?.confidence === 'high') { light = m.side; lightSource = 'measured'; }
  else if (m && m.confidence === 'medium' && m.side !== planLight && result.lightConfidence !== 'high') { light = 'front'; lightSource = 'conflict'; }
  const words = { left: 'from the left', right: 'from the right', front: 'from the front' }[light];
  const prompt = String(result.background?.prompt || '');
  return { light, lightSource, planLight, prompt: light !== planLight && prompt ? `${prompt} Lighting: soft diffused daylight ${words}, soft shadows.` : prompt };
}

// The real cut-out can't be re-lit, so the scene follows its light.
function productLight(file) {
  try { return JSON.parse(runPil(['light', '{}', file])); } catch { return null; }
}

async function assembleWork(task, prisma, dir, tag, work, product, productFile, kit) {
  const pdir = path.join(dir, work.piecesDir);
  const tweaks = clampTweaks(work.tweaks);
  const adjusted = path.join(pdir, 'product-adjusted.png');
  runPil(['product', JSON.stringify(tweaks), productFile, adjusted]);
  // The wall shadow falls away from the light PLAN chose for the whole picture.
  const shadowOffsetX = { right: -12, left: 12, front: 0 }[work.plan.light] ?? 8;
  runPil(['shadow', JSON.stringify({ ...tweaks, shadowOffsetX }), String(frame().size[0]), String(frame().size[1]), ...work.plan.product.rect.map((n) => String(Math.round(n))), path.join(pdir, 'shadow.png')]);
  const piece = (key) => path.join(pdir, `${key}.png`);
  // Blueprint ads: her final barbershop file is the template. Only the scene,
  // the real AC and the model name change; the headline, sun, airflow, pills
  // and the rest come from the approved file. The old overlay path stays as the fallback.
  if (work.plan.device === BLUEPRINT && fs.existsSync(templateDoc(ROOT))) {
    try {
      const doc = path.join(dir, `r${tag}.vectorcraft`);
      const png = path.join(dir, `r${tag}-1.png`);
      const built = await buildFromTemplate({
        bin: craftBin('vectorcraft'), runProcess, template: templateDoc(ROOT), doc, png,
        bg: piece('bg'), product: adjusted, model: product.model, dir, variant: await nextVariant(prisma, task),
      });
      work.plan.variant = built.variant;
      exportCrops(png);
      await logEvent(prisma, 'assemble', `ประกอบจากแอดฉบับ final (ร้านตัดผม) เปลี่ยนเฉพาะฉาก แอร์ ชื่อรุ่น และเงาสะท้อนกระจก${built.mullion ? '' : ' (ไม่พบเส้นกรอบประตูในฉาก จึงไม่ใส่)'}`, task.id, { kind: 'handoff', toAgent: 'layout', image: `/uploads/agent-images/${path.basename(dir)}/r${tag}-1.png` });
      return [{ name: 'ฉากหลัง', file: piece('bg'), rect: [0, 0, ...frame().size] }, { name: `สินค้าจริง ${product.model}`, file: adjusted, rect: built.acBox }];
    } catch (e) {
      await logEvent(prisma, 'assemble', `ประกอบจากแอด final ไม่สำเร็จ (${String(e.message).slice(0, 120)}) ใช้วิธีประกอบเดิมแทน`, task.id);
    }
  }
  const els = work.plan.elements.filter((e) => e.rect && fs.existsSync(piece(e.key)));
  const layers = [
    { name: 'ฉากหลัง', file: piece('bg'), rect: [0, 0, ...frame().size] },
    ...els.filter((e) => !e.front).map((e) => ({ name: e.name, file: piece(e.key), rect: e.rect })),
    ...(work.plan.kit || []).filter((k) => !k.front).map((k) => ({ name: `คลัง ${path.basename(k.file)}`, file: kitFile(k.file), rect: k.rect })),
    { name: 'เงาสินค้า', file: piece('shadow'), rect: [0, 0, ...frame().size] },
    { name: `สินค้าจริง ${product.model}`, file: adjusted, rect: work.plan.product.rect },
    ...els.filter((e) => e.front).map((e) => ({ name: e.name, file: piece(e.key), rect: e.rect })),
    ...(work.plan.kit || []).filter((k) => k.front).map((k) => ({ name: `คลัง ${path.basename(k.file)}`, file: kitFile(k.file), rect: k.rect })),
  ];
  await assembleLayers(dir, tag, layers, {
    headline: task.input?.headline, subhead: task.input?.subhead, model: product.model,
    textStyles: work.plan.textStyles?.length ? work.plan.textStyles : (task.input?.textStyle ? [task.input.textStyle] : []), logoPanel: work.plan.logoPanel,
    headlineZone: work.plan.headlineZone, subheadZone: work.plan.subheadZone, productRect: work.plan.product.rect,
    proof: work.plan.proof,
  }, kit);
  const changed = Object.entries(tweaks).filter(([k, v]) => v !== DEFAULT_TWEAKS[k]).map(([k, v]) => `${k} ${v}`);
  await logEvent(prisma, 'assemble', `ประกอบเสร็จ ${layers.length + 4} เลเยอร์${changed.length ? ` (ปรับ: ${changed.join(', ')})` : ''} ส่งให้ตรวจ`, task.id, { kind: 'handoff', toAgent: 'layout', image: `/uploads/agent-images/${task.id}/r${tag}-1.png` });
  return layers;
}

// ผัง checks the assembled picture — or reads her ↻ comment — and splits what
// needs fixing into jobs for whoever owns each problem.
// The checklist ผัง answers every time, in this order.
const CHECK_ITEMS = ['สินค้าพระเอกติดฉากเนียน (ตำแหน่ง แสง เงา)', 'ฉากสมจริง มีมิติ (ยกเว้นที่ device ตั้งใจให้เกินจริง)', 'คนและชิ้นไดคัทกลมกลืน', 'ตัวหนังสืออ่านง่าย ไม่ทับหน้าคน', 'สื่อมุมขายชัด', 'มีจุดหยุดนิ้ว (ทำตาม hook ได้จริง) และไม่ซ้ำหน้าตางานก่อนหน้า'];

async function checkAndRoute(task, prisma, png, work, herComment) {
  const kitRules = (await agentRules(prisma, 'assemble')).trim();
  // The tightest crop, so ผัง sees what a 1:1 post would cut off.
  const tightest = frame().crops.at(-1);
  const cropPng = tightest && png.replace(/\.png$/, `-${tightest.name}.png`);
  const hasCrop = cropPng && fs.existsSync(cropPng);
  const own = hasCrop ? [png, cropPng] : [png];
  const exampleAds = deviceRefFiles([work.plan.device], 2);
  const router = {
    speaker: 'layout', rulesAgent: 'layout', model: AGENTS.layout.model, tools: ['Read'], images: [...own, ...exampleAds], schema: ROUTE_SCHEMA,
    async buildPrompt() {
      return `${BRAND_NOTE}${deviceRefNote(own.length + 1, exampleAds)}${exampleAds.length ? ' ถ้าภาพของเราดูจืดหรือเรียบกว่าแอดตัวอย่างชัดเจน ข้อ "มีจุดหยุดนิ้ว" ไม่ผ่าน' : ''}

หน้าที่ตอนนี้: คุณคือหัวหน้างานภาพ ใช้เครื่องมือ Read เปิดดูภาพที่ประกอบเสร็จ ${png} (แอด ${frame().size[0]}x${frame().size[1]})${hasCrop ? ` และครอป ${tightest.name.replace('x', ':')} ${cropPng} ถ้าครอปตัดพาดหัว สินค้า หน้าคน หรือโลโก้ ให้ข้อ "ตัวหนังสืออ่านง่าย" หรือ "สื่อมุมขายชัด" ไม่ผ่าน และสั่ง layout ย้ายเข้ากรอบปลอดภัย` : ''}${safeNote()}
${herComment ? `หนิงดูภาพนี้แล้วคอมเมนต์ว่า: "${herComment}"\nแปลงคอมเมนต์ของหนิงเป็นงานแก้ให้ตรงคน และตรวจเพิ่มตามหัวข้อด้านล่าง` : 'ตรวจอย่างเข้มงวดเหมือนหนิงเป็นคนดู'}
เทียบมาตรฐานแอดจริงของ Tasaki: ห้องพรีเมียมมีมิติ แอร์จริงตัวใหญ่ติดผนังเนียน มีเงาและลมเย็น คนกลมกลืนกับฉาก พาดหัวหนา อ่านง่าย ไม่ทับหน้าคน
หัวข้อตรวจ (ตอบใน checks ครบทุกข้อ ตามลำดับ item ใช้ชื่อนี้ตรงๆ pass true/false note 1 ประโยคสั้นบอกสิ่งที่เห็นจริง ข้อที่ไม่ผ่านให้บอกว่าผิดตรงไหน):
${CHECK_ITEMS.map((x, i) => `${i + 1}. ${x}`).join('\n')}
(มุมขายคือ "${task.input?.headline || task.prompt}" แนวทางสร้างสรรค์ที่เลือก: ${work.plan.device || '-'} hook ที่ตั้งใจไว้: "${work.plan.hook || '-'}" ข้อสุดท้ายให้ตัดสินว่าภาพส่ง hook นี้ได้จริงไหม${work.plan.device === BLUEPRINT ? ' และใกล้แอดตัวอย่างที่หนิงอนุมัติไหม (ร้านเต็มภาพ คนชัด แอร์ใหญ่ราว 37% พาดหัวใหญ่ มีของจริงเล่าจุดขาย) ถ้าถอยไกล คนเล็ก หรือแอร์เล็ก/อยู่ผิดที่ ให้ไม่ผ่าน' : ' ถ้าเป็นแค่คนยิ้มข้างสินค้า ให้ไม่ผ่านและสั่งแก้'})

ฟอนต์และสีของข้อความมาจากกฎแบรนด์ที่หนิงตั้งไว้แล้ว ประกอบใช้ตามนี้ทุกครั้ง ห้ามถามหนิงเรื่องฟอนต์หรือสีอีก:
${kitRules}
ถ้าข้อความในภาพดูไม่ตรงกฎนี้ ให้ส่งงานไปที่ "assemble" ไม่ใช่ "you"

ชิ้นส่วนตอนนี้: ฉากหลัง (piece "bg")${work.plan.elements.map((e) => `, ${e.name} (piece "${e.key}")`).join('')}, แอร์จริง, เงา, ข้อความ
ค่าปรับของประกอบตอนนี้: ${JSON.stringify(clampTweaks(work.tweaks))}

แบ่งงานแก้ (assignments) ให้ตรงคนที่แก้ได้จริง:
- to "layout" (ผัง): ย้าย/ย่อ/ขยาย ตำแหน่งแอร์ คน ลมเย็น พื้นที่พาดหัว (piece ใส่ชิ้นที่เกี่ยว หรือ "")
- to "image" (พิมพ์): แก้ภาพชิ้นเดียวต่อหนึ่งงาน piece = "bg" หรือ key ของชิ้น หรือ key ใหม่ถ้าต้องเพิ่มชิ้น (เช่น airflow) instruction ต้องบอกสิ่งที่ต้องเปลี่ยนในภาพแบบเห็นภาพ เช่น "ย้ายหน้าต่างลงให้ขอบบนอยู่ต่ำกว่าแอร์ เพิ่มโซฟาครีมด้านซ้าย" ห้ามสั่งกว้างๆ อย่าง "ทำให้ดีขึ้น" หรือสั่งซ้ำคำบรรยายเดิม
- to "assemble" (ประกอบ): ปรับแสง/สีของแอร์จริงและเงา โดยใส่ตัวเลขใน tweaks (ช่วงที่ทำได้: ${Object.entries(TWEAK_LIMITS).map(([k, [lo, hi]]) => `${k} ${lo}..${hi}`).join(', ')}) แอร์จริงเปลี่ยนรูปทรง/โลโก้/ฉลากไม่ได้
- to "you" (หนิง): ใช้น้อยที่สุด เฉพาะข้อมูลที่ทีมไม่มีจริงๆ เช่น สเปกสินค้าที่ต้องยืนยันก่อนเขียนลงภาพ ห้ามถามเรื่องที่กฎตอบไว้แล้ว (ฟอนต์ สี โลโก้ พาดหัวที่หนิงให้มา)
ตอบ score 1–10 (${PASS_SCORE}+ เฉพาะพร้อมส่งจริง) assignments และ tweaks (ใส่ค่าที่ต้องการทั้งหมด ถ้าไม่เปลี่ยนให้ใส่ค่าเดิม)
issues: เฉพาะปัญหา (ไม่ต้องใส่ข้อที่ผ่านแล้ว) ไม่เกิน 4 ข้อ ข้อละไม่เกิน 8 คำ เช่น "พาดหัวไม่ใช่ฟอนต์ Frutiger" "เงาใต้แอร์อ่อนไป" หนิงอ่านบนจอมือถือ
งาน to "you": ไม่เกิน 1 ข้อ เป็นคำถามที่ตอบได้ทันที ไม่เกิน 15 คำ ถ้าไม่มีก็ไม่ต้องใส่`;
    },
  };
  const { result } = await runLanguageAgent(router, { ...task, sessionId: null, feedback: '' }, prisma, deps);
  const score = Math.max(1, Math.min(10, Math.round(Number(result.score) || 1)));
  const assignments = (result.assignments || []).filter((a) => a && a.instruction && ['layout', 'image', 'assemble', 'you'].includes(a.to));
  const list = (result.checks || []).filter((c) => c && c.item).map((c) => ({ item: String(c.item), pass: Boolean(c.pass), note: String(c.note || '') }));
  return { score, pass: !herComment && score >= PASS_SCORE, list, issues: result.issues || [], assignments, tweaks: result.tweaks || {} };
}

// Carry out ผัง's jobs on a copy of the current pieces; returns the new work.
async function applyRoute(task, prisma, dir, tag, work, route, product) {
  const piecesDir = `r${tag}-layers`;
  const to = (who) => route.assignments.filter((a) => a.to === who);
  for (const a of route.assignments) {
    await logEvent(prisma, 'layout', `${a.piece ? `[${a.piece}] ` : ''}${a.instruction}`, task.id, { kind: 'handoff', toAgent: a.to });
  }
  fs.mkdirSync(path.join(dir, piecesDir), { recursive: true });
  for (const f of fs.readdirSync(path.join(dir, work.piecesDir))) {
    if (f.endsWith('.png')) fs.copyFileSync(path.join(dir, work.piecesDir, f), path.join(dir, piecesDir, f));
  }
  const plan = JSON.parse(JSON.stringify(work.plan));
  const jobs = [];
  for (const a of to('image')) {
    const key = a.piece === 'bg' ? 'bg' : cleanKey(a.piece);
    const existing = key === 'bg' ? { key, name: 'ฉากหลัง' } : plan.elements.find((e) => e.key === key);
    if (existing?.real) {
      await logEvent(prisma, 'layout', `ข้ามงานแก้ [${key}] เพราะเป็นรูปสินค้าจริง วาดใหม่ไม่ได้ ปรับได้แค่ตำแหน่งและขนาด`, task.id);
      continue;
    }
    if (existing) {
      const prev = path.join(dir, work.piecesDir, `${key}.png`);
      const job = jobs.find((j) => j.key === key);
      if (job) job.instruction += ` และ ${a.instruction}`;
      else jobs.push({ key, name: existing.name, from: prev, instruction: a.instruction });
      if (key !== 'bg') existing.prompt = `${existing.prompt} (แก้: ${a.instruction})`;
      else plan.background.prompt = `${plan.background.prompt} (แก้: ${a.instruction})`;
    } else if (plan.elements.length < 5) {
      const el = { key, name: key === 'airflow' ? 'ลมเย็น' : key, prompt: a.instruction, front: true, rect: null };
      plan.elements.push(el);
      jobs.push({ key, name: el.name, prompt: `${a.instruction}, isolated on transparent background` });
    }
  }
  await setStage(prisma, task, 'generate');
  await paintPieces(task, dir, piecesDir, jobs);
  let next = { ...work, plan, piecesDir, tweaks: { ...clampTweaks(work.tweaks), ...(to('assemble').length ? route.tweaks : {}) } };
  const replace = to('layout').map((a) => a.instruction).join(' / ');
  if (replace || jobs.some((j) => j.key === 'bg' || !j.from)) {
    await setStage(prisma, task, 'plan');
    next = { ...next, plan: await placeOnBackground(task, prisma, product, plan, dir, piecesDir, replace) };
  }
  return next;
}

// One self-fix round at most: three rounds scored 6 → 5 → 6 on a real job, so more
// rounds don't help, and the best-scoring round is kept (not the last).
const MAX_SELF_FIXES = 0;
const PASS_SCORE = 8;
const CLOUD_SECONDS = 40;

// A fix reuses the earlier picture's cut-out pieces. They live in that job's
// folder, so copy them next to this job; false when they no longer exist.
function recoverPieces(dir, work, prevResult) {
  const here = path.join(dir, work.piecesDir);
  if (fs.existsSync(here)) return true;
  const m = /\/agent-images\/([^/]+)\//.exec(prevResult.images?.[0] || '');
  const from = m && path.join(IMAGES_DIR, m[1], work.piecesDir);
  if (!from || !fs.existsSync(from)) return false;
  fs.cpSync(from, here, { recursive: true });
  return true;
}

async function runImagePipeline(task, prisma) {
  const dir = path.join(IMAGES_DIR, task.id);
  fs.mkdirSync(dir, { recursive: true });
  const round = task.rounds + 1;
  const base = `/uploads/agent-images/${task.id}`;
  const productSrc = task.input?.productImage;
  if (!productSrc || !fs.existsSync(productSrc)) return runCodexFreeImage(task, prisma, dir, round);

  const info = await productCatalog(deps.tasakiWebPool).then((rows) => rows.find((p) => p.model === task.input.productModel)).catch(() => null);
  const photos = await productPhotos(deps.tasakiWebPool, task.input.productModel).catch(() => []);
  // A fix keeps the photo the plan already chose (e.g. the outdoor unit).
  const chosenRole = task.result?.work?.plan?.hero?.role || task.result?.plan?.hero?.role;
  let productFile;
  let product;
  const useProduct = (src, role) => {
    productFile = path.join(dir, `product${role && role !== 'fcu' ? `-${role}` : ''}${path.extname(src)}`);
    fs.copyFileSync(src, productFile);
    product = { model: task.input.productModel || 'สินค้า', type: info?.type || '', nameTh: info?.nameTh || '', role: role || 'fcu', photos, file: productFile, ...pixelSize(productFile) };
  };
  const startPhoto = photos.find((ph) => ph.role === chosenRole);
  useProduct(startPhoto?.file || productSrc, startPhoto?.role || 'fcu');
  const kit = await brandKit(prisma);
  const checks = [];
  const needsYou = [];
  const rounds = [];
  let tag = String(round);
  let layers;

  // Her ↻ on an existing picture: ผัง turns the comment into jobs on the
  // existing pieces instead of starting over.
  const selfPlanned = await herIsPlan(prisma);
  const prevResult = task.result || {};
  let work = prevResult.work || (prevResult.plan && prevResult.layerFiles
    ? { plan: prevResult.plan, piecesDir: path.dirname(prevResult.layerFiles[0].file), tweaks: {} }
    : null);
  if (work && !recoverPieces(dir, work, prevResult)) {
    // The earlier files are gone: start over from the original brief plus
    // what she asked to change, and say so in the chat.
    await logEvent(prisma, 'layout', 'ไฟล์ชิ้นส่วนของภาพเดิมไม่อยู่แล้ว เลยวางผังและสร้างภาพใหม่ตามโจทย์เดิม + สิ่งที่หนิงขอแก้', task.id);
    if (task.feedback) task = { ...task, prompt: `${task.prompt}\nคำขอแก้เพิ่มจากหนิง: ${task.feedback}` };
    work = null;
  }
  if (task.feedback && work && prevResult.images?.[0]) {
    await setStage(prisma, task, 'review');
    const prevPng = path.join(ROOT, 'public', prevResult.images[0].split('?')[0]);
    const route = await checkAndRoute(task, prisma, prevPng, work, task.feedback);
    needsYou.push(...route.assignments.filter((a) => a.to === 'you').map((a) => a.instruction));
    work = await applyRoute(task, prisma, dir, tag, work, route, product);
  } else {
    // A plan she reviewed: ↻ re-plans with her note; "ส่งต่อ" uses it as is.
    const reviewed = task.result?.stage === 'planned' && task.result.plan;
    if (reviewed && task.feedback) task = { ...task, prompt: `${task.prompt}\nหนิงรีวิวแผนแล้วสั่งแก้: ${task.feedback}` };
    await setStage(prisma, task, 'plan');
    if (selfPlanned) await logEvent(prisma, 'layout', 'หนิงเป็นผู้วางแผนเอง ใช้คำสั่งของหนิงเป็นฉากโดยตรง ผังไม่วางแผนและไม่ให้คะแนน', task.id);
    const plan = reviewed && !task.feedback && !task.input?.planOnly ? task.result.plan : selfPlanned ? herPlan(task, product, photos) : await planPieces(task, prisma, product);
    // Review the plan first: stop here, nothing is generated or assembled.
    const heroPhoto = photos.find((ph) => ph.role === plan.hero.role);
    if (heroPhoto && heroPhoto.role !== product.role) useProduct(heroPhoto.file, heroPhoto.role);
    if (task.input?.planOnly) {
      const words = plan.background.prompt.split(/\s+/).filter(Boolean).length;
      return { result: { stage: 'planned', plan, product: { model: product.model, type: product.type, role: product.role, photo: heroPhoto?.url || '' }, photos: photos.map(({ role, url }) => ({ role, url })), promptWords: words }, sessionId: null };

    }
    // No real photo of what the ad sells: wait for the file before
    // generating anything (a pretty picture of the wrong product helps no one).
    if (!plan.hero.matchesAttached) {
      throw new WaitingForFile(`โจทย์นี้โฆษณา “${plan.hero.what}” แต่ ${product.model} ไม่มีรูปจริงของสิ่งนี้ในฐานข้อมูลเว็บ (มี: ${photos.map((ph) => ROLE_TH[ph.role]).join(', ') || 'ไม่มีรูป'}) ${plan.hero.why}`.slice(0, 600));
    }
    const piecesDir = `r${tag}-layers`;
    fs.mkdirSync(path.join(dir, piecesDir), { recursive: true });
    // Supporting products are real photos too: copied in as pieces, never drawn.
    for (const sup of plan.supports) {
      const ph = photos.find((x) => x.role === sup.role);
      if (!ph) continue;
      const key = `support${sup.role}`;
      runPil(['product', JSON.stringify(DEFAULT_TWEAKS), ph.file, path.join(dir, piecesDir, `${key}.png`)]);
      plan.elements.push({ key, name: `${ROLE_TH[sup.role]} (รูปจริง)`, prompt: '', front: sup.front, real: true });
    }
    await setStage(prisma, task, 'generate');
    const styleRefs = ((CREATIVE_DEVICES.find((d) => d.key === plan.device) || {}).refs || []).slice(0, 2).map(refPath);
    await paintPieces(task, dir, piecesDir, [{ key: 'bg', name: 'ฉากหลัง', prompt: plan.background.prompt, styleRefs, blueprint: plan.device === BLUEPRINT }]);
    await setStage(prisma, task, 'plan');
    let placed = selfPlanned ? plan : await placeOnBackground(task, prisma, product, plan, dir, piecesDir, '');
    await setStage(prisma, task, 'generate');
    await paintPieces(task, dir, piecesDir, placed.elements.filter((e) => !e.real).map((e) => ({ key: e.key, name: e.name, prompt: e.prompt })));
    if (placed.elements.length) placed = await placeOnBackground(task, prisma, product, placed, dir, piecesDir, 'ตอนนี้มีชิ้นไดคัทจริงแล้ว ปรับตำแหน่ง/ขนาดให้พอดีกับรูปจริงของแต่ละชิ้น');
    work = { plan: placed, piecesDir, tweaks: { ...DEFAULT_TWEAKS } };
  }

  for (let attempt = 0; ; attempt += 1) {
    fs.writeFileSync(path.join(dir, `r${tag}-plan.json`), JSON.stringify(work, null, 2));
    await setStage(prisma, task, 'assemble');
    layers = await assembleWork(task, prisma, dir, tag, work, product, productFile, kit);
    await setStage(prisma, task, 'review');
    const png = path.join(dir, `r${tag}-1.png`);
    const route = selfPlanned ? { score: null, pass: true, list: [], issues: [], assignments: [] } : await checkAndRoute(task, prisma, png, work, null);
    checks.push({ tag, image: `${base}/r${tag}-1.png`, score: route.score, pass: route.pass, list: route.list, issues: route.issues });
    rounds.push({ tag, work, layers, score: route.score });
    needsYou.push(...route.assignments.filter((a) => a.to === 'you').map((a) => a.instruction));
    const actionable = route.assignments.some((a) => a.to !== 'you');
    if (selfPlanned) await logEvent(prisma, 'assemble', 'ประกอบเสร็จ ส่งให้หนิงตรวจเอง', task.id, { kind: 'handoff', toAgent: 'you', image: `${base}/r${tag}-1.png` });
    else if (route.pass) await logEvent(prisma, 'layout', `ตรวจแล้วผ่าน ${route.score}/10 ส่งต่อให้หนิง`, task.id, { kind: 'handoff', toAgent: 'you', image: `${base}/r${tag}-1.png` });
    if (route.pass || !actionable || attempt >= MAX_SELF_FIXES) break;
    tag = `${round}${'bcdefg'[attempt]}`;
    work = await applyRoute(task, prisma, dir, tag, work, route, product);
  }
  // Keep the best round. On a tie the earlier one wins (fewer edits = less to break).
  const best = rounds.reduce((b, r) => (r.score > b.score ? r : b), rounds[0]);
  if (best.tag !== tag) {
    await logEvent(prisma, 'layout', `เลือกรอบ ${best.tag} (คะแนน ${best.score}/10 ดีที่สุด) แทนรอบสุดท้าย เพราะแก้เองแล้วไม่ดีขึ้น`, task.id);
  }
  tag = best.tag;
  work = best.work;
  layers = best.layers;
  const last = checks.find((c) => c.tag === best.tag);
  const youList = [...new Set(needsYou)];
  return {
    result: {
      stage: 'done',
      work,
      plan: work.plan,
      layerFiles: layers.map((l) => ({ name: l.name, file: path.relative(dir, l.file), rect: l.rect })),
      layers: [...layers.map((l) => l.name), 'แถบโลโก้', 'ชื่อรุ่น', ...(task.input?.headline ? ['พาดหัว'] : []), ...(task.input?.subhead ? ['บรรทัดรอง'] : [])],
      images: [`${base}/r${tag}-1.png`, ...frame().crops.map((c) => `${base}/r${tag}-1-${c.name}.png`)],
      crops: frame().crops.map((c) => ({ name: c.name, image: `${base}/r${tag}-1-${c.name}.png` })),
      frame: task.input?.frame || 'feed',
      document: `${base}/r${tag}.vectorcraft`,
      checks,
      needsYou: youList,
      note: work.plan.concept || '',
      reviewNote: selfPlanned ? 'รอหนิงตรวจ (หนิงเป็นผู้วางแผน ไม่มีคะแนนจากผัง)' : `${last.pass ? 'ผ่าน' : 'ยังไม่ผ่าน'} ${last.score}/10${checks.length > 1 ? ` · แก้เอง ${checks.length - 1} รอบ` : ''}`
        + (!last.pass && last.issues.length ? ` · ติด ${last.issues.length} ข้อ` : '')
        + (youList.length ? ` · รอหนิงตัดสิน ${youList.length} เรื่อง` : ''),
    },
    sessionId: null,
  };
}

// Step 3 — ประกอบ: one named VectorCraft layer per piece (bottom → top) and a
// flat PNG of the same document for the review card.
const TASAKI_LOGO_WHITE = path.join(WEBSITE_REPO, 'public', 'tasaki-white noBG.png');

// Brand pieces from her own ads: blue corner panel + white logo, model name
// over the unit, a two-line headline (white, then cyan) and a Tasaki-blue sub
// line. All live text, so she restyles freely.
// Her blade kit is the default behind the logo; the old blue ellipse only
// if that file is ever missing.
const DEFAULT_LOGO_PANEL = 'shapes/tasaki-blade-kit/blade-gradient.svg';

function overlaySteps({ headline, subhead, model, headlineZone, subheadZone, productRect, proof, textStyles = [], logoPanel }, kit) {
  if (!logoPanel) { try { kitFile(DEFAULT_LOGO_PANEL); logoPanel = DEFAULT_LOGO_PANEL; } catch { /* keep the ellipse */ } }
  // Everything that must survive the crops sits inside the safe zone.
  const oy = safeTop();
  const bottom = safeBottom();
  // A Tasaki blade from her kit behind the logo, else the plain blue corner.
  const steps = logoPanel
    ? [['layer.new', { name: 'แถบโลโก้', top: true }], ['file.place', { path: kitFile(logoPanel), link: false, rect: fitRect(logoPanel, [-140, oy - 230, 760, 0]) }]]
    : [
      ['layer.new', { name: 'แถบโลโก้', top: true }],
      ['shape.ellipse', { x: -420, y: -560 + oy, width: 1040, height: 860, rotation: -12 }],
      ['paint.setFill', { color: kit.panel }],
      ['paint.setStroke', { none: true }],
    ];
  // Her text templates come from the style library, loaded once.
  if (textStyles.some((k) => TEXT_STYLES[k])) steps.push(loadTextStylesStep());
  if (fs.existsSync(TASAKI_LOGO_WHITE)) steps.push(['file.place', { path: TASAKI_LOGO_WHITE, link: false, rect: [44, 52 + oy, 300, 80] }]);
  // ประกอบ's guarantees, whatever box ผัง leaves: a headline area at least
  // 560x280 inside the canvas, point text sized from the line's length (so
  // nothing is clipped).
  let [hx, hy, hw, hh] = cleanRect(headlineZone) || [60, oy + 470, 640, 300];
  hw = Math.max(hw, 560); hh = Math.max(hh, 280);
  hx = Math.min(Math.max(hx, 30), frame().size[0] - hw - 30); hy = Math.min(Math.max(hy, oy + 300), bottom - hh - 30);
  if (model && productRect) {
    steps.push(['layer.new', { name: 'ชื่อรุ่น', top: true }]);
    // Keep the label clear of the blue logo panel (top-left ~0–560 x 0–300).
    const lx = Math.min(Math.max(productRect[0] + productRect[2] * 0.4, productRect[1] < oy + 320 ? 600 : 0), frame().size[0] - 260);
    let ly = Math.max(oy + 40, productRect[1] - 22);
    // Above the unit it would run into the headline: put it under the unit.
    const hits = headline && lx < hx + hw && lx + 420 > hx && ly > hy - 10 && ly - 40 < hy + hh;
    if (hits) ly = Math.min(productRect[1] + productRect[3] + 46, bottom - 20);
    steps.push(['text.create', { x: lx, y: ly, text: model, size: 32, font: kit.modelFont.font, style: kit.modelFont.style, color: kit.model }]);
  }
  if (headline) {
    const words = headline.trim().split(/\s+/);
    const lines = words.length > 1 ? [words[0], words.slice(1).join(' ')] : [words[0]];
    const lineH = hh / lines.length;
    const visible = (t) => t.replace(/[\u0E31\u0E34-\u0E3A\u0E47-\u0E4E]/g, '').length;
    steps.push(['layer.new', { name: 'พาดหัว', top: true }]);
    lines.forEach((line, i) => {
      const indent = i * 40;
      const size = Math.round(Math.min(170, lineH * 0.82, (hw - indent) / (visible(line) * 0.66)));
      steps.push(['text.create', { x: hx + indent, y: Math.round(hy + i * lineH + size * 0.95), text: line, size, font: kit.headlineFont.font, style: kit.headlineFont.style }]);
      const styled = textStyleSteps(textStyles[i] ?? textStyles[0]);
      if (styled) steps.push(...styled);
      else steps.push(['text.setRangeStyle', { fill: i === 0 ? kit.headline1 : kit.headline2 }]);
    });
  }
  if (subhead) {
    let [sx, sy, sw, sh] = cleanRect(subheadZone) || [60, bottom - 180, 600, 110];
    sw = Math.max(sw, 480); sh = Math.max(sh, 90);
    sx = Math.min(Math.max(sx, 30), frame().size[0] - sw - 30); sy = Math.min(Math.max(sy, oy + 300), bottom - sh - 20);
    steps.push(['layer.new', { name: 'บรรทัดรอง', top: true }]);
    steps.push(['text.create', { x: sx, y: sy, text: subhead, size: Math.min(58, Math.round(sh * 0.5)), font: kit.subheadFont.font, style: kit.subheadFont.style, area: { width: sw, height: sh, fit: 'shrinkText' } }]);
    steps.push(['text.setRangeStyle', { fill: kit.subhead }]);
  }
  // Proof strip: live text from real product facts on a flat white panel (no
  // outline, no shadow). Only items whose source phrase was found in the
  // product data ever get here.
  if (proof?.items?.length) {
    const items = proof.items.slice(0, 4);
    const X = 40;
    const Y = bottom - 266;
    const WID = 1000;
    const HGT = 232;
    const FONT = { font: kit.subheadFont.font, style: kit.subheadFont.style };
    // Point text y is the baseline, so centre = top + half the box + ~0.35 em.
    // The type tool wraps Thai anywhere, so lines are broken on word
    // boundaries here and each line is its own text.
    const seg = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('th', { granularity: 'word' }) : null;
    const lines = (text, n, max) => {
      const words = seg ? [...seg.segment(String(text))].map((x) => x.segment) : String(text).match(/.{1,6}/g) || [];
      const out = [];
      let cur = '';
      for (const w of words) {
        if ((cur + w).length > n && cur) { out.push(cur.trim()); cur = ''; }
        cur += w;
      }
      if (cur.trim()) out.push(cur.trim());
      return out.slice(0, max);
    };
    const shown = (t) => t.replace(/[\u0E31\u0E34-\u0E3A\u0E47-\u0E4E]/g, '').length;
    steps.push(['layer.new', { name: 'แถบพิสูจน์', top: true }]);
    steps.push(['shape.rectangle', { x: X, y: Y, width: WID, height: HGT, radius: 26 }]);
    steps.push(['paint.setFill', { color: '#FFFFFF' }]);
    steps.push(['paint.setStroke', { none: true }]);
    if (proof.title) {
      const chipW = Math.min(560, 70 + shown(proof.title) * 17);
      steps.push(['shape.rectangle', { x: X + 24, y: Y - 26, width: chipW, height: 52, radius: 26 }]);
      steps.push(['paint.setFill', { color: kit.panel }]);
      steps.push(['paint.setStroke', { none: true }]);
      steps.push(['text.create', { x: X + 48, y: Y + 10, text: proof.title, size: 28, ...FONT, color: '#FFFFFF' }]);
    }
    const cw = (WID - 48) / items.length;
    // One label size for every cell: the longest label decides.
    // (the last cell has room to spare on the right, so it doesn't shrink the others)
    const fit = (it) => Math.floor((cw - 80) / (shown(it.label) * 0.6));
    const labelSize = Math.max(20, Math.min(26, ...(items.length > 1 ? items.slice(0, -1) : items).map(fit)));
    items.forEach((it, i) => {
      const cx = X + 24 + i * cw;
      steps.push(['shape.ellipse', { x: cx, y: Y + 52, width: 46, height: 46 }]);
      steps.push(['paint.setFill', { color: kit.panel }]);
      steps.push(['paint.setStroke', { none: true }]);
      steps.push(['text.create', { x: cx + 16, y: Y + 85, text: String(i + 1), size: 28, ...FONT, color: '#FFFFFF' }]);
      steps.push(['text.create', { x: cx + 58, y: Y + 85, text: it.label, size: labelSize, ...FONT, color: kit.model }]);
      lines(it.detail, 16, 4).forEach((ln, k) => {
        steps.push(['text.create', { x: cx + 58, y: Y + 122 + k * 28, text: ln, size: 20, ...FONT, color: '#33414f' }]);
      });
    });
  }
  return steps;
}

async function assembleLayers(dir, round, layers, overlays, kit) {
  const doc = path.join(dir, `r${round}.vectorcraft`);
  const png = path.join(dir, `r${round}-1.png`);
  const steps = [['file.new', { name: `Tasaki ad r${round}`, width: frame().size[0], height: frame().size[1], units: 'Pixels' }]];
  layers.forEach((l, i) => {
    steps.push(i === 0 ? ['layer.setProps', { name: l.name }] : ['layer.new', { name: l.name, top: true }]);
    steps.push(['file.place', { path: l.file, link: false, rect: l.rect }]);
  });
  if (overlays) steps.push(...overlaySteps(overlays, kit));
  // Her default for every ad: crop lines + Story/Reel simulation, hidden.
  steps.push(...guideSteps(frame()));
  steps.push(['file.saveAs', { path: doc }]);
  const args = ['run', ...steps.flatMap(([id, params]) => ['--cmd', id, '--params', JSON.stringify(params)]), '--export', png];
  const { code, stderr } = await runProcess(craftBin('vectorcraft'), args, { cwd: dir });
  if (code !== 0 || !fs.existsSync(doc) || !fs.existsSync(png)) throw new Error(`ประกอบไฟล์ VectorCraft ไม่สำเร็จ ${stderr.slice(-200)}`);
  if (deps.vectorTeaching) await deps.vectorTeaching.applyLessons(doc, png, { id: path.basename(dir), agent: 'assemble', prompt: '', rounds: 0 });
  exportCrops(png);
}

// r1-1.png → r1-1-4x5.png, r1-1-1x1.png: the crops of the one master.
function exportCrops(png) {
  const crops = frame().crops;
  for (const c of crops) {
    // Same interpreter as runPil (the one with Pillow), run from / like it.
    execFileSync('/usr/bin/python3', ['-c', 'import sys\nfrom PIL import Image\nx,y,w,h=map(int,sys.argv[3:7])\nImage.open(sys.argv[1]).crop((x,y,x+w,y+h)).save(sys.argv[2])',
      png, png.replace(/\.png$/, `-${c.name}.png`), ...c.rect.map(String)], { cwd: '/' });
  }
  return crops.map((c) => ({ name: c.name, file: png.replace(/\.png$/, `-${c.name}.png`) }));
}

// The newest image job that has a picture to continue from (a layered
// VectorCraft file unless anyImage).
async function latestImageTask(prisma, anyImage = false) {
  const rows = await prisma.agentTask.findMany({
    where: { agent: 'image', status: { in: ['review', 'done', 'rejected'] } },
    orderBy: { updatedAt: 'desc' }, take: 20,
  });
  const ok = (t) => (anyImage ? t.result?.images?.length : t.result?.document && t.result?.layerFiles?.length);
  return rows.find((t) => t.status === 'review' && ok(t)) || rows.find(ok) || null;
}

// One image job passes through several agents; each step is said by the
// agent actually doing it, under the name she gave it.
const STAGE_OWNER = { plan: 'layout', review: 'layout', generate: 'image', assemble: 'assemble', motion: 'motion' };
const STAGE_DOING = { review: 'กำลังตรวจภาพที่ประกอบเสร็จ', plan: 'กำลังวางผังภาพ', generate: 'กำลังเจนภาพและไดคัท', assemble: 'กำลังรวมเลเยอร์ใน VectorCraft', motion: 'กำลังทำแอนิเมชันใน EffectCraft' };
function speakerFor(task, stage) {
  if (task.agent !== 'image') return task.agent;
  return STAGE_OWNER[stage || task.result?.stage || 'plan'] || 'layout';
}

async function setStage(prisma, task, stage) {
  await prisma.agentTask.update({ where: { id: task.id }, data: { result: { ...(task.result || {}), stage } } });
  const owner = STAGE_OWNER[stage] || task.agent;
  await logEvent(prisma, owner, `${AGENTS[owner]?.name || ''} ${STAGE_DOING[stage] || ''}`.trim(), task.id);
}

// No product attached: plain illustration straight from Codex.
async function runCodexFreeImage(task, prisma, dir, round) {
  const bin = codexBin();
  if (!bin) throw new Error('ไม่พบ Codex บนเครื่องนี้');
  const previous = (task.result?.images || []).map((u) => path.join(ROOT, 'public', u)).filter((p) => fs.existsSync(p));
  const refs = attachmentFiles(task);
  const prompt = `ใช้เครื่องมือ image_gen สร้างภาพสำหรับงานการตลาดของ Tasaki Air (แบรนด์แอร์ไทย สีหลักฟ้า Tasaki Blue ขาว และกรมท่า #001222)
ข้อห้าม: ห้ามทำภาพที่ดูเหมือนรูปถ่ายสินค้าจริงของ Tasaki และห้ามใส่โลโก้ Tasaki เอง ให้เป็นภาพประกอบหรือกราฟิก
ถ้าไม่ได้ระบุจำนวนให้ทำ 1 ภาพ (มากสุด 3 ภาพ)
${previous.length ? `ภาพแนบลำดับที่ 1–${previous.length} คือเวอร์ชันก่อนหน้า ผู้สั่งขอให้แก้: ${task.feedback}\n` : ''}${refs.length ? `ภาพแนบลำดับที่ ${previous.length + 1}–${previous.length + refs.length} คือภาพอ้างอิงที่ผู้สั่งแนบมา ใช้เป็นแนวทางตามคำสั่ง\n` : ''}${learningNote(await rejectLearnings(prisma, 'image', 20))}${teachingNote(await taughtNotes(prisma, 'image'))}${rulesNote(await combinedRules(prisma, 'image'))}
คำสั่งงาน: ${task.prompt}

เมื่อสร้างเสร็จ ให้คัดลอกไฟล์ภาพทั้งหมดมาไว้ในโฟลเดอร์ปัจจุบัน ตั้งชื่อ r${round}-1.png, r${round}-2.png ตามลำดับ
แล้วตอบสั้นๆ เป็นภาษาไทยว่าทำภาพอะไรไป`;
  const lastMsg = path.join(dir, `r${round}-message.txt`);
  await runProcess(bin, [
    'exec', '--skip-git-repo-check', '--sandbox', 'workspace-write', '-C', dir, '-o', lastMsg,
    ...previous.map((p) => `--image=${p}`),
    ...refs.map((f) => `--image=${f}`),
  ], { cwd: dir, input: prompt });
  const images = fs.readdirSync(dir)
    .filter((f) => f.startsWith(`r${round}-`) && /\.(png|jpe?g|webp)$/i.test(f))
    .sort()
    .map((f) => `/uploads/agent-images/${task.id}/${f}`);
  if (!images.length) throw new Error('Codex ไม่ได้ส่งภาพกลับมา');
  let note = '';
  // Codex tends to end with a markdown link to the local file; the page shows the image itself.
  try { note = fs.readFileSync(lastMsg, 'utf8').replace(/\[[^\]]*\]\([^)]*\)/g, '').trim(); } catch {}
  return { result: { images, note }, sessionId: null };
}

// เวก: one Codex run per job in the job's own folder (inside VectorCraft's
// automation root, so the SVGs open there too). Sources are her attachments
// or, for jobs queued by script, input.sources (files on this machine).
const BRAND_BOLD_FONT = path.join(WEBSITE_REPO, 'app', 'Frutiger Font', 'Frutiger THAI Neue Loop Less_TASAKI', 'OTF', 'LT_46529TH.otf');
async function runVectorize(task, prisma) {
  const bin = codexBin();
  if (!bin) throw new Error('ไม่พบ Codex บนเครื่องนี้');
  const listed = (Array.isArray(task.input?.sources) ? task.input.sources : []).map(String)
    .filter((f) => path.isAbsolute(f) && fs.existsSync(f) && /\.(png|jpe?g|webp)$/i.test(f));
  const sources = [...attachmentFiles(task), ...listed];
  if (!sources.length) throw new Error('ยังไม่มีภาพต้นฉบับ แนบภาพ PNG/JPG/WebP ที่จะแกะมาด้วย');
  const round = task.rounds + 1;
  const dir = path.join(IMAGES_DIR, task.id, `r${round}`);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  const names = sources.map((f, i) => {
    const base = (task.input?.names?.[i] || path.basename(f, path.extname(f))).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '') || `item${i + 1}`;
    fs.copyFileSync(f, path.join(dir, 'src', `${base}${path.extname(f).toLowerCase()}`));
    return { base, file: `src/${base}${path.extname(f).toLowerCase()}` };
  });
  fs.copyFileSync(BRAND_BOLD_FONT, path.join(dir, 'FrutigerNeueLTPro-Bold.otf'));
  const prev = task.feedback && (task.result?.svgs || []).map((u) => path.join(ROOT, 'public', u.split('?')[0])).filter((f) => fs.existsSync(f));
  if (prev?.length) { fs.mkdirSync(path.join(dir, 'previous'), { recursive: true }); for (const f of prev) fs.copyFileSync(f, path.join(dir, 'previous', path.basename(f))); }
  await logEvent(prisma, 'vector', `ใช้ Codex สร้างเวกเตอร์ใหม่ ${names.length} ชิ้น`, task.id);
  const prompt = `งาน: สร้างภาพต้นฉบับ (ภาพเล็ก) ให้เป็นไฟล์เวกเตอร์ SVG ที่สะอาด ครบ คม สำหรับแบรนด์แอร์ Tasaki
ต้นฉบับ (ในโฟลเดอร์นี้):
${names.map((n) => `- ${n.file} → เขียนผลเป็น ${n.base}.svg และภาพเทียบ ${n.base}-compare.png (ต้นฉบับขยาย | ผลงาน)`).join('\n')}
${prev?.length ? `รอบก่อนอยู่ในโฟลเดอร์ previous/ หนิงขอให้แก้: ${task.feedback} (แก้ต่อจากรอบก่อน ไม่ต้องเริ่มใหม่ทั้งหมด)\n` : ''}${learningNote(await rejectLearnings(prisma, 'vector', 20))}${rulesNote(await combinedRules(prisma, 'vector'))}
คำสั่งเพิ่มเติม: ${task.prompt || '-'}
ทำงานในโฟลเดอร์นี้เท่านั้น เขียน .svg และ -compare.png ไว้ที่โฟลเดอร์หลักนี้ (ไม่ใช่โฟลเดอร์ย่อย) เก็บสคริปต์ไว้ในโฟลเดอร์ work/ (การย้ายเข้าคลังระบบทำเองหลังหนิงอนุมัติ)`;
  const lastMsg = path.join(dir, 'message.txt');
  const { code, stdout, stderr } = await runProcess(bin, ['exec', '--skip-git-repo-check', '--sandbox', 'workspace-write', '-C', dir, '-o', lastMsg], { cwd: dir, input: prompt });
  if (code !== 0) throw new Error((stderr || stdout).trim().slice(-600) || 'Codex ทำงานไม่สำเร็จ');
  // Codex sometimes writes into a subfolder (e.g. badges/): find each output anywhere but src/work/previous.
  const found = (file) => {
    const walk = (d, depth) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isFile() && e.name === file) return p;
        if (e.isDirectory() && depth < 3 && !['src', 'work', 'previous'].includes(e.name)) { const hit = walk(p, depth + 1); if (hit) return hit; }
      }
      return null;
    };
    return walk(dir, 0);
  };
  const url = (f) => `/uploads/agent-images/${task.id}/r${round}/${path.relative(dir, f).split(path.sep).map(encodeURIComponent).join('/')}?v=${Date.now()}`;
  const done = names.map((n) => ({ ...n, svg: found(`${n.base}.svg`), compare: found(`${n.base}-compare.png`) })).filter((n) => n.svg);
  if (!done.length) throw new Error('Codex ไม่ได้ส่งไฟล์ SVG กลับมา');
  let note = '';
  try { note = fs.readFileSync(lastMsg, 'utf8').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim(); } catch {}
  return {
    result: {
      svgs: done.map((n) => url(n.svg)),
      images: done.map((n) => url(n.compare || n.svg)),
      missing: names.filter((n) => !done.some((d) => d.base === n.base)).map((n) => n.base),
      note: note.slice(0, 1500),
    },
    sessionId: null,
  };
}

// มูฟ's AI picks the motion; the server only builds moves from this short
// list, so no fades or staggered pop-ins can sneak in.
const ENTRANCES = ['none', 'snap-drop', 'snap-scale', 'slide-left', 'slide-right', 'slide-up'];
const MOTION_SCHEMA = {
  type: 'object',
  properties: {
    duration: { type: 'number' },
    push: { type: 'number' },
    layers: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, entrance: { type: 'string', enum: ENTRANCES }, at: { type: 'number' }, length: { type: 'number' } }, required: ['name', 'entrance', 'at', 'length'] } },
    note: { type: 'string' },
  },
  required: ['duration', 'push', 'layers', 'note'],
};

async function directMotion(task, prisma, source, layers, mk) {
  const image = source.result?.images?.[0] && path.join(ROOT, 'public', source.result.images[0].split('?')[0]);
  const director = {
    speaker: 'motion', rulesAgent: 'motion', model: 'sonnet', tools: [], images: image && fs.existsSync(image) ? [image] : [], schema: MOTION_SCHEMA,
    async buildPrompt() {
      return `${BRAND_NOTE}

หน้าที่: คุณคือมูฟ ผู้กำกับโมชันของแอด ${frame().size[0]}x${frame().size[1]} ดูภาพที่ประกอบเสร็จที่แนบมา แล้ววางจังหวะเคลื่อนไหวให้คลิปสั้นที่ดูพรีเมียม
${task.prompt ? `โจทย์จากหนิง: ${task.prompt}\n` : ''}เลเยอร์ (ล่าง → บน) พร้อมกรอบ [x, y, กว้าง, สูง]:
${layers.map((l) => `- ${l.name} ${JSON.stringify(l.rect)}`).join('\n')}

ค่าเริ่มต้นจากกฎ: ยาว ${mk.duration} วินาที ซูมเข้าทั้งฉาก ${Math.round(mk.push * 100)}% แอร์สแนปเข้าที่ ${mk.snapAt} วินาที ใช้เวลา ${mk.snapLen} วินาที
สไตล์ของหนิง (ห้ามฝ่า): ไม่มีเฟด ทุกอย่างเข้าแบบสแนปเร็ว (length 0.1–0.35) ห้ามทยอยโผล่ทีละชิ้น มีชิ้นที่เคลื่อนเข้าได้ไม่เกิน 2 ชิ้น ที่เหลือ entrance "none" อยู่นิ่งตั้งแต่เฟรมแรก ฉากหลังและคนห้ามเคลื่อนเข้า สินค้าจริงกับเงาสินค้าต้องเข้าพร้อมกันด้วยท่าเดียวกัน
entrance ที่ใช้ได้: none, snap-drop (ตกลงจากด้านบน), snap-scale (ขยายเข้าที่), slide-left / slide-right (เลื่อนจากซ้าย/ขวา), slide-up (เลื่อนขึ้นจากด้านล่าง)
ตอบ duration (วินาที 2–30) push (% ซูมเข้า 0–30) layers (ใส่ทุกเลเยอร์ตามชื่อเดิม) at (วินาทีที่เริ่มเข้า) length และ note สั้นๆ ภาษาไทยว่าคลิปเล่าอะไร`;
    },
  };
  const { result } = await runLanguageAgent(director, task, prisma, deps);
  const num = (v, min, max, d) => Math.min(max, Math.max(min, Number.isFinite(Number(v)) ? Number(v) : d));
  const duration = num(result.duration, 2, 30, mk.duration);
  const byName = new Map((result.layers || []).map((l) => [l.name, l]));
  return {
    duration,
    push: num(result.push, 0, 30, mk.push * 100) / 100,
    note: String(result.note || '').slice(0, 300),
    moves: layers.map((l) => {
      const m = byName.get(l.name);
      const entrance = ENTRANCES.includes(m?.entrance) ? m.entrance : 'none';
      return { entrance, at: entrance === 'none' ? 0 : num(m.at, 0, duration - 0.5, mk.snapAt), length: num(m?.length, 0.05, 1, mk.snapLen) };
    }),
  };
}

// The fixed motion from before the AI: push-in plus the product dropping in.
function defaultMotion(layers, mk) {
  return {
    duration: mk.duration, push: mk.push, note: '',
    moves: layers.map((l) => (l.product ? { entrance: 'snap-drop', at: mk.snapAt, length: mk.snapLen } : { entrance: 'none', at: 0, length: 0 })),
  };
}

// Step 4 — มูฟ: the same layers as an EffectCraft comp. Her motion style: a
// slow push-in on the whole scene and the product snapping in fast — no
// fades, no staggered pop-ins. Every layer gets the same scale-about-centre
// so people stay sitting where the plan put them.
async function runMotion(task, prisma) {
  const source = await prisma.agentTask.findUnique({ where: { id: task.input?.sourceTaskId || '' } });
  const files = source?.result?.layerFiles;
  if (!files?.length) throw new Error('ภาพต้นทางไม่มีไฟล์แยกเลเยอร์');
  const srcDir = path.join(IMAGES_DIR, source.id);
  const dir = path.join(IMAGES_DIR, task.id);
  fs.mkdirSync(dir, { recursive: true });
  await setStage(prisma, task, 'motion');
  const mk = await motionKit(prisma);
  const [cx, cy] = [frame().size[0] / 2, frame().size[1] / 2];
  const layers = files.map((f) => ({ ...f, file: path.join(srcDir, f.file), product: f.name.indexOf('สินค้าจริง') === 0 || f.name === 'เงาสินค้า' }))
    .filter((f) => fs.existsSync(f.file) && f.file.startsWith(srcDir + path.sep));
  let motion;
  try {
    motion = await directMotion(task, prisma, source, layers, mk);
  } catch (e) {
    await logEvent(prisma, 'motion', `วางจังหวะด้วย AI ไม่สำเร็จ ใช้ท่าเดิม (${e.message.slice(0, 120)})`, task.id);
    motion = defaultMotion(layers, mk);
  }
  const DUR = motion.duration;
  const PUSH = motion.push;
  // Offset at the start of each entrance: [dx, dy, scale multiplier].
  const OFFSETS = { 'snap-drop': [0, -mk.drop, 1], 'snap-scale': [0, 0, 0.82], 'slide-left': [-240, 0, 1], 'slide-right': [240, 0, 1], 'slide-up': [0, 160, 1] };
  const jsx = `var comp = app.project.items.addComp("Tasaki ad motion", ${frame().size[0]}, ${frame().size[1]}, 1, ${DUR}, 30);
var L = ${JSON.stringify(layers.map((l, i) => {
    const m = motion.moves[i];
    return { name: l.name, file: l.file, rect: l.rect, at: m.at, end: Math.min(DUR, m.at + m.length), off: OFFSETS[m.entrance] || null };
  }))};
function k(t) { return 1 + ${PUSH} * t / ${DUR}; }
for (var i = 0; i < L.length; i++) {
  var l = L[i];
  var item = app.project.importFile(new ImportOptions(new File(l.file)));
  var layer = comp.layers.add(item);
  layer.name = l.name;
  var fit = Math.min(l.rect[2] / item.width, l.rect[3] / item.height);
  var px = l.rect[0] + l.rect[2] / 2, py = l.rect[1] + l.rect[3] / 2;
  var pos = layer.property("Transform").property("Position");
  var sc = layer.property("Transform").property("Scale");
  var times = l.off ? [l.at, l.end, ${DUR}] : [0, ${DUR}];
  for (var j = 0; j < times.length; j++) {
    var t = times[j], kk = k(t), o = (l.off && j === 0) ? l.off : [0, 0, 1];
    pos.setValueAtTime(t, [${cx} + (px - ${cx}) * kk + o[0], ${cy} + (py - ${cy}) * kk + o[1]]);
    sc.setValueAtTime(t, [fit * 100 * kk * o[2], fit * 100 * kk * o[2]]);
  }
  if (l.off) layer.inPoint = l.at;
}
app.project.save(new File(${JSON.stringify(path.join(dir, 'motion.ecproj'))}));
writeLn("ok " + comp.numLayers);`;
  const jsxFile = path.join(dir, 'motion.jsx');
  fs.writeFileSync(jsxFile, jsx);
  const built = await runProcess(craftBin('effectcraft'), ['script', jsxFile], { cwd: dir });
  if (built.code !== 0 || !fs.existsSync(path.join(dir, 'motion.ecproj'))) throw new Error(`สร้างโปรเจกต์ EffectCraft ไม่สำเร็จ ${(built.stderr || built.stdout).slice(-200)}`);
  const rendered = await runProcess(craftBin('effectcraft'), ['render', '--project', 'motion.ecproj', '--comp', 'Tasaki ad motion', '--out', 'motion.mp4', '--format', 'h264'], { cwd: dir });
  if (rendered.code !== 0 || !fs.existsSync(path.join(dir, 'motion.mp4'))) throw new Error(`เรนเดอร์คลิปไม่สำเร็จ ${(rendered.stderr || rendered.stdout).slice(-200)}`);
  const base = `/uploads/agent-images/${task.id}`;
  return {
    result: { stage: 'done', video: `${base}/motion.mp4`, project: `${base}/motion.ecproj`, note: motion.note || `คลิป ${DUR} วินาที ฉากค่อยๆ ซูมเข้า ${Math.round(PUSH * 100)}%` },
    sessionId: null,
  };
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
    case 'caption': return `${clip(r.caption, 600)}${more}`;
    case 'ads': return `${clip([r.summary, ...(r.highlights || []).slice(0, 3).map((x) => `• ${x}`)].filter(Boolean).join('\n'), 800)}${more}`;
    case 'adideas':
    case 'productvideo': return `${clip(r.summary, 300)}\nคิดให้ ${(r.ideas || []).length} ไอเดีย\n${titles.join('\n')}${more}`.trim();
    case 'website': return `สรุปความเปลี่ยนแปลงเว็บให้ ${(r.entries || []).length} รายการ${more}`;
    case 'image':
      if (r.stage === 'planned') {
        const p = r.plan || {};
        const sup = (p.supports || []).map((x) => ROLE_TH[x.role] || x.role).join(', ');
        const gfx = (p.elements || []).map((e) => e.name).join(', ');
        return `แผนพร้อมให้รีวิว (ยังไม่ได้เจนภาพ)\nพระเอก: ${p.hero?.matchesAttached ? `รูปจริง${ROLE_TH[p.hero.role] || ''}` : 'ไม่มีรูปที่ตรง'} — ${clip(p.hero?.what, 160)}\nตัวรอง: ${sup || 'ไม่ใช้'} · GEN วาด: ${gfx || 'ฉากอย่างเดียว'}\nแนวทาง: ${(CREATIVE_DEVICES.find((d) => d.key === p.device) || {}).label || p.device || '-'} — ${clip(p.hook, 200)}${p.proof?.items?.length ? `\nแถบพิสูจน์ ${p.proof.items.length} ช่อง: ${p.proof.items.map((x) => x.label).join(' · ')}${p.proof.dropped ? ` (สคริปต์ตัด ${p.proof.dropped} ช่องที่ไม่มีในข้อมูลจริง)` : ''}` : ''}\nทางเลือกอื่น: ${(p.alternatives || []).map((a) => `${(CREATIVE_DEVICES.find((d) => d.key === a.device) || {}).label || a.device}`).join(' / ') || '-'} (พิมพ์ใน ✎ แก้ ได้ เช่น “เอาแบบลอยตัว”)\nแสง: ${p.light} (${p.lightConfidence}) · กล้อง: ${p.camera}\n${clip(p.concept, 400)}${more}`;
      }
      return `${[r.reviewNote, r.note].filter(Boolean).join('\n') || 'ภาพเสร็จแล้ว'}${more}`;
    case 'assemble': return `${clip(r.summary, 900)}${r.lesson?.rule && r.mode === 'study' ? '\n📘 ร่างบทเรียนไว้ที่การ์ดแล้ว กดยืนยันถ้าถูกต้อง' : more}`;
    case 'motion': return `${clip(r.note, 300) || 'คลิปเสร็จแล้ว'}${more}`;
    case 'vector': return `แกะเวกเตอร์เสร็จ ${(r.svgs || []).length} ชิ้น${(r.missing || []).length ? ` (ไม่สำเร็จ: ${r.missing.join(', ')})` : ''}\n${clip(r.note, 500)}${more}`;
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
      // A plan-only review is one call and generates nothing, so it runs too,
      // as does a job she asked for explicitly while the team was paused.
      ? await prisma.agentTask.findFirst({ where: { status: 'queued', OR: [{ agent: 'image', input: { path: ['planOnly'], equals: true } }, { input: { path: ['allowWhilePaused'], equals: true } }] }, orderBy: { createdAt: 'asc' } })
      : await prisma.agentTask.findFirst({ where: { status: 'queued' }, orderBy: { createdAt: 'asc' } }));
  if (!task) return;
  const agent = AGENTS[task.agent];
  busy = true;
  const started = Date.now();
  try {
    await prisma.agentTask.update({ where: { id: task.id }, data: { status: 'running', startedAt: new Date(), error: '' } });
    const first = speakerFor(task, 'plan');
    await logEvent(prisma, first, `${AGENTS[first]?.name || agent.name} รับงาน: ${(task.prompt || agent.role).slice(0, 80)}`, task.id);
    const { result, sessionId } = task.agent === 'assemble'
      ? await (task.input?.mode === 'demonstration' ? deps.vectorTeaching.learn(task)
        : task.input?.mode === 'study' ? deps.vectorTeaching.study(task) : deps.vectorTeaching.edit(task))
      : task.agent === 'image' ? await frameStore.run(frameFor(task), () => runImagePipeline(task, prisma))
      : task.agent === 'motion' ? await frameStore.run(frameFor(task), () => runMotion(task, prisma))
      : task.agent === 'vector' ? await runVectorize(task, prisma)
      : task.agent === 'ads' && task.input?.mode === 'daily' ? await runAdDaily(task, prisma)
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
    if (e instanceof WaitingForFile) {
      await prisma.agentTask.update({ where: { id: task.id }, data: { status: 'waiting', error: e.message, finishedAt: new Date(), durationMs: Date.now() - started } }).catch(() => {});
      await logEvent(prisma, 'layout', `${AGENTS.layout.name} รอไฟล์สินค้า: ${e.message}`, task.id, { kind: 'handoff', toAgent: 'you' });
      return;
    }
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

// Once she has saved her own edits in VectorCraft, a fix must not regenerate
// the pieces and re-assemble from scratch (that throws her edits away). It goes
// to VEC, which edits the file she saved.
async function handToVec(prisma, task, text) {
  const vec = await prisma.agentTask.create({ data: { agent: 'assemble', prompt: text, input: { sourceTaskId: task.id, mode: 'edit', live: true } } });
  await prisma.agentTask.update({ where: { id: task.id }, data: { status: 'done', decidedAt: new Date() } });
  await logEvent(prisma, 'you', `✎ ${text}`, vec.id, { kind: 'handoff', toAgent: 'assemble' });
  await logEvent(prisma, 'layout', `หนิงแก้ไฟล์เองแล้ว จึงส่งต่อให้ ${AGENTS.assemble.name} แก้ต่อจากไฟล์ของหนิง ไม่เจนชิ้นส่วนใหม่ (กันของที่หนิงแก้พัง)`, vec.id);
  return vec;
}

// ─── Her saves in VectorCraft refresh the picture ────────────────────────────
// The pictures on the page are PNGs rendered from the layered .vectorcraft
// files. When she edits one in VectorCraft and saves, the PNG is re-rendered in
// place and the page reloads it (pictureVersions → ?v= on every <img>).
// The team's own writes are ignored: nothing is re-rendered while a job runs,
// and .history backups are skipped.
const pictureVersions = new Map();
const watchTimers = new Map();

async function rerenderSaved(prisma, file) {
  const publicRoot = path.join(ROOT, 'public');
  const url = `/${path.relative(publicRoot, file).split(path.sep).join('/')}`;
  // Skip only files the running job itself is writing (its own folder, or the
  // project file a running VEC job edits); her saves elsewhere still count.
  const running = await prisma.agentTask.findMany({ where: { status: 'running', agent: { in: ['image', 'assemble', 'motion'] } } });
  const writing = (t) => file.startsWith(path.join(IMAGES_DIR, t.id) + path.sep)
    || (t.input?.projectFile && path.join(publicRoot, String(t.input.projectFile).split('?')[0]) === file);
  if (running.some(writing)) return;
  const tasks = await prisma.agentTask.findMany({ where: { agent: { in: ['image', 'assemble'] } }, orderBy: { createdAt: 'desc' }, take: 120 });
  const hit = tasks.find((t) => String(t.result?.document || '').split('?')[0] === url);
  // The PNG shown for that file: the task's own picture, else rN.vectorcraft → rN-1.png
  const png = String(hit?.result?.images?.[0] || '').split('?')[0] || url.replace(/\/(r\d+[a-z]?)\.vectorcraft$/, '/$1-1.png');
  if (!png.endsWith('.png') || !png.startsWith('/uploads/agent-images/')) return;
  const target = path.join(publicRoot, png);
  if (!target.startsWith(IMAGES_DIR + path.sep)) return;
  const tmp = `${target}.saving.png`;
  // The check-only guide layers ("… (ไม่พิมพ์)") stay out of the picture even
  // if she saved with them switched on; the export does not skip them itself.
  const found = await runProcess(craftBin('vectorcraft'), ['run', '--in', file, '--cmd', 'document.find', '--params', JSON.stringify({ name: '(ไม่พิมพ์)', kind: 'Layer' })], { cwd: path.dirname(file) });
  const guides = String(found.stdout || '').split('\n').flatMap((l) => { try { return JSON.parse(l).result?.matches || []; } catch { return []; } }).map((m) => m.id);
  const hide = guides.length ? ['--cmd', 'layer.setProps', '--params', JSON.stringify({ ids: guides, visible: false })] : [];
  const out = await runProcess(craftBin('vectorcraft'), ['run', '--in', file, ...hide, '--export', tmp], { cwd: path.dirname(file) });
  if (out.code !== 0 || !fs.existsSync(tmp)) { try { fs.rmSync(tmp, { force: true }); } catch {} return; }
  fs.renameSync(tmp, target);
  const version = Date.now();
  pictureVersions.set(png, version);
  // Remember that this job's file now holds her edits.
  const owner = await prisma.agentTask.findUnique({ where: { id: path.relative(IMAGES_DIR, file).split(path.sep)[0] } }).catch(() => null);
  // The 4:5 / 1:1 crops follow her saved master, not the team's last build,
  // and get the same ?v= so the page reloads them too (not only the 9:16).
  const crops = owner ? frameStore.run(frameFor(owner), () => {
    try { return exportCrops(target).map((c) => png.replace(/\.png$/, `-${c.name}.png`)); }
    catch (e) { console.error('export crops:', e.message); return []; }
  }) : [];
  for (const crop of crops) pictureVersions.set(crop, version);
  if (owner && owner.agent === 'image') {
    // Her save is the version that counts: the card and chat show the round she
    // saved, even if the team had picked another round as its result.
    const data = {};
    if (!owner.input?.heldByHer) data.input = { ...(owner.input || {}), heldByHer: true };
    if (owner.result && String(owner.result.document || '').split('?')[0] !== url) data.result = { ...owner.result, document: url, images: [png, ...crops].map((p) => `${p}?v=${version}`), crops: crops.map((p) => ({ name: /-(\w+)\.png$/.exec(p)[1], image: `${p}?v=${version}` })) };
    if (Object.keys(data).length) await prisma.agentTask.update({ where: { id: owner.id }, data }).catch(() => {});
  }
  await logEvent(prisma, hit?.agent === 'image' ? 'assemble' : (hit?.agent || 'assemble'), `🖼 ภาพอัปเดตตามไฟล์ที่หนิงบันทึกใน VectorCraft (${path.basename(file)})`, hit?.id || null);
}

function watchSavedVectorFiles(prisma) {
  const startedAt = Date.now();
  try {
    fs.watch(IMAGES_DIR, { recursive: true }, (event, name) => {
      if (!name || !String(name).endsWith('.vectorcraft') || String(name).includes('.history') || Date.now() - startedAt < 5000) return;
      const file = path.join(IMAGES_DIR, String(name));
      clearTimeout(watchTimers.get(file));
      // Wait until the save has settled (VectorCraft writes in several steps).
      watchTimers.set(file, setTimeout(() => {
        watchTimers.delete(file);
        if (!fs.existsSync(file)) return;
        rerenderSaved(prisma, file).catch((e) => console.error('re-render saved file:', e.message));
      }, 2500));
    });
  } catch (e) { console.error('watch vectorcraft files:', e.message); }
}

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
  deps.vectorLive = createLiveVector({
    root: IMAGES_DIR, cli: () => craftBin('vectorcraft'), runProcess,
    onProgress: (event) => logEvent(prisma, 'assemble', `สด ${event.step}/${event.total}: ${event.command}`, event.taskId),
  });
  deps.vectorTeaching = createVectorTeaching({
    root: ROOT, prisma, runProcess, cli: () => craftBin('vectorcraft'), logEvent,
    live: deps.vectorLive,
    // VEC plans and judges vector edits on Opus (her choice, 2026-10-19).
    runModel: (agent, task) => runLanguageAgent({ model: AGENTS.assemble.model, ...agent }, task, prisma, deps),
  });
  if (RUNNER_ON) {
    // Anything left "running" belonged to a server that died mid-task.
    prisma.agentTask.updateMany({ where: { status: 'running' }, data: { status: 'queued' } }).catch(() => {});
    setInterval(() => { tick(prisma).catch((e) => console.error('agent runner:', e.message)); }, POLL_MS);
    setInterval(() => { scheduleDaily(prisma).catch((e) => console.error('daily summary:', e.message)); }, 60 * 1000);
    setInterval(() => { scheduleAdDaily(prisma).catch((e) => console.error('ad daily:', e.message)); }, 60 * 1000);
    setInterval(() => { scheduleRival(prisma).catch((e) => console.error('rival weekly:', e.message)); }, 60 * 1000);
    setInterval(() => { scheduleCatalogDaily(prisma).catch((e) => console.error('catalog daily:', e.message)); }, 60 * 1000);
    setInterval(() => { sweepCatalogBrands(prisma).catch((e) => console.error('catalog brands:', e.message)); }, 60 * 1000);
    watchSavedVectorFiles(prisma);
  }

  const requireRunner = (req, res, next) => (RUNNER_ON ? next() : res.status(403).json({ error: 'ทีม AI ใช้ได้เฉพาะบนเครื่อง Mac ของฝ่ายการตลาด' }));

  app.get('/api/agents', async (req, res) => {
    try {
      const engines = await enginePreferences(prisma);
      const [tasks, events, today, learnings, products, recent] = await Promise.all([
        prisma.agentTask.findMany({ orderBy: { createdAt: 'desc' }, take: 60 }),
        prisma.agentEvent.findMany({ where: { createdAt: { gte: startOfBangkokDay() } }, orderBy: { createdAt: 'desc' }, take: 100 }),
        RUNNER_ON ? runsToday(prisma) : 0,
        Promise.all([adLearnings(prisma, 40), rejectLearnings(prisma, null, 30), deps.vectorTeaching.lessons()])
          .then(([a, r, v]) => [...a.map((l) => ({ ...l, agent: 'adideas' })), ...r, ...v.map((l) => ({ agent: 'assemble', picked: true, title: l.title, reason: `${l.condition} — ${l.rule}` }))].slice(0, 90)),
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
      const STAGE_AGENT = { plan: 'layout', review: 'layout', generate: 'image', assemble: 'assemble', motion: 'motion' };
      const STAGE_DOING = { plan: 'วางผังภาพ', review: 'ตรวจภาพที่ประกอบเสร็จ', generate: 'เจนภาพและไดคัท', assemble: 'ประกอบเลเยอร์ใน VectorCraft', motion: 'ทำแอนิเมชัน' };
      for (const t of tasks.filter((x) => x.status === 'running')) {
        const stage = t.result?.stage;
        const who = (t.agent === 'image' || t.agent === 'motion') && STAGE_AGENT[stage] ? STAGE_AGENT[stage] : t.agent;
        slot(who).doing = { text: `${STAGE_DOING[stage] || 'ทำงาน'}: ${(t.prompt || '').slice(0, 80)}`, taskId: t.id };
      }
      const cardIds = [...new Set(tasks.map((t) => t.input?.cardId).filter(Boolean))];
      const cards = cardIds.length ? await prisma.card.findMany({ where: { id: { in: cardIds } }, select: { id: true, title: true } }) : [];
      const cardTitles = Object.fromEntries(cards.map((c) => [c.id, c.title]));
      res.json({
        runner: RUNNER_ON,
        vectorLive: deps.vectorLive.status(),
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
          pipelineStage: a.pipelineStage || null, vectorEditor: Boolean(a.vectorEditor), orderable: !a.fromImageOnly && (!a.pipelineStage || id === 'image' || a.vectorEditor),
          commandable: Boolean(a.vectorEditor || a.fromImageOnly) || id === 'layout',
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
    if (!def || (def.pipelineStage && agent !== 'image' && !def.vectorEditor)) return res.status(400).json({ error: 'สั่งฝ่ายนี้โดยตรงไม่ได้' });
    let text = typeof prompt === 'string' ? prompt.trim() : '';
    const raw = req.body.input && typeof req.body.input === 'object' ? req.body.input : {};
    // Only plain values from the browser; file paths are always resolved here.
    const input = {};
    for (const k of ['cardId', 'date', 'days', 'productModel', 'sourceTaskId', 'headline', 'subhead']) {
      if (typeof raw[k] === 'string' || typeof raw[k] === 'number') input[k] = raw[k];
    }
    if (!text && !def.needsCard && !def.fromImageOnly && !(agent === 'image' && raw.campaignId) && agent !== 'website' && agent !== 'ads' && agent !== 'catalog' && agent !== 'rival') return res.status(400).json({ error: 'ใส่คำสั่งงานก่อน' });
    if (def.needsCard && !input.cardId) return res.status(400).json({ error: 'เลือกการ์ดก่อน' });
    try {
      // From the chat box "@ประกอบ …" / "@มูฟ …" carry no picture: use the
      // latest finished layered image.
      if ((def.vectorEditor || def.fromImageOnly) && !input.sourceTaskId) {
        const latest = await latestImageTask(prisma);
        if (!latest) return res.status(400).json({ error: 'ยังไม่มีภาพแยกเลเยอร์ให้ทำต่อ' });
        input.sourceTaskId = latest.id;
      }
      if (def.vectorEditor) {
        if (!input.sourceTaskId) return res.status(400).json({ error: 'เลือกงาน VectorCraft ต้นทางก่อน' });
        // 📖 study reads the open file and changes nothing. Edits find their
        // project file when they run (the original source may be gone).
        input.mode = raw.mode === 'study' ? 'study' : 'edit';
        // She always watches ประกอบ's edits happen live in VectorCraft.
        input.live = true;
      }
      if (def.fromImageOnly) {
        const source = await prisma.agentTask.findUnique({ where: { id: String(input.sourceTaskId || '') } });
        if (!source?.result?.layerFiles?.length) return res.status(400).json({ error: 'ทำแอนิเมชันได้เฉพาะภาพที่มีไฟล์แยกเลเยอร์' });
        if (source.input?.frame) input.frame = source.input.frame;
      }
      // An ad of a campaign: the brief fills in product, headline, frame,
      // text style and the campaign's approved pictures (she can still override).
      let campaignRefs = [];
      if (agent === 'image' && typeof raw.campaignId === 'string' && raw.campaignId) {
        const brief = await campaignBrief(prisma, raw.campaignId, String(raw.adSet || ''));
        if (!brief) return res.status(400).json({ error: 'ไม่พบแคมเปญนี้' });
        Object.assign(input, { campaignId: brief.id, campaignName: brief.name, campaignNote: brief.note || '' });
        if (brief.ad) Object.assign(input, { adSet: brief.ad.adSet, adName: brief.ad.name });
        if (!input.productModel && brief.ad?.model) input.productModel = brief.ad.model;
        if (!input.headline && brief.headline) input.headline = brief.headline;
        if (FRAMES[brief.frame]) input.frame = brief.frame;
        if (brief.textStyle) input.textStyle = brief.textStyle;
        campaignRefs = (brief.refs || []).filter((u) => fs.existsSync(path.join(ROOT, 'public', u)));
        if (!text) text = `แอดแคมเปญ ${brief.name}${brief.ad ? ` · ${brief.ad.name}` : ''}`;
      }
      if (agent === 'image' && input.productModel) {
        const product = (await productCatalog(tasakiWebPool)).find((p) => p.model === input.productModel);
        if (!product?.image) return res.status(400).json({ error: 'ไม่พบรูปสินค้ารุ่นนี้' });
        input.productImage = product.image;
      }
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
      // A campaign job looks at her new pictures plus the campaign's, never at leftovers from other jobs.
      if (campaignRefs.length) input.attachments = [...attachments, ...campaignRefs].slice(0, 4);
      const task = await prisma.agentTask.create({ data: { agent, prompt: text || (def.fromImageOnly ? 'ทำแอนิเมชันจากภาพแยกเลเยอร์' : ''), input } });
      await logEvent(prisma, 'you', `${text || def.role}${attachments.length ? ` 📎 ${attachments.length} ภาพ` : ''}`, task.id, { kind: 'handoff', toAgent: agent, image: attachments[0] || null, detail: Object.keys(input).length ? JSON.stringify(input, null, 2) : null });
      res.status(201).json(task);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // "@ผัง …" from the chat box: her comment on the latest picture, routed by
  // ผัง like a ↻ (a finished/discarded picture is continued as a new job).
  app.post('/api/agents/layout/command', requireRunner, async (req, res) => {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim().slice(0, 2000) : '';
    if (!text) return res.status(400).json({ error: 'พิมพ์ด้วยว่าจะให้ผังทำอะไร' });
    try {
      const latest = await latestImageTask(prisma, true);
      if (!latest) return res.status(400).json({ error: 'ยังไม่มีภาพให้ผังแก้ สั่ง @พิมพ์ ทำภาพก่อน' });
      if (latest.input?.heldByHer && latest.result?.document) {
        const vec = await handToVec(prisma, latest, text);
        return res.status(201).json({ ok: true, taskId: vec.id });
      }
      const attachments = saveAttachments(req.body.attachments);
      const input = attachments.length ? { ...(latest.input || {}), attachments } : latest.input;
      let task;
      if (latest.status === 'review') {
        task = await prisma.agentTask.update({ where: { id: latest.id }, data: { status: 'queued', feedback: text, input } });
      } else {
        task = await prisma.agentTask.create({
          data: { agent: 'image', prompt: latest.prompt, input, result: latest.result, rounds: latest.rounds, feedback: text },
        });
      }
      await logEvent(prisma, 'you', `${text}${attachments.length ? ` 📎 ${attachments.length} ภาพ` : ''}`, task.id, { kind: 'handoff', toAgent: 'layout', image: attachments[0] || null });
      res.status(201).json({ ok: true, taskId: task.id });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/agents/vector-teaching/start', requireRunner, async (req, res) => {
    try {
      if (typeof req.body?.sourceTaskId !== 'string') return res.status(400).json({ error: 'เลือกงานต้นทางก่อน' });
      const task = await deps.vectorTeaching.start(req.body.sourceTaskId, typeof req.body.prompt === 'string' ? req.body.prompt.trim().slice(0, 8000) : '');
      res.status(201).json(task);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/agents/tasks/:id/vector-teaching/capture', requireRunner, async (req, res) => {
    try { res.json(await deps.vectorTeaching.capture(req.params.id)); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  // A .ai / .vectorcraft made outside the team becomes something ประกอบ can edit.
  app.post('/api/agents/vector-import', requireRunner, async (req, res) => {
    try { res.status(201).json(await deps.vectorTeaching.importDocument(req.body || {})); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/agents/vector-live/stop', requireRunner, (req, res) => {
    res.json(deps.vectorLive.stop());
  });

  app.post('/api/agents/tasks/:id/vector-live', requireRunner, async (req, res) => {
    try {
      if (['connecting', 'playing'].includes(deps.vectorLive.status().status)) return res.status(409).json({ error: 'VectorCraft กำลังแสดงงานอื่นอยู่' });
      const task = await prisma.agentTask.findUnique({ where: { id: req.params.id } });
      if (task?.agent !== 'assemble' || !task.result?.beforeDocument || !task.result?.commands?.length || ['queued', 'running'].includes(task.status)) {
        return res.status(400).json({ error: 'งานนี้ไม่มีขั้นตอนแก้ให้แสดงสด' });
      }
      const { resolveVectorFile } = await import('./vectorTeaching.js');
      const file = resolveVectorFile(path.join(ROOT, 'public'), task.result.beforeDocument);
      const output = path.join(path.dirname(file), `live-${crypto.randomUUID()}${path.extname(file)}`);
      const playback = deps.vectorLive.play({ file, output, preview: output.replace(/\.[^.]+$/, '.png'), commands: task.result.commands, taskId: task.id });
      playback.catch((e) => console.error('VectorCraft live:', e.message));
      res.status(202).json({ ok: true, ...deps.vectorLive.status() });
    } catch (e) { res.status(400).json({ error: e.message }); }
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
      if (task.agent === 'image' && task.input?.heldByHer && task.result?.document) {
        await handToVec(prisma, task, feedback);
        return res.json({ ok: true, note: `ส่งให้ ${AGENTS.assemble.name} แก้ต่อจากไฟล์ที่หนิงบันทึกแล้ว (ไม่เจนใหม่)` });
      }
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
      if (await deps.vectorTeaching.rollback(task).catch(() => false)) {
        await logEvent(prisma, 'assemble', 'ย้อนไฟล์โปรเจกต์กลับเป็นก่อนรอบที่ไม่ผ่านแล้ว', task.id);
      }
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
      const learned = req.params.id === 'adideas' ? await adLearnings(prisma, 30)
        : req.params.id === 'assemble' ? (await deps.vectorTeaching.lessons()).map((l) => ({ ...l, picked: true, reason: `${l.condition} — ${l.rule}` }))
          : await rejectLearnings(prisma, req.params.id === 'layout' ? 'image' : req.params.id, 30);
      res.json({
        id: req.params.id, name: def.name, defaultName: DEFAULT_NAMES[req.params.id] || def.name, role: def.role, about: def.about || '', engine,
        canChooseEngine, enginePreference: engines[req.params.id] || 'default',
        teamEngine: engines.all || 'claude',
        model: engine === 'codex' ? 'Codex CLI' : def.model || (engine === 'claude' ? 'sonnet' : engine === 'team' ? 'ใช้กับทุกตัว' : 'ไม่ใช้ AI'),
        tools: def.tools || [], rules, isDefault: !saved, defaultRules: DEFAULT_RULES[req.params.id] || '',
        updatedAt: saved?.updatedAt || null, prompt, learned,
        taught: req.params.id === TEAM.id ? [] : await taughtNotes(prisma, req.params.id, 40),
        usesRules: Boolean(def.buildPrompt || ['layout', 'image', 'assemble', 'motion', TEAM.id].includes(req.params.id)),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Real product photos straight from the website repo, for PLAN's plan view.
  app.get(/^\/tasaki-web\/product\/(.+)$/, (req, res) => {
    const base = path.join(WEBSITE_REPO, 'public', 'product');
    const file = path.resolve(base, decodeURIComponent(req.params[0]));
    if (!file.startsWith(base + path.sep) || !/\.(png|jpe?g|webp)$/i.test(file) || !fs.existsSync(file)) return res.status(404).end();
    res.sendFile(file);
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
        deps.vectorLive?.stop();
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

  // ประกอบ again from the same pieces (e.g. after she changes its brand kit),
  // without re-planning or re-generating anything.
  app.post('/api/agents/tasks/:id/reassemble', requireRunner, async (req, res) => {
    try {
      const task = await prisma.agentTask.findUnique({ where: { id: req.params.id } });
      const r = task?.result;
      if (!r?.layerFiles?.length || !r.plan) return res.status(400).json({ error: 'งานนี้ไม่มีเลเยอร์ให้ประกอบใหม่' });
      const dir = path.join(IMAGES_DIR, task.id);
      const round = (/r([0-9a-z]+)\.vectorcraft$/.exec(r.document || '') || [])[1] || String(task.rounds);
      await logEvent(prisma, 'assemble', 'ประกอบกำลังจัดเลเยอร์ใหม่ด้วยชุดแบรนด์ล่าสุด', task.id);
      // Blueprint ads: rebuild from the approved template (current AC size, airflow, composition).
      if (r.plan.device === BLUEPRINT && fs.existsSync(templateDoc(ROOT))) {
        const pdir = path.join(dir, path.dirname(r.layerFiles[0].file));
        const asked = req.body?.variant || r.plan.variant;
        const picked = (asked && VARIANTS.find((v) => v.key === asked)) || await nextVariant(prisma, {});
        const png = path.join(dir, `r${round}-1.png`);
        const built = await frameStore.run(frameFor(task), async () => {
          const b = await buildFromTemplate({
            bin: craftBin('vectorcraft'), runProcess, template: templateDoc(ROOT), doc: path.join(dir, `r${round}.vectorcraft`), png,
            bg: path.join(pdir, 'bg.png'), product: path.join(pdir, 'product-adjusted.png'), model: task.input?.productModel || '', dir, variant: picked,
            inPlace: fs.existsSync(path.join(dir, `r${round}.vectorcraft`)),
          });
          exportCrops(png);
          return b;
        });
        const v = Date.now();
        await prisma.agentTask.update({ where: { id: task.id }, data: { result: { ...r, plan: { ...r.plan, variant: built.variant }, images: [`${r.images[0].split('?')[0]}?v=${v}`, ...r.images.slice(1).map((u) => `${u.split('?')[0]}?v=${v}`)] } } });
        await logEvent(prisma, 'assemble', `สร้างใหม่จากแอด final แล้ว (ชุดองค์ประกอบ ${built.variant || 'เดิม'} · แอร์ ${built.acBox[2]}px)`, task.id, { kind: 'handoff', toAgent: 'you' });
        return res.json({ ok: true, note: 'สร้างใหม่จากแม่แบบเสร็จแล้ว', variant: built.variant });
      }
      await assembleLayers(dir, round, r.layerFiles.map((l) => ({ ...l, file: path.join(dir, l.file) })), {
        headline: task.input?.headline, subhead: task.input?.subhead, model: task.input?.productModel,
        headlineZone: r.plan.headlineZone, subheadZone: r.plan.subheadZone, productRect: r.plan.product.rect,
      }, await brandKit(prisma));
      // Same file names, so bust the browser cache with a version suffix.
      const v = Date.now();
      await prisma.agentTask.update({ where: { id: task.id }, data: { result: { ...r, images: [`${r.images[0].split('?')[0]}?v=${v}`] } } });
      await logEvent(prisma, 'assemble', 'ประกอบจัดเลเยอร์ใหม่เสร็จแล้ว', task.id);
      res.json({ ok: true, note: 'ประกอบใหม่เสร็จแล้ว' });
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

  // Her go-ahead on a reviewed plan: same job continues to GEN with that plan.
  app.post('/api/agents/tasks/:id/proceed', requireRunner, async (req, res) => {
    try {
      const task = await prisma.agentTask.findUnique({ where: { id: req.params.id } });
      if (!task || task.status !== 'review' || task.agent !== 'image' || task.result?.stage !== 'planned') return res.status(400).json({ error: 'ส่งต่อได้เฉพาะแผนที่รอรีวิว' });
      await prisma.agentTask.update({ where: { id: task.id }, data: { status: 'queued', feedback: '', input: { ...task.input, planOnly: false } } });
      await logEvent(prisma, 'you', `▶ อนุมัติแผน ส่งต่อให้ ${AGENTS.image.name} เจนภาพ${paused ? ' (ทีมหยุดอยู่ จะเริ่มเมื่อกดให้ทีมทำงานต่อ)' : ''}`, task.id, { kind: 'handoff', toAgent: 'image' });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
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

export { overlaySteps };
