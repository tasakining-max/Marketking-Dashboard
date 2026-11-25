// Watches the Marketing team 2026 SharePoint folders that are synced (online-only)
// through the OneDrive app on the Mac. Only names, sizes and dates are read, so
// nothing is downloaded — except a changed Catalog PDF, which is read once to
// compare it with the PDF the website uses, then made online-only again.
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { groupByModelText, pdfText } from './catalogSync.js';

const ONEDRIVE = path.join(os.homedir(), 'Library/CloudStorage/OneDrive-bitwise.co.th');
export const WATCHED = [
  { name: 'Catalog 2026', dir: 'Marketing team 2026 - Catalog 2026', catalog: true },
  { name: 'รูปสินค้า Tasaki 2026', dir: 'Marketing team 2026 - รูปสินค้า Tasaki 2026' },
];
const SNAPSHOT_KEY = '__onedrive_snapshot';
const PENDING_KEY = '__onedrive_pending';
const JUNK = /^(\.DS_Store|Icon\r?|~\$.*|.*\.tmp|\..*)$/i;
const MAX_PDF_CHECKS = 5;

function walk(root, rel = '', out = {}) {
  let entries = [];
  try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (JUNK.test(e.name)) continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walk(root, r, out);
    else {
      try {
        const st = fs.statSync(path.join(root, r));
        out[r] = `${st.size}|${Math.round(st.mtimeMs)}`;
      } catch {}
    }
  }
  return out;
}

const run = (bin, args) => new Promise((resolve, reject) => {
  execFile(bin, args, { maxBuffer: 64 * 1024 * 1024, timeout: 180000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
});
// Thai vowel/tone marks come out of PDFs in either order (ั่ vs ่ั), so they're
// left out when comparing.
const THAI_MARKS = /[\u0E31\u0E34-\u0E3A\u0E47-\u0E4E]/g;
const words = (t) => String(t || '').normalize('NFC').replace(THAI_MARKS, '').toLowerCase().replace(/[()[\]{}:;,|"'“”]/g, ' ').split(/\s+/).filter(Boolean);
function wordDiff(a, b) {
  const count = (list) => list.reduce((m, k) => m.set(k, (m.get(k) || 0) + 1), new Map());
  const ca = count(words(a)); const cb = count(words(b));
  const only = (x, y) => [...x].filter(([k, v]) => v > (y.get(k) || 0)).map(([k]) => k);
  return { onlyA: only(ca, cb), onlyB: only(cb, ca) };
}
// The original spelling of a word, for showing her.
const original = (text, w) => String(text || '').replace(/[()[\]{}:;,|"'“”]/g, ' ').split(/\s+/).find((x) => x.normalize('NFC').replace(THAI_MARKS, '').toLowerCase() === w) || w;

// Reads a OneDrive PDF (this downloads it), then makes it online-only again
// with a tiny Swift helper (Finder's "Free Up Space"), compiled once.
const EVICT_SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'evictFile.swift');
const EVICT_BIN = path.join(os.tmpdir(), 'tasaki-evict-file');
async function evict(file) {
  if (!fs.existsSync(EVICT_BIN)) await run('/usr/bin/swiftc', ['-O', EVICT_SRC, '-o', EVICT_BIN]);
  // Right after reading, the file can still be "in use" for a few seconds.
  for (let i = 0; ; i += 1) {
    try { return await run(EVICT_BIN, [file]); } catch (e) {
      if (i >= 4) throw e;
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}
async function oneDrivePdfText(file) {
  try {
    return await run('/opt/homebrew/bin/pdftotext', ['-layout', file, '-']);
  } finally {
    await evict(file).catch((e) => console.error('onedrive evict:', e.message));
  }
}

const catNo = (t) => (String(t || '').match(/CAT\.?\s*NO\.?\s*[:.]?\s*([A-Z0-9][A-Z0-9.\-/]{6,})/i) || [])[1]?.replace(/[.\-]+$/, '').toUpperCase() || '';

export async function compareCatalog(pool, file, rel) {
  const name = path.basename(rel);
  let text = '';
  try { text = await oneDrivePdfText(file); } catch (e) { return `   ↳ เปิดอ่าน PDF ไม่ได้ (${e.message.slice(0, 80)})`; }
  const group = await groupByModelText(pool, `${name}\n${text.slice(0, 20000)}`).catch(() => null);
  if (!group) return '   ↳ ไม่เจอรุ่นในไฟล์นี้บนเว็บ (อาจเป็นรุ่นใหม่ หรือไม่ใช่ Catalog สินค้า)';
  const models = group.products.map((p) => p.model).join(', ');
  let webText = '';
  try { webText = await pdfText(group.manualUrl); } catch (e) { return `   ↳ ตรงกับ ${models} บนเว็บ แต่เปิด Catalog บนเว็บไม่ได้ (${e.message.slice(0, 80)})`; }
  const { onlyA, onlyB } = wordDiff(text, webText);
  if (words(text).length && !onlyA.length && !onlyB.length) return `   ↳ ✅ เว็บใช้ไฟล์นี้แล้ว (${models})`;
  const show = (list, src) => list.slice(0, 8).map((w) => original(src, w)).join(', ') + (list.length > 8 ? ` …(+${list.length - 8})` : '');
  // The printed catalogue number (CAT.NO.TS-…-23S-01) is what says which
  // edition a file is — not the upload or file dates.
  const odNo = catNo(text); const webNo = catNo(webText);
  const head = !odNo || !webNo
    ? `   ↳ ⚠️ เนื้อหาต่างจาก Catalog บนเว็บ (${models}) — เลข Catalog: ไฟล์นี้ ${odNo || 'ไม่พบ'} · บนเว็บ ${webNo || 'ไม่พบ'}`
    : odNo === webNo
      ? `   ↳ ⚠️ เลข Catalog เดียวกัน (${odNo}) แต่เนื้อหาไม่ตรงกับบนเว็บ (${models}) — ต้องเช็กว่าอันไหนถูก`
      : `   ↳ ⚠️ เลข Catalog ต่างกัน (${models}): ไฟล์นี้ ${odNo} · บนเว็บ ${webNo}`;
  return head
    + (onlyA.length ? `\n      ไฟล์ใน OneDrive มี: ${show(onlyA, text)}` : '')
    + (onlyB.length ? `\n      บนเว็บมี: ${show(onlyB, webText)}` : '')
    + '\n      ถ้าไฟล์นี้ถูก อัปโหลดในหน้า admin แล้วแคทจะตรวจสเปกเทียบให้เองตอน 08:30';
}

export async function checkOneDrive(prisma, { pool, logEvent }) {
  if (!fs.existsSync(ONEDRIVE)) return;
  const now = {};
  for (const w of WATCHED) {
    const root = path.join(ONEDRIVE, w.dir);
    if (!fs.existsSync(root)) continue;
    for (const [rel, sig] of Object.entries(walk(root))) now[`${w.dir}/${rel}`] = sig;
  }
  if (!Object.keys(now).length) return;
  const read = async (key) => {
    const row = await prisma.agentSetting.findUnique({ where: { agent: key } });
    try { return row ? JSON.parse(row.rules) : null; } catch { return null; }
  };
  const save = (key, value) => {
    const rules = JSON.stringify(value);
    return prisma.agentSetting.upsert({ where: { agent: key }, create: { agent: key, rules }, update: { rules } });
  };
  const prev = await read(SNAPSHOT_KEY);
  if (!prev) { await save(SNAPSHOT_KEY, now); return; } // first look: just remember what's there

  const diff = { added: [], changed: [], removed: [] };
  for (const [k, sig] of Object.entries(now)) {
    if (!(k in prev)) diff.added.push(k);
    else if (prev[k] !== sig) diff.changed.push(k);
  }
  for (const k of Object.keys(prev)) if (!(k in now)) diff.removed.push(k);
  const changedKeys = [...diff.added, ...diff.changed, ...diff.removed];
  // Wait one more minute after the last change so an upload in progress is
  // reported once, as a whole.
  const sig = JSON.stringify(changedKeys.map((k) => `${k}=${now[k] || '-'}`).sort());
  if (!changedKeys.length) { await save(PENDING_KEY, null); return; }
  const pending = await read(PENDING_KEY);
  if (pending !== sig) { await save(PENDING_KEY, sig); return; }
  await save(PENDING_KEY, null);
  await save(SNAPSHOT_KEY, now);

  for (const w of WATCHED) {
    const mine = (list) => list.filter((k) => k.startsWith(`${w.dir}/`)).map((k) => k.slice(w.dir.length + 1));
    const added = mine(diff.added); const changed = mine(diff.changed); const removed = mine(diff.removed);
    if (!added.length && !changed.length && !removed.length) continue;
    const lines = [];
    let pdfChecks = 0;
    const show = async (icon, list, canCheck) => {
      for (const rel of list.slice(0, 15)) {
        lines.push(`${icon} ${rel}`);
        if (canCheck && w.catalog && /\.pdf$/i.test(rel) && pool && pdfChecks < MAX_PDF_CHECKS) {
          pdfChecks += 1;
          lines.push(await compareCatalog(pool, path.join(ONEDRIVE, w.dir, rel), rel).catch((e) => `   ↳ ตรวจเทียบไม่ได้ (${e.message.slice(0, 80)})`));
        }
      }
      if (list.length > 15) lines.push(`   … และอีก ${list.length - 15} ไฟล์`);
    };
    await show('🆕', added, true);
    await show('✏️', changed, true);
    await show('🗑', removed, false);
    const summary = [added.length && `ใหม่ ${added.length}`, changed.length && `แก้ ${changed.length}`, removed.length && `ลบ ${removed.length}`].filter(Boolean).join(' · ');
    await logEvent(prisma, 'catalog', `📂 OneDrive "${w.name}" มีไฟล์เปลี่ยน (${summary}):\n${lines.join('\n')}`, null, { kind: 'handoff', toAgent: 'you' });
  }
}
