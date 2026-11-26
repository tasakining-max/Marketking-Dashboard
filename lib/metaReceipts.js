// Meta ad receipts → accounting. Meta has no API for the receipt PDFs, so a
// separate Chrome profile on this Mac (logged in to Facebook once, via
// scripts/meta-receipts-login.mjs) opens Billing & payments › Payment activity
// every morning, downloads each new paid receipt that has a VAT invoice number
// (FBADS-…) and mails the PDFs to accounting (META_RECEIPTS_TO in .env).
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import nodemailer from 'nodemailer';

export const AD_ACCOUNT = '27779386228369874';
export const PROFILE_DIR = path.join(os.homedir(), 'Library/Application Support/TasakiMetaReceipts');
export const BILLING_URL = `https://business.facebook.com/billing_hub/payment_activity?asset_id=${AD_ACCOUNT}`;
const SAVE_DIR = path.join(PROFILE_DIR, 'receipts');
const SENT_KEY = '__meta_receipts_sent';
const DAY_KEY = '__meta_receipts_day';
const LOG_KEY = '__meta_receipts_log';
const SLOT = '09:00';
const LAST_TRY = '17:00';

const bangkok = () => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}` };
};

// Rows on the first page of Payment activity (the last 7 days).
function parseRow(text) {
  const t = text.replace(/\s+/g, ' ').trim();
  const id = (t.match(/\b(\d{10,}-\d{10,})\b/) || [])[1];
  if (!id) return null;
  return {
    id,
    date: (t.match(/\b(\d{1,2} \w{3} \d{4})\b/) || [])[1] || '',
    amount: (t.match(/(฿[\d,]+\.\d{2})/) || [])[1] || '',
    paid: /\bPaid\b/.test(t) && !/\bFailed\b/.test(t),
    invoice: (t.match(/\b(FBADS-[\d-]+)\b/) || [])[1] || '',
  };
}

// Downloads the receipts not sent yet. Returns { rows, files }.
export async function fetchReceipts(skipIds, { firstRun = false } = {}) {
  const { chromium } = await import('playwright');
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, { channel: 'chrome', headless: true, acceptDownloads: true, viewport: { width: 1400, height: 1000 } });
  try {
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto(BILLING_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    try {
      await page.getByText('Download PDF').first().waitFor({ timeout: 60000 });
    } catch {
      const body = (await page.evaluate(() => document.body.innerText).catch(() => '')).slice(0, 400);
      if (/log in|เข้าสู่ระบบ|passkey|confirm that it's you/i.test(body) || /login|checkpoint/.test(page.url())) {
        throw new Error('Facebook ขอให้ล็อกอินหรือยืนยันตัวตนใหม่ ให้รัน node scripts/meta-receipts-login.mjs แล้วล็อกอินในหน้าต่างที่เปิดขึ้น');
      }
      throw new Error('เปิดหน้า Payment activity แล้วไม่เจอรายการใบเสร็จ (หน้าเว็บ Meta อาจเปลี่ยน)');
    }
    const rowLoc = page.locator('[role="row"]');
    const rows = [];
    for (let i = 0; i < await rowLoc.count(); i += 1) {
      const r = parseRow(await rowLoc.nth(i).innerText());
      if (r) rows.push(r);
    }
    if (!rows.length) throw new Error('อ่านรายการใบเสร็จในหน้า Payment activity ไม่ได้ (หน้าเว็บ Meta อาจเปลี่ยน)');
    const files = [];
    if (firstRun) return { rows, files };
    fs.mkdirSync(SAVE_DIR, { recursive: true });
    for (const r of rows) {
      if (!r.paid || !r.invoice || skipIds.has(r.id)) continue;
      const row = rowLoc.filter({ hasText: r.id });
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), row.getByText('Download PDF').click()]);
      const file = path.join(SAVE_DIR, dl.suggestedFilename().replace(/[/:#]/g, ''));
      await dl.saveAs(file);
      if (fs.readFileSync(file).subarray(0, 5).toString() !== '%PDF-') throw new Error(`ไฟล์ที่โหลดของ ${r.id} ไม่ใช่ PDF`);
      files.push({ ...r, file });
    }
    return { rows, files };
  } finally {
    await ctx.close().catch(() => {});
  }
}

function mailer() {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.office365.com',
    port: Number(process.env.SMTP_PORT) || 587,
    secure: false,
    requireTLS: true,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

async function sendReceipts(files) {
  const to = process.env.META_RECEIPTS_TO;
  const m = mailer();
  if (!to || !m) throw new Error('ยังไม่ได้ตั้งเมลผู้รับ (META_RECEIPTS_TO) หรือบัญชีส่งเมล (SMTP_USER/SMTP_PASS) ใน .env');
  const total = files.reduce((s, f) => s + Number(f.amount.replace(/[฿,]/g, '')), 0);
  const lines = files.map((f) => `• ${f.date}  ${f.amount}  Invoice ${f.invoice}`).join('\n');
  await m.sendMail({
    from: process.env.SMTP_USER,
    to,
    subject: `ใบเสร็จค่าโฆษณา Meta (Tasaki Ad Acc) ${files.length} ใบ รวม ฿${total.toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
    text: `เรียน สุนิสา ฝ่ายทำเบิก\n\nแนบใบเสร็จค่าโฆษณา Meta (บัญชีโฆษณา Tasaki Ad Acc) ที่ตัดบัตร Visa ····3192 ดังนี้\n\n${lines}\n\nส่งอัตโนมัติจากระบบ Marketing Dashboard`,
    attachments: files.map((f) => ({ filename: path.basename(f.file), path: f.file, contentType: 'application/pdf' })),
  });
}

const MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
const isoDay = (d, mon, y) => `${y}-${MONTHS[mon] || '00'}-${String(d).padStart(2, '0')}`;
// The spend period a receipt pays for ("From 23 Nov 2026, 00:00 to 24 Nov
// 2026, 23:59" per campaign), read from the PDF. Bangkok local times.
export function receiptPeriod(file) {
  let text = '';
  try { text = execFileSync('/opt/homebrew/bin/pdftotext', ['-layout', file, '-'], { maxBuffer: 8 * 1024 * 1024 }).toString(); } catch { return null; }
  const re = /From (\d{1,2}) (\w{3}) (\d{4}), (\d{2}:\d{2}) to (\d{1,2}) (\w{3}) (\d{4}), (\d{2}:\d{2})/g;
  let from = null; let to = null;
  for (const m of text.matchAll(re)) {
    const f = `${isoDay(m[1], m[2], m[3])} ${m[4]}`; const t = `${isoDay(m[5], m[6], m[7])} ${m[8]}`;
    if (!from || f < from) from = f;
    if (!to || t > to) to = t;
  }
  return from ? { from, to } : null;
}

export async function receiptLog(prisma) {
  try { return JSON.parse((await readSetting(prisma, LOG_KEY)) || '[]'); } catch { return []; }
}
async function addToLog(prisma, files, sentAt) {
  const log = await receiptLog(prisma);
  for (const f of files) {
    if (log.some((x) => x.id === f.id)) continue;
    log.push({ id: f.id, invoice: f.invoice, amount: f.amount, date: f.date, ...(receiptPeriod(f.file) || {}), sentAt, recipient: process.env.META_RECEIPTS_TO || '' });
  }
  await writeSetting(prisma, LOG_KEY, JSON.stringify(log.slice(-1000)));
}

async function readSetting(prisma, key) {
  const row = await prisma.agentSetting.findUnique({ where: { agent: key } });
  return row?.rules ?? null;
}
async function writeSetting(prisma, key, rules) {
  await prisma.agentSetting.upsert({ where: { agent: key }, create: { agent: key, rules }, update: { rules } });
}

// One run: download new receipts and mail them. The first run ever only
// remembers what's already there (those were sent by hand).
export async function runMetaReceipts(prisma, { logEvent, force = false } = {}) {
  let sent = [];
  const raw = await readSetting(prisma, SENT_KEY);
  try { sent = JSON.parse(raw || '[]'); } catch {}
  const firstRun = raw === null && !force;
  const { rows, files } = await fetchReceipts(new Set(sent), { firstRun });
  if (firstRun) {
    await writeSetting(prisma, SENT_KEY, JSON.stringify(rows.map((r) => r.id)));
    return { baseline: rows.length, sent: 0 };
  }
  if (files.length) {
    await sendReceipts(files);
    await writeSetting(prisma, SENT_KEY, JSON.stringify([...sent, ...files.map((f) => f.id)].slice(-500)));
    await addToLog(prisma, files, new Date().toISOString());
    await logEvent?.(prisma, 'ads', `🧾 ส่งใบเสร็จ Meta ให้ฝ่ายบัญชีแล้ว ${files.length} ใบ: ${files.map((f) => `${f.date} ${f.amount}`).join(', ')}`);
  }
  return { sent: files.length };
}

// Daily at 09:00 (Bangkok). On failure it tries again every 30 minutes until
// 17:00 and tells her once, so a lost login is never silent.
let busy = false;
let lastTry = 0;
export async function scheduleMetaReceipts(prisma, { logEvent }) {
  if (busy || !fs.existsSync(PROFILE_DIR)) return;
  const now = bangkok();
  if (now.hm < SLOT || now.hm > LAST_TRY) return;
  let day = {};
  try { day = JSON.parse((await readSetting(prisma, DAY_KEY)) || '{}'); } catch {}
  if (day.date === now.date && day.ok) return;
  if (Date.now() - lastTry < 30 * 60 * 1000) return;
  busy = true; lastTry = Date.now();
  try {
    await runMetaReceipts(prisma, { logEvent });
    await writeSetting(prisma, DAY_KEY, JSON.stringify({ date: now.date, ok: true }));
  } catch (e) {
    const told = day.date === now.date && day.told;
    if (!told) await logEvent(prisma, 'ads', `⚠️ ส่งใบเสร็จ Meta ให้ฝ่ายบัญชีไม่สำเร็จ: ${e.message}`, null, { kind: 'handoff', toAgent: 'you' });
    await writeSetting(prisma, DAY_KEY, JSON.stringify({ date: now.date, ok: false, told: true }));
    console.error('meta receipts:', e.message);
  } finally {
    busy = false;
  }
}
