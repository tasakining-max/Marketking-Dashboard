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
// must never pick up tasks. It only works Mon–Fri 08:00–17:00 Bangkok time;
// tasks ordered outside those hours wait in the queue.
import { spawn, execFile, execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { enginePreferences, effectiveEngine, saveEngine, codexSchema, claudeSession, revisionContext, recentNote } from './agentEngine.js';
import { createVectorTeaching } from './vectorTeaching.js';
import { createLiveVector } from './vectorLive.js';
import crypto from 'node:crypto';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const IMAGES_DIR = path.join(ROOT, 'public', 'uploads', 'agent-images');
const WEBSITE_REPO = process.env.TASAKI_WEB_REPO || '/Users/marketingengineer/Desktop/tasaki-web';
const RUNNER_ON = process.env.AGENT_RUNNER === '1';
// No daily cap unless AGENT_DAILY_LIMIT is set (she asked for none).
const DAILY_LIMIT = Number(process.env.AGENT_DAILY_LIMIT) || null;
const TASK_TIMEOUT_MS = 15 * 60 * 1000;
const POLL_MS = 5000;
const WORK_DAYS = [1, 2, 3, 4, 5];
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
  const { weekday, hour } = bangkokNow();
  return WORK_DAYS.includes(weekday) && hour >= WORK_START_HOUR && hour < WORK_END_HOUR;
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
  const out = execFileSync('git', [
    'log', '--no-merges', `--since=${date}T00:00:00+07:00`, `--until=${date}T23:59:59+07:00`,
    '--pretty=%aI%x1f%s%x1f%b%x1e',
  ], { cwd: WEBSITE_REPO, encoding: 'utf8' });
  return out.split('\x1e').map((r) => r.trim()).filter(Boolean).map((r) => {
    const [when, subject, body] = r.split('\x1f');
    return { date: when, subject, body: (body || '').replace(/Co-Authored-By:.*$/gim, '').trim() };
  });
}

const AD_CAMPAIGNS = ['Awareness', 'กระตุ้นยอดขาย', 'ความน่าเชื่อถือ'];

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
  layout: `- สไตล์ภาพแอด Tasaki: ห้องนั่งเล่น/ห้องนอนสว่าง โทนขาว-ครีม-ฟ้า ดูพรีเมียม แสงธรรมชาติ
- แอร์จริงอยู่ช่วงบนของภาพ ใหญ่ เด่น (กว้างราว 55–75% ของภาพ) มีลมเย็นสีฟ้าเป็นเส้นโค้งไหลลงมาจากแอร์ได้
- มุมซ้ายบนเว้นไว้สำหรับแถบโค้งสีฟ้าพร้อมโลโก้ Tasaki เหนือแอร์เว้นที่ใส่ชื่อรุ่นเล็กๆ
- คนเป็นนายแบบ/นางแบบไทย บุคลิกดี ยิ้มสดใส ใส่ชุดโทนน้ำเงิน/ขาว/เงิน วางให้ใหญ่ ครึ่งตัวหรือเต็มตัว ประมาณครึ่งล่างของภาพ
- เว้นพื้นที่พาดหัวใหญ่ด้านซ้ายกลางภาพ และบรรทัดรองมุมซ้ายล่าง`,
  // ประกอบ has no AI: these "- ชื่อ: ค่า" lines are its brand kit, read by
  // brandKit() below. Fonts/colours come from tasaki-web (brand.md + the
  // Frutiger Thai files the site ships), not from anyone's guess.
  motion: `- ความยาวคลิป (วินาที): 6
- ซูมเข้าทั้งฉาก (%): 6
- แอร์สแนปเข้าที่วินาที: 0.4
- ระยะเวลาสแนป (วินาที): 0.2
- แอร์ตกจากด้านบน (px): 90`,
  assemble: `- ฟอนต์พาดหัว: Frutiger Neue LT Pro / Bold Italic
- ฟอนต์บรรทัดรอง: Frutiger Neue LT Pro / Bold
- ฟอนต์ชื่อรุ่น: Frutiger Neue LT Pro / Bold Italic
- สีพาดหัวบรรทัดแรก: #FFFFFF
- สีพาดหัวบรรทัดสอง: #8FE3FF
- สีขอบพาดหัว: #001222
- ความหนาขอบพาดหัว: 6
- สีบรรทัดรอง: #0074A2
- สีชื่อรุ่น: #0074A2
- สีแถบโลโก้: #0074A2`,
  image: `- ภาพสมจริงระดับโฆษณา คมชัด แสงสว่างนุ่ม โทนขาว-ครีม-ฟ้า
- คนไดคัทต้องเห็นขอบผมชัด ไม่มีขอบขาว แสงตรงกับฉาก
- ห้ามมีตัวหนังสือ โลโก้ หรือแอร์ในชิ้นที่เจน`,
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
  'สีพาดหัวบรรทัดแรก': 'headline1', 'สีพาดหัวบรรทัดสอง': 'headline2', 'สีขอบพาดหัว': 'headlineStroke',
  'ความหนาขอบพาดหัว': 'headlineStrokeWidth', 'สีบรรทัดรอง': 'subhead', 'สีชื่อรุ่น': 'model', 'สีแถบโลโก้': 'panel',
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
    return [key, key === 'headlineStrokeWidth' ? Number(value) || 6 : value];
  }).filter(Boolean));
  return { ...parse(DEFAULT_RULES.assemble), ...parse(await agentRules(prisma, 'assemble')) };
}

function rulesNote(rules) {
  return rules.trim() ? `\n\nกฎจากผู้ดูแล (ต้องทำตามเสมอ สำคัญกว่าคำแนะนำอื่นในข้อความนี้):\n${rules.trim()}\n` : '';
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
    about: 'อ่านรายการสินค้าจริงจากฐานข้อมูลเว็บ ผลแอด 30 วันล่าสุด และเหตุผลที่คุณเคยเลือก/ไม่เลือก แล้วเสนอไอเดียแอดภาพนิ่งที่คุณทำเองได้คนเดียว แต่ละไอเดียมีแคมเปญ รุ่นสินค้า พาดหัว บรรทัดรอง ข้อความโฆษณา และภาพ',
    avatar: '/agent-assets/contentAgent-256.png',
    engine: 'claude',
    model: 'sonnet',
    tools: ['WebSearch', 'WebFetch', 'Read', 'Grep', 'Glob'],
    placeholder: 'เช่น ขอไอเดียแอดภาพ 5 แบบ เน้นกระตุ้นยอดขายแอร์ติดผนังอินเวอร์เตอร์',
    async buildPrompt(task, prisma, deps) {
      const [products, perf, learnings] = await Promise.all([
        productCatalog(deps.tasakiWebPool),
        adPerformance(prisma, 30),
        adLearnings(prisma),
      ]);
      return `${BRAND_NOTE}

หน้าที่: เสนอไอเดียโฆษณาแบบภาพนิ่ง (Facebook/Instagram) ให้ผู้ดูแลการตลาดเลือก งานนี้เธอทำเองคนเดียวทั้งหมด จึงห้ามเสนออะไรที่ต้องพึ่งฝ่ายอื่น ต้องถ่ายคน หรือต้องออกไปถ่ายหน้างาน
ภาพจะทำจาก "ฉากที่ AI สร้าง + รูปสินค้าจริงวางทับ" ดังนั้นสินค้าต้องเป็นรุ่นที่มีในรายการด้านล่างเท่านั้น (ใส่ model ให้ตรงตัวอักษร) และฉาก (visual) ต้องไม่มีตัวสินค้าหรือตัวหนังสือในภาพ
ทุกไอเดียต้องทำมาเพื่อแอดโดยเฉพาะ (หยุดนิ้วได้ใน 1 วินาที มีมุมขายชัด) ไม่ใช่คอนเทนต์ออร์แกนิก
campaign เลือกจาก: ${AD_CAMPAIGNS.join(', ')}
ห้ามใช้ข้อมูลสเปกหรือตัวเลขที่ไม่มีในรายการสินค้า

สินค้าที่มี (model | ชื่อ | ประเภท | BTU | คำอธิบาย):
${products.map((p) => `${p.model} | ${p.nameTh} | ${p.type} | ${p.btu} | ${p.description}`).join('\n')}

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
              headline: { type: 'string' },
              subhead: { type: 'string' },
              primaryText: { type: 'string' },
              visual: { type: 'string' },
              why: { type: 'string' },
            },
            required: ['title', 'campaign', 'productModel', 'headline', 'subhead', 'primaryText', 'visual', 'why'],
          },
        },
      },
      required: ['summary', 'ideas'],
    },
    decides: true,
    approveLabel: 'ยืนยัน แล้วให้พิมพ์ทำภาพที่เลือก',
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
            description: `แคมเปญ: ${idea.campaign}\nสินค้า: ${idea.productModel}\nพาดหัว: ${idea.headline}\nบรรทัดรอง: ${idea.subhead || '-'}\nข้อความโฆษณา: ${idea.primaryText}\nภาพ: ${idea.visual}`,
            column: 'todo',
            usage: ['facebook_ads', 'instagram_ads'],
            order: base + n,
          },
          omit: { imageUrl: true },
        });
        const imageTask = await prisma.agentTask.create({
          data: {
            agent: 'image',
            prompt: `แอด "${idea.title}": ${idea.visual}`,
            input: { graphicCardId: graphic.id, productImage: product?.image || null, productModel: idea.productModel, headline: idea.headline, subhead: idea.subhead || '' },
          },
        });
        await log(prisma, 'image', `ปิ๊งส่งไอเดีย "${idea.title}" ให้พิมพ์ทำภาพ`, imageTask.id);
      }
      await prisma.agentTask.update({ where: { id: task.id }, data: { result: { ...task.result, decisions } } });
      invalidateCache('graphic-cards');
      // "ขออันถัดไป": the next round starts after this decision is stored, so
      // it already sees the reason she just gave.
      if (body.next) {
        const next = await prisma.agentTask.create({ data: { agent: 'adideas', prompt: task.prompt, input: task.input || {} } });
        await log(prisma, 'adideas', 'ขอไอเดียถัดไปจากปิ๊ง', next.id);
      }
      return picked.length
        ? `เลือก ${picked.length} ไอเดีย สร้างการ์ดใน Graphic Design และส่งให้พิมพ์ทำภาพแล้ว`
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
    avatar: '/agent-assets/VDOCreator-256.png',
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
    avatar: '/agent-assets/CaptionAgent.png',
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
    about: 'อ่านตัวเลขแอดจากหน้า Ads (ย้อนหลังตามจำนวนวันที่เลือก) กับบันทึกสิ่งที่ทำกับบัญชีโฆษณา แล้วสรุปเป็นภาษาง่ายๆ พร้อมข้อเสนอ',
    avatar: '/agent-assets/Agent-256.png',
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
    about: 'อ่านบันทึกการแก้เว็บ Tasaki (git) ของวันที่เลือก แล้วแปลงเป็นภาษาไทยง่ายๆ แยกตามเรื่อง ใช้เวลาจริงของแต่ละการแก้',
    avatar: '/agent-assets/ClawBot-256.png',
    engine: 'claude',
    model: 'haiku',
    tools: [],
    placeholder: 'เช่น สรุปสิ่งที่เปลี่ยนบนเว็บวันนี้ (ใส่วันที่ได้ เช่น 2026-10-16)',
    async buildPrompt(task) {
      const date = /^\d{4}-\d{2}-\d{2}$/.test(task.input?.date || '') ? task.input.date : bangkokNow().date;
      const commits = websiteCommits(date);
      if (!commits.length) throw new Error(`ไม่มีการเปลี่ยนแปลงบนเว็บวันที่ ${date}`);
      return `${BRAND_NOTE}

หน้าที่: แปลงบันทึกการแก้เว็บ Tasaki (ภาษาโปรแกรมเมอร์) เป็นภาษาไทยง่ายๆ ที่คนไม่ใช่สายเทคนิคอ่านเข้าใจ
แบ่งเป็นหัวข้อตามเรื่อง หัวข้อละ 1 รายการ ไม่ต้องใส่ชื่อไฟล์หรือศัพท์โปรแกรม
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
          items: { type: 'object', properties: { text: { type: 'string' }, date: { type: 'string' } }, required: ['text', 'date'] },
        },
      },
      required: ['entries'],
    },
    approveLabel: 'ลงบันทึกเว็บไซต์',
    async onApprove(task, body, { prisma, invalidateCache }) {
      const entries = Array.isArray(body.entries) ? body.entries : task.result?.entries || [];
      const valid = entries.filter((e) => e && typeof e.text === 'string' && e.text.trim());
      for (const e of valid) {
        const when = new Date(e.date);
        await prisma.websiteChangelog.create({ data: { text: e.text.trim(), ...(Number.isNaN(when.getTime()) ? {} : { date: when }) } });
      }
      invalidateCache('website-changelog');
      return `ลงบันทึกเว็บไซต์ ${valid.length} รายการ`;
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
    about: 'ขั้นที่ 1 และขั้นตรวจของงานภาพ: อ่านโจทย์และขนาดรูปสินค้าจริง แล้วตัดสินใจว่าต้องเจนฉากหลังแบบไหน มีคน/ของประกอบกี่ชิ้น แต่ละชิ้นวางตรงไหน สินค้าอยู่ตรงไหน เว้นที่พาดหัวตรงไหน — พอประกอบเสร็จ ผังจะเปิดดูภาพจริงแล้วให้คะแนนตามกฎด้านล่างและเหตุผลที่หนิงเคยปัดตก ถ้าต่ำกว่า 8/10 จะสั่งพิมพ์/ประกอบแก้เองได้สูงสุด 2 รอบ ก่อนส่งถึงหนิง',
    avatar: '/agent-assets/MainAgent-256.png',
    engine: 'claude',
    // Opus: PLAN judges every finished ad (her choice, 2026-10-19).
    model: 'opus',
    pipelineStage: 'plan',
  },

  image: {
    name: 'พิมพ์',
    role: 'เจนภาพ/ไดคัท (Codex)',
    about: 'ขั้นที่ 2 ของงานภาพ: เจนเฉพาะชิ้นที่ผังสั่ง คือฉากหลังเต็มภาพ และคน/ของแต่ละชิ้นแบบไดคัทพื้นโปร่งใส ไม่วาดสินค้าเอง ไม่จัดวางเอง',
    avatar: '/agent-assets/ImageAgent.png',
    engine: 'codex',
    pipelineStage: 'generate',
    placeholder: 'เช่น แอร์ติดผนังในห้องนอนเด็ก แม่กำลังห่มผ้าให้ลูก โทนฟ้าขาว (เลือกสินค้าด้านบน)',
    approveLabel: 'ใช้ภาพนี้',
    async onApprove(task, body, { prisma, invalidateCache }) {
      const images = task.result?.images || [];
      const chosen = images[Number(body.image) || 0] || images[0];
      if (!task.input?.graphicCardId || !chosen) return 'เก็บภาพไว้แล้ว';
      const file = path.join(ROOT, 'public', chosen.split('?')[0]);
      const mime = /\.jpe?g$/i.test(file) ? 'image/jpeg' : /\.webp$/i.test(file) ? 'image/webp' : 'image/png';
      await prisma.graphicDesignCard.update({
        where: { id: task.input.graphicCardId },
        data: { imageUrl: `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`, column: 'in_progress' },
        omit: { imageUrl: true },
      });
      invalidateCache('graphic-cards');
      return 'แนบภาพลงการ์ด Graphic Design แล้ว (ย้ายไป "กำลังทำ")';
    },
  },

  assemble: {
    name: 'ประกอบ',
    role: 'ประกอบเลเยอร์ (VectorCraft)',
    about: 'ประกอบภาพตามผัง และใช้ AI วางแผนแก้ไฟล์ VectorCraft จริงตามคำสอน เลือกงานต้นทางแล้วสั่งแก้ หรือเปิดสำเนาให้คุณแก้และบันทึกเป็นตัวอย่าง เปรียบเทียบตำแหน่ง ฟอนต์ สี และเอฟเฟกต์ก่อน–หลัง บทเรียนจะใช้กับงานแก้ครั้งถัดไปเมื่อคุณตรวจผ่านเท่านั้น ไม่ได้เฝ้าดูเมาส์',
    avatar: '/agent-assets/Agent-256.png',
    engine: 'claude',
    model: 'opus',
    pipelineStage: 'assemble',
    vectorEditor: true,
    placeholder: 'เช่น ย่อแถบโลโก้ให้พ้นแอร์ ลดเงาพาดหัว และขยับข้อความไม่ให้ชนคน',
    approveLabel: 'ถูกต้อง และจำวิธีนี้',
    async onApprove(task, body) { return deps.vectorTeaching.approve(task, body); },
  },

  motion: {
    name: 'มูฟ',
    role: 'ทำแอนิเมชัน (EffectCraft)',
    about: 'ขั้นที่ 4 (ทำเมื่อกดปุ่ม): AI ดูภาพที่ประกอบเสร็จแล้ววางจังหวะเคลื่อนไหวของแต่ละเลเยอร์ (สแนปเร็ว ไม่มีเฟด ไม่ทยอยโผล่) จากนั้นสร้างคลิปใน EffectCraft เรนเดอร์เป็น MP4 แล้วเปิดต่อใน FilmCraft เพื่อใส่เพลงได้ ตัวเลขในกฎด้านล่างคือค่าเริ่มต้น เขียนรูปแบบ "- ชื่อ: ค่า" เหมือนเดิม และเพิ่มกฎเป็นข้อความได้',
    avatar: '/agent-assets/VDOCreator-256.png',
    engine: 'claude',
    model: 'sonnet',
    fromImageOnly: true,
    approveLabel: 'เก็บคลิปนี้',
  },

  chief: {
    name: 'ทาซากิ',
    role: 'ผู้ช่วยทั่วไป',
    about: 'รับคำถามหรืองานทั่วไปที่ไม่ตรงกับฝ่ายอื่น ค้นเว็บและอ่านไฟล์ในโปรเจกต์ได้',
    avatar: '/agent-assets/MainAgent-256.png',
    engine: 'claude',
    model: 'sonnet',
    tools: ['WebSearch', 'WebFetch', 'Read', 'Grep', 'Glob'],
    placeholder: 'ถามหรือสั่งอะไรก็ได้ที่ไม่ตรงกับฝ่ายอื่น',
    async buildPrompt(task) {
      return `${BRAND_NOTE}\n\nคำสั่งงาน: ${task.prompt}`;
    },
    schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] },
    approveLabel: 'รับทราบ',
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

// Runs a CLI and keeps the Mac from idle-sleeping only while it works.
function runProcess(bin, args, { cwd, input }) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env: { ...process.env, ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' } });
    const awake = spawn('/usr/bin/caffeinate', ['-i', '-w', String(child.pid)], { stdio: 'ignore' });
    awake.on('error', () => {});
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), TASK_TIMEOUT_MS);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (signal) return reject(new Error('ใช้เวลานานเกินไป ระบบหยุดงานนี้'));
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
    .filter((f) => f.startsWith(INPUTS_DIR + path.sep) && fs.existsSync(f));
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

const CANVAS = [1080, 1350];

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
  required: ['concept', 'background', 'elements'],
};

const RECT = { type: 'array', items: { type: 'number' } };
const PLACE_SCHEMA = {
  type: 'object',
  properties: {
    product: RECT,
    elements: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, rect: RECT }, required: ['key', 'rect'] } },
    headlineZone: RECT,
    subheadZone: RECT,
  },
  required: ['product', 'elements', 'headlineZone', 'subheadZone'],
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
  return `โจทย์: ${task.prompt}
${task.input?.headline ? `พาดหัวที่จะใช้: "${task.input.headline}"` : ''}${task.input?.subhead ? ` บรรทัดรอง: "${task.input.subhead}"` : ''}`;
}

// 1 — ผัง decides which pieces to paint (no positions yet).
async function planPieces(task, prisma, product) {
  const planner = {
    speaker: 'layout', rulesAgent: 'layout', model: AGENTS.layout.model, tools: [], schema: PIECES_SCHEMA,
    async buildPrompt() {
      return `${BRAND_NOTE}

หน้าที่: วางแผนภาพโฆษณา ${CANVAS[0]}x${CANVAS[1]} (4:5) ที่จะประกอบจากชิ้นส่วนแยก ตอนนี้ยังไม่ต้องกำหนดตำแหน่ง (จะวางหลังเห็นฉากจริง)
- background.prompt: คำสั่งเจนภาพฉากเต็มภาพ (ภาษาอังกฤษ) ที่มีคน/สัตว์อยู่ในฉากเลยในภาพเดียว (หนิงสั่ง: เจนคนพร้อมฉากหลัง ไม่แยกไดคัท เพื่อให้แสง เงา และพื้นกลมกลืนจริง) บรรยายคนด้วยบทบาท ชุด ท่าทาง สีหน้า และตำแหน่งในภาพ ห้ามมีแอร์ เครื่องใช้ไฟฟ้า ตัวหนังสือ โลโก้ ผนังตรงที่จะติดแอร์ (${product.model} อัตราส่วน ${product.w}:${product.h}) ต้องมองตรง ว่าง และต่อเนื่องเป็นบริเวณกว้างช่วงบนของภาพ ไม่มีคนหรือของบังบริเวณนั้น เว้นพื้นที่เรียบด้านซ้ายกลางสำหรับพาดหัว บอกมุมกล้องและทิศแสงให้ชัด
- elements: เฉพาะสิ่งที่ต้องแยกเลเยอร์จริงๆ เช่น ลมเย็น (ไม่ใส่คน เพราะคนอยู่ในภาพฉากแล้ว) key ภาษาอังกฤษตัวเล็ก ชื่อไทย prompt ภาษาอังกฤษระบุ "isolated on transparent background" front=true ถ้าอยู่หน้าสินค้า
- ถ้าเป็นแอร์ติดผนัง ให้มีชิ้นลมเย็นเสมอ (key: airflow) เป็นริบบิ้นโปร่งแสงสีฟ้าอ่อนไหลลงจากช่องลม front=true
- concept: อธิบายภาพสั้นๆ ภาษาไทย
${planBrief(task)}`;
    },
  };
  const { result } = await runLanguageAgent(planner, { ...task, sessionId: null, feedback: '' }, prisma, deps);
  return {
    concept: result.concept,
    background: { prompt: String(result.background?.prompt || '') },
    elements: (result.elements || []).slice(0, 4).map((e, i) => ({ key: cleanKey(e.key, i), name: String(e.name || `ชิ้นที่ ${i + 1}`).slice(0, 40), prompt: String(e.prompt || ''), front: Boolean(e.front) })).filter((e) => e.prompt),
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
- product: [x,y,กว้าง,สูง] ของแอร์จริง ${product.model} อัตราส่วนกว้าง:สูง = ${product.w}:${product.h} ต้องอยู่บนผนังว่างทั้งตัว ไม่ทับหน้าต่าง ม่าน หรือขอบผนัง ห่างเพดานพอดี ขนาดสมจริงเทียบเฟอร์นิเจอร์
- elements: [x,y,กว้าง,สูง] ของแต่ละชิ้น (${sizes.map((z) => `${z.key} ภาพจริง ${z.w}x${z.h}`).join(', ') || 'ไม่มี'}) คนต้องยืนบนพื้น/นั่งบนเบาะที่เห็นในภาพจริง ขนาดสมจริง ลมเย็นวางใต้ช่องลมแอร์
- headlineZone: พื้นที่เรียบสำหรับพาดหัวใหญ่ 2 บรรทัด ห้ามทับหน้าคน สินค้า และมุมซ้ายบน (0,0)-(420,260) ที่เป็นแถบโลโก้
- subheadZone: พื้นที่บรรทัดรองตัวเล็ก ห้ามทับหน้าคน
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
    elements: plan.elements.map((e) => ({ ...e, rect: rects[e.key] || e.rect || null })),
    headlineZone: cleanRect(result.headlineZone) || plan.headlineZone,
    subheadZone: cleanRect(result.subheadZone) || plan.subheadZone,
  };
}

// พิมพ์: new pieces from a prompt; fixes start FROM the previous picture of
// that piece (attached) with ผัง's concrete change, so a fix is a real edit.
async function paintPieces(task, dir, piecesDir, jobs) {
  if (!jobs.length) return;
  const bin = codexBin();
  if (!bin) throw new Error('ไม่พบ Codex บนเครื่องนี้');
  const attach = jobs.filter((j) => j.from && fs.existsSync(j.from));
  const refs = attachmentFiles(task);
  const lines = jobs.map((j, i) => {
    const out = `${piecesDir}/${j.key}.png`;
    const shape = j.key === 'bg'
      ? `ภาพฉากเต็มภาพ (มีคนในฉากได้ตามคำบรรยาย) ครอป/ย่อให้เป็น ${CANVAS[0]}x${CANVAS[1]} พอดี ห้ามมีแอร์ เครื่องใช้ไฟฟ้า ตัวหนังสือ โลโก้`
      : 'พื้นหลังโปร่งใส (ไดคัท) ตรวจด้วย Pillow ว่ามี alpha จริง ขอบสะอาด ครอปขอบโปร่งใสส่วนเกินออก';
    if (j.from && fs.existsSync(j.from)) {
      return `${i + 1}. ${out} — แก้จากภาพแนบลำดับที่ ${attach.indexOf(j) + 1} (${j.name}) ด้วยโหมดแก้ภาพ: ${j.instruction}
   คงทุกอย่างที่ไม่ได้สั่งแก้ไว้เหมือนเดิม (${shape})`;
    }
    return `${i + 1}. ${out} — ${j.name}: ${j.prompt}${j.instruction ? `\n   เพิ่มเติม: ${j.instruction}` : ''}\n   ${shape}`;
  });
  const prompt = `ใช้เครื่องมือ image_gen ทำชิ้นส่วนภาพตามรายการนี้เท่านั้น ห้ามเพิ่ม ห้ามจัดวางหรือประกอบเอง
${lines.join('\n')}${refs.length ? `\nภาพแนบลำดับที่ ${attach.length + 1}–${attach.length + refs.length} คือภาพอ้างอิงที่หนิงแนบมา ใช้เป็นแนวทาง (โทน มุมกล้อง ท่าทาง บรรยากาศ) ห้ามลอกตัวหนังสือ โลโก้ หรือแอร์จากภาพอ้างอิง` : ''}${rulesNote(await combinedRules(deps.prisma, 'image'))}
ตอบสั้นๆ ภาษาไทยว่าทำ/แก้อะไรไปบ้าง`;
  await logEvent(deps.prisma, 'layout', jobs.map((j) => (j.from ? `แก้${j.name}: ${j.instruction}` : `เจน${j.name}`)).join(' / '), task.id, { kind: 'handoff', toAgent: 'image', detail: prompt });
  const msgFile = path.join(dir, `${piecesDir}-message.txt`);
  await runProcess(bin, [
    'exec', '--skip-git-repo-check', '--sandbox', 'workspace-write', '-C', dir, '-o', msgFile,
    // --image=… (not "-i …"): -i takes several values and would swallow anything after it.
    ...attach.map((j) => `--image=${j.from}`),
    ...refs.map((f) => `--image=${f}`),
  ], { cwd: dir, input: prompt });
  const missing = jobs.filter((j) => !fs.existsSync(path.join(dir, piecesDir, `${j.key}.png`)));
  if (missing.some((j) => j.key === 'bg')) throw new Error('Codex ไม่ได้ส่งฉากหลังกลับมา');
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
else:
    W, H, x, y, w, h = map(int, sys.argv[3:9])
    im = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    oy = int(t['shadowOffsetY'])
    d.rounded_rectangle([x + 8, y + oy, x + w + 8, y + h + oy], radius=int(h * 0.18), fill=(20, 30, 45, int(t['shadowStrength'] * 2.2)))
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
  execFileSync('/usr/bin/python3', ['-c', PIL_TWEAK, ...args], { cwd: '/' });
}

async function assembleWork(task, prisma, dir, tag, work, product, productFile, kit) {
  const pdir = path.join(dir, work.piecesDir);
  const tweaks = clampTweaks(work.tweaks);
  const adjusted = path.join(pdir, 'product-adjusted.png');
  runPil(['product', JSON.stringify(tweaks), productFile, adjusted]);
  runPil(['shadow', JSON.stringify(tweaks), String(CANVAS[0]), String(CANVAS[1]), ...work.plan.product.rect.map((n) => String(Math.round(n))), path.join(pdir, 'shadow.png')]);
  const piece = (key) => path.join(pdir, `${key}.png`);
  const els = work.plan.elements.filter((e) => e.rect && fs.existsSync(piece(e.key)));
  const layers = [
    { name: 'ฉากหลัง', file: piece('bg'), rect: [0, 0, ...CANVAS] },
    ...els.filter((e) => !e.front).map((e) => ({ name: e.name, file: piece(e.key), rect: e.rect })),
    { name: 'เงาสินค้า', file: piece('shadow'), rect: [0, 0, ...CANVAS] },
    { name: `สินค้าจริง ${product.model}`, file: adjusted, rect: work.plan.product.rect },
    ...els.filter((e) => e.front).map((e) => ({ name: e.name, file: piece(e.key), rect: e.rect })),
  ];
  await assembleLayers(dir, tag, layers, {
    headline: task.input?.headline, subhead: task.input?.subhead, model: product.model,
    headlineZone: work.plan.headlineZone, subheadZone: work.plan.subheadZone, productRect: work.plan.product.rect,
  }, kit);
  const changed = Object.entries(tweaks).filter(([k, v]) => v !== DEFAULT_TWEAKS[k]).map(([k, v]) => `${k} ${v}`);
  await logEvent(prisma, 'assemble', `ประกอบเสร็จ ${layers.length + 4} เลเยอร์${changed.length ? ` (ปรับ: ${changed.join(', ')})` : ''} ส่งให้ตรวจ`, task.id, { kind: 'handoff', toAgent: 'layout', image: `/uploads/agent-images/${task.id}/r${tag}-1.png` });
  return layers;
}

// ผัง checks the assembled picture — or reads her ↻ comment — and splits what
// needs fixing into jobs for whoever owns each problem.
// The checklist ผัง answers every time, in this order.
const CHECK_ITEMS = ['แอร์ติดผนังเนียน (ตำแหน่ง แสง เงา)', 'ฉากสมจริง มีมิติ', 'คนและชิ้นไดคัทกลมกลืน', 'ตัวหนังสืออ่านง่าย ไม่ทับหน้าคน', 'สื่อมุมขายชัด'];

async function checkAndRoute(task, prisma, png, work, herComment) {
  const kitRules = (await agentRules(prisma, 'assemble')).trim();
  const router = {
    speaker: 'layout', rulesAgent: 'layout', model: AGENTS.layout.model, tools: ['Read'], images: [png], schema: ROUTE_SCHEMA,
    async buildPrompt() {
      return `${BRAND_NOTE}

หน้าที่ตอนนี้: คุณคือหัวหน้างานภาพ ใช้เครื่องมือ Read เปิดดูภาพที่ประกอบเสร็จ ${png} (แอด ${CANVAS[0]}x${CANVAS[1]})
${herComment ? `หนิงดูภาพนี้แล้วคอมเมนต์ว่า: "${herComment}"\nแปลงคอมเมนต์ของหนิงเป็นงานแก้ให้ตรงคน และตรวจเพิ่มตามหัวข้อด้านล่าง` : 'ตรวจอย่างเข้มงวดเหมือนหนิงเป็นคนดู'}
เทียบมาตรฐานแอดจริงของ Tasaki: ห้องพรีเมียมมีมิติ แอร์จริงตัวใหญ่ติดผนังเนียน มีเงาและลมเย็น คนกลมกลืนกับฉาก พาดหัวหนา อ่านง่าย ไม่ทับหน้าคน
หัวข้อตรวจ (ตอบใน checks ครบทุกข้อ ตามลำดับ item ใช้ชื่อนี้ตรงๆ pass true/false note 1 ประโยคสั้นบอกสิ่งที่เห็นจริง ข้อที่ไม่ผ่านให้บอกว่าผิดตรงไหน):
${CHECK_ITEMS.map((x, i) => `${i + 1}. ${x}`).join('\n')}
(มุมขายคือ "${task.input?.headline || task.prompt}")

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

const MAX_SELF_FIXES = 2;
const PASS_SCORE = 8;
const CLOUD_SECONDS = 40;

async function runImagePipeline(task, prisma) {
  const dir = path.join(IMAGES_DIR, task.id);
  fs.mkdirSync(dir, { recursive: true });
  const round = task.rounds + 1;
  const base = `/uploads/agent-images/${task.id}`;
  const productSrc = task.input?.productImage;
  if (!productSrc || !fs.existsSync(productSrc)) return runCodexFreeImage(task, prisma, dir, round);

  const productFile = path.join(dir, `product${path.extname(productSrc)}`);
  fs.copyFileSync(productSrc, productFile);
  const product = { model: task.input.productModel || 'สินค้า', ...pixelSize(productFile) };
  const kit = await brandKit(prisma);
  const checks = [];
  const needsYou = [];
  let tag = String(round);
  let layers;

  // Her ↻ on an existing picture: ผัง turns the comment into jobs on the
  // existing pieces instead of starting over.
  const prevResult = task.result || {};
  let work = prevResult.work || (prevResult.plan && prevResult.layerFiles
    ? { plan: prevResult.plan, piecesDir: path.dirname(prevResult.layerFiles[0].file), tweaks: {} }
    : null);
  if (task.feedback && work && prevResult.images?.[0]) {
    await setStage(prisma, task, 'review');
    const prevPng = path.join(ROOT, 'public', prevResult.images[0].split('?')[0]);
    const route = await checkAndRoute(task, prisma, prevPng, work, task.feedback);
    needsYou.push(...route.assignments.filter((a) => a.to === 'you').map((a) => a.instruction));
    work = await applyRoute(task, prisma, dir, tag, work, route, product);
  } else {
    await setStage(prisma, task, 'plan');
    const plan = await planPieces(task, prisma, product);
    const piecesDir = `r${tag}-layers`;
    fs.mkdirSync(path.join(dir, piecesDir), { recursive: true });
    await setStage(prisma, task, 'generate');
    await paintPieces(task, dir, piecesDir, [{ key: 'bg', name: 'ฉากหลัง', prompt: plan.background.prompt }]);
    await setStage(prisma, task, 'plan');
    let placed = await placeOnBackground(task, prisma, product, plan, dir, piecesDir, '');
    await setStage(prisma, task, 'generate');
    await paintPieces(task, dir, piecesDir, placed.elements.map((e) => ({ key: e.key, name: e.name, prompt: e.prompt })));
    if (placed.elements.length) placed = await placeOnBackground(task, prisma, product, placed, dir, piecesDir, 'ตอนนี้มีชิ้นไดคัทจริงแล้ว ปรับตำแหน่ง/ขนาดให้พอดีกับรูปจริงของแต่ละชิ้น');
    work = { plan: placed, piecesDir, tweaks: { ...DEFAULT_TWEAKS } };
  }

  for (let attempt = 0; ; attempt += 1) {
    fs.writeFileSync(path.join(dir, `r${tag}-plan.json`), JSON.stringify(work, null, 2));
    await setStage(prisma, task, 'assemble');
    layers = await assembleWork(task, prisma, dir, tag, work, product, productFile, kit);
    await setStage(prisma, task, 'review');
    const png = path.join(dir, `r${tag}-1.png`);
    const route = await checkAndRoute(task, prisma, png, work, null);
    checks.push({ tag, image: `${base}/r${tag}-1.png`, score: route.score, pass: route.pass, list: route.list, issues: route.issues });
    needsYou.push(...route.assignments.filter((a) => a.to === 'you').map((a) => a.instruction));
    const actionable = route.assignments.some((a) => a.to !== 'you');
    if (route.pass) await logEvent(prisma, 'layout', `ตรวจแล้วผ่าน ${route.score}/10 ส่งต่อให้หนิง`, task.id, { kind: 'handoff', toAgent: 'you', image: `${base}/r${tag}-1.png` });
    if (route.pass || !actionable || attempt >= MAX_SELF_FIXES) break;
    tag = `${round}${'bcdefg'[attempt]}`;
    work = await applyRoute(task, prisma, dir, tag, work, route, product);
  }
  const last = checks[checks.length - 1];
  const youList = [...new Set(needsYou)];
  return {
    result: {
      stage: 'done',
      work,
      plan: work.plan,
      layerFiles: layers.map((l) => ({ name: l.name, file: path.relative(dir, l.file), rect: l.rect })),
      layers: [...layers.map((l) => l.name), 'แถบโลโก้', 'ชื่อรุ่น', ...(task.input?.headline ? ['พาดหัว'] : []), ...(task.input?.subhead ? ['บรรทัดรอง'] : [])],
      images: [`${base}/r${tag}-1.png`],
      document: `${base}/r${tag}.vectorcraft`,
      checks,
      needsYou: youList,
      note: work.plan.concept || '',
      reviewNote: `${last.pass ? 'ผ่าน' : 'ยังไม่ผ่าน'} ${last.score}/10${checks.length > 1 ? ` · แก้เอง ${checks.length - 1} รอบ` : ''}`
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
// over the unit, a two-line headline (white, then cyan; navy outline + drop
// shadow) and a Tasaki-blue sub line. All live text, so she restyles freely.
function overlaySteps({ headline, subhead, model, headlineZone, subheadZone, productRect }, kit) {
  const steps = [
    ['layer.new', { name: 'แถบโลโก้', top: true }],
    ['shape.ellipse', { x: -420, y: -560, width: 1040, height: 860, rotation: -12 }],
    ['paint.setFill', { color: kit.panel }],
    ['paint.setStroke', { none: true }],
  ];
  if (fs.existsSync(TASAKI_LOGO_WHITE)) steps.push(['file.place', { path: TASAKI_LOGO_WHITE, link: false, rect: [44, 52, 300, 80] }]);
  if (model && productRect) {
    steps.push(['layer.new', { name: 'ชื่อรุ่น', top: true }]);
    // Keep the label clear of the blue logo panel (top-left ~0–560 x 0–300).
    const lx = Math.max(productRect[0] + productRect[2] * 0.4, productRect[1] < 320 ? 600 : 0);
    steps.push(['text.create', { x: Math.min(lx, CANVAS[0] - 260), y: Math.max(40, productRect[1] - 22), text: model, size: 32, font: kit.modelFont.font, style: kit.modelFont.style, color: kit.model }]);
  }
  if (headline) {
    // ประกอบ's guarantees, whatever box ผัง leaves: a headline area at least
    // 560x280 inside the canvas, point text sized from the line's length (so
    // nothing is clipped), and an outline that scales with the letters (a
    // fixed thick outline on small letters swallowed the white fill).
    let [hx, hy, hw, hh] = cleanRect(headlineZone) || [60, 470, 640, 300];
    hw = Math.max(hw, 560); hh = Math.max(hh, 280);
    hx = Math.min(Math.max(hx, 30), CANVAS[0] - hw - 30); hy = Math.min(Math.max(hy, 300), CANVAS[1] - hh - 30);
    const words = headline.trim().split(/\s+/);
    const lines = words.length > 1 ? [words[0], words.slice(1).join(' ')] : [words[0]];
    const lineH = hh / lines.length;
    const visible = (t) => t.replace(/[\u0E31\u0E34-\u0E3A\u0E47-\u0E4E]/g, '').length;
    steps.push(['layer.new', { name: 'พาดหัว', top: true }]);
    lines.forEach((line, i) => {
      const indent = i * 40;
      const size = Math.round(Math.min(170, lineH * 0.82, (hw - indent) / (visible(line) * 0.66)));
      steps.push(['text.create', { x: hx + indent, y: Math.round(hy + i * lineH + size * 0.95), text: line, size, font: kit.headlineFont.font, style: kit.headlineFont.style }]);
      steps.push(['text.setRangeStyle', { fill: i === 0 ? kit.headline1 : kit.headline2, stroke: kit.headlineStroke, strokeWidth: Math.max(1.5, Math.round(kit.headlineStrokeWidth * (size / 150) * 10) / 10) }]);
      steps.push(['effect.apply', { effect: 'stylize.dropShadow' }]);
    });
  }
  if (subhead) {
    let [sx, sy, sw, sh] = cleanRect(subheadZone) || [60, 1170, 600, 110];
    sw = Math.max(sw, 480); sh = Math.max(sh, 90);
    sx = Math.min(Math.max(sx, 30), CANVAS[0] - sw - 30); sy = Math.min(Math.max(sy, 300), CANVAS[1] - sh - 20);
    steps.push(['layer.new', { name: 'บรรทัดรอง', top: true }]);
    steps.push(['text.create', { x: sx, y: sy, text: subhead, size: Math.min(58, Math.round(sh * 0.5)), font: kit.subheadFont.font, style: kit.subheadFont.style, area: { width: sw, height: sh, fit: 'shrinkText' } }]);
    steps.push(['text.setRangeStyle', { fill: kit.subhead }]);
  }
  return steps;
}

async function assembleLayers(dir, round, layers, overlays, kit) {
  const doc = path.join(dir, `r${round}.vectorcraft`);
  const png = path.join(dir, `r${round}-1.png`);
  const steps = [['file.new', { name: `Tasaki ad r${round}`, width: CANVAS[0], height: CANVAS[1], units: 'Pixels' }]];
  layers.forEach((l, i) => {
    steps.push(i === 0 ? ['layer.setProps', { name: l.name }] : ['layer.new', { name: l.name, top: true }]);
    steps.push(['file.place', { path: l.file, link: false, rect: l.rect }]);
  });
  if (overlays) steps.push(...overlaySteps(overlays, kit));
  steps.push(['file.saveAs', { path: doc }]);
  const args = ['run', ...steps.flatMap(([id, params]) => ['--cmd', id, '--params', JSON.stringify(params)]), '--export', png];
  const { code, stderr } = await runProcess(craftBin('vectorcraft'), args, { cwd: dir });
  if (code !== 0 || !fs.existsSync(doc) || !fs.existsSync(png)) throw new Error(`ประกอบไฟล์ VectorCraft ไม่สำเร็จ ${stderr.slice(-200)}`);
  if (deps.vectorTeaching) await deps.vectorTeaching.applyLessons(doc, png, { id: path.basename(dir), agent: 'assemble', prompt: '', rounds: 0 });
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

async function setStage(prisma, task, stage) {
  await prisma.agentTask.update({ where: { id: task.id }, data: { result: { ...(task.result || {}), stage } } });
  const who = { review: 'ผังกำลังตรวจภาพที่ประกอบเสร็จ', plan: 'ผังกำลังวางผังภาพ', generate: 'พิมพ์กำลังเจนภาพและไดคัท', assemble: 'ประกอบกำลังรวมเลเยอร์ใน VectorCraft', motion: 'มูฟกำลังทำแอนิเมชันใน EffectCraft' }[stage];
  await logEvent(prisma, task.agent, who, task.id);
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
${previous.length ? `ภาพแนบลำดับที่ 1–${previous.length} คือเวอร์ชันก่อนหน้า ผู้สั่งขอให้แก้: ${task.feedback}\n` : ''}${refs.length ? `ภาพแนบลำดับที่ ${previous.length + 1}–${previous.length + refs.length} คือภาพอ้างอิงที่ผู้สั่งแนบมา ใช้เป็นแนวทางตามคำสั่ง\n` : ''}${learningNote(await rejectLearnings(prisma, 'image', 20))}${rulesNote(await combinedRules(prisma, 'image'))}
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

หน้าที่: คุณคือมูฟ ผู้กำกับโมชันของแอด ${CANVAS[0]}x${CANVAS[1]} ดูภาพที่ประกอบเสร็จที่แนบมา แล้ววางจังหวะเคลื่อนไหวให้คลิปสั้นที่ดูพรีเมียม
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
  const [cx, cy] = [CANVAS[0] / 2, CANVAS[1] / 2];
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
  const jsx = `var comp = app.project.items.addComp("Tasaki ad motion", ${CANVAS[0]}, ${CANVAS[1]}, 1, ${DUR}, 30);
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

async function tick(prisma) {
  if (busy || !isWorkingHours()) return;
  if (DAILY_LIMIT && await runsToday(prisma) >= DAILY_LIMIT) return;
  const task = await prisma.agentTask.findFirst({ where: { status: 'queued' }, orderBy: { createdAt: 'asc' } });
  if (!task) return;
  const agent = AGENTS[task.agent];
  busy = true;
  const started = Date.now();
  try {
    await prisma.agentTask.update({ where: { id: task.id }, data: { status: 'running', startedAt: new Date(), error: '' } });
    await logEvent(prisma, task.agent, `${agent.name} รับงาน: ${(task.prompt || agent.role).slice(0, 80)}`, task.id);
    const { result, sessionId } = task.agent === 'assemble'
      ? await (task.input?.mode === 'demonstration' ? deps.vectorTeaching.learn(task) : deps.vectorTeaching.edit(task))
      : task.agent === 'image' ? await runImagePipeline(task, prisma)
      : task.agent === 'motion' ? await runMotion(task, prisma)
        : await runLanguageAgent(agent, task, prisma, deps);
    await prisma.agentTask.update({
      where: { id: task.id },
      data: { status: 'review', result, sessionId: sessionId || null, rounds: task.rounds + 1, finishedAt: new Date(), durationMs: Date.now() - started },
    });
    await logEvent(prisma, task.agent, `ส่งงานให้หนิงตรวจแล้ว${result?.reviewNote ? ` — ${result.reviewNote}` : ''}`, task.id, { kind: 'handoff', toAgent: 'you', image: result?.images?.[0] || null });
  } catch (e) {
    await prisma.agentTask.update({
      where: { id: task.id },
      data: { status: 'failed', error: String(e.message || e).slice(0, 2000), finishedAt: new Date(), durationMs: Date.now() - started },
    }).catch(() => {});
    await logEvent(prisma, task.agent, `${agent.name} ทำงานไม่สำเร็จ: ${String(e.message || e).slice(0, 120)}`, task.id);
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

export function registerAgentTeam(app, { prisma, invalidateCache, tasakiWebPool }) {
  deps = { prisma, invalidateCache, tasakiWebPool, logEvent };
  loadAgentNames(prisma).catch((e) => console.error('agent names:', e.message));
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
        hours: { days: WORK_DAYS, start: WORK_START_HOUR, end: WORK_END_HOUR },
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
      const since = req.query.since ? new Date(String(req.query.since)) : new Date(Date.now() - 12 * 3600e3);
      const rows = await prisma.agentEvent.findMany({
        where: { createdAt: { gt: Number.isNaN(since.getTime()) ? new Date(0) : since } },
        orderBy: { createdAt: 'desc' }, take: 200,
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
    const text = typeof prompt === 'string' ? prompt.trim() : '';
    const raw = req.body.input && typeof req.body.input === 'object' ? req.body.input : {};
    // Only plain values from the browser; file paths are always resolved here.
    const input = {};
    for (const k of ['cardId', 'date', 'days', 'productModel', 'sourceTaskId', 'headline', 'subhead']) {
      if (typeof raw[k] === 'string' || typeof raw[k] === 'number') input[k] = raw[k];
    }
    if (!text && !def.needsCard && !def.fromImageOnly && agent !== 'website' && agent !== 'ads') return res.status(400).json({ error: 'ใส่คำสั่งงานก่อน' });
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
        await deps.vectorTeaching.sourceFile(String(input.sourceTaskId));
        input.mode = 'edit';
        // She always watches ประกอบ's edits happen live in VectorCraft.
        input.live = true;
      }
      if (def.fromImageOnly) {
        const source = await prisma.agentTask.findUnique({ where: { id: String(input.sourceTaskId || '') } });
        if (!source?.result?.layerFiles?.length) return res.status(400).json({ error: 'ทำแอนิเมชันได้เฉพาะภาพที่มีไฟล์แยกเลเยอร์' });
      }
      if (agent === 'image' && input.productModel) {
        const product = (await productCatalog(tasakiWebPool)).find((p) => p.model === input.productModel);
        if (!product?.image) return res.status(400).json({ error: 'ไม่พบรูปสินค้ารุ่นนี้' });
        input.productImage = product.image;
      }
      const attachments = saveAttachments(req.body.attachments);
      const recent = await recentThread(prisma, agent);
      if (recent.length) input.recent = recent.map(({ attachments: _, ...r }) => r);
      const carried = [...recent].reverse().flatMap((r) => r.attachments);
      if (attachments.length || carried.length) input.attachments = attachments.length ? attachments : [...new Set(carried)].slice(0, 4);
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
      const output = path.join(path.dirname(file), `live-${crypto.randomUUID()}.vectorcraft`);
      const playback = deps.vectorLive.play({ file, output, preview: output.replace('.vectorcraft', '.png'), commands: task.result.commands, taskId: task.id });
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
      await logEvent(prisma, 'you', `✓ ผ่าน — ${note}`, task.id, { kind: 'handoff', toAgent: task.agent });
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
      await prisma.agentTask.update({ where: { id: task.id }, data: { status: 'queued', feedback, input } });
      await logEvent(prisma, 'you', `↻ ให้แก้: ${feedback}${added.length ? ` 📎 ${added.length} ภาพ` : ''}`, task.id, { kind: 'handoff', toAgent: task.agent, image: added[0] || null });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/agents/tasks/:id/reject', requireRunner, async (req, res) => {
    try {
      const task = await prisma.agentTask.findUnique({ where: { id: req.params.id } });
      if (!task || !['review', 'queued', 'failed'].includes(task.status)) return res.status(400).json({ error: 'ยกเลิกงานนี้ไม่ได้' });
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
        usesRules: Boolean(def.buildPrompt || ['layout', 'image', 'assemble', 'motion', TEAM.id].includes(req.params.id)),
      });
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

  const APPS = { vectorcraft: 'VectorCraft', effectcraft: 'EffectCraft', filmcraft: 'FilmCraft' };
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
      if (!task || task.status !== 'failed') return res.status(400).json({ error: 'ลองใหม่ได้เฉพาะงานที่ไม่สำเร็จ' });
      await prisma.agentTask.update({ where: { id: task.id }, data: { status: 'queued', error: '' } });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}
