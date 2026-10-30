// Catalog → website spec sync helpers (used by the "แคท" agent).
//
// The website's ProductSpec rows are transcribed from each model's catalog PDF
// (Product.manualUrl). A script (not AI) finds the PDFs that are new or
// replaced since the specs were last confirmed; the agent only reads a PDF and
// proposes field changes; a script re-checks every proposal against the PDF
// text and the live row before it reaches her, and applies only what she
// approves, with a backup of the old rows written first.
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const WEB_BASE = process.env.TASAKI_WEB_BASE || 'http://192.168.10.10:3000';
// unitModel is editable (the PDF may rename a size); btu stays, it keys the size chips.
const SKIP_COLUMNS = new Set(['id', 'productId', 'btu', 'createdAt', 'updatedAt']);
const PDF_TEXT_LIMIT = 120000;

export async function specColumns(pool) {
  const { rows } = await pool.query(`select column_name, data_type from information_schema.columns where table_name = 'ProductSpec' order by ordinal_position`);
  const out = new Map();
  for (const r of rows) {
    if (SKIP_COLUMNS.has(r.column_name)) continue;
    out.set(r.column_name, r.data_type === 'integer' ? 'int' : r.data_type === 'double precision' ? 'float' : 'text');
  }
  return out;
}

// One group per catalog file: products that share a PDF are synced together.
export async function staleCatalogs(pool) {
  const { rows: stale } = await pool.query(`
    select distinct p."manualUrl" from "Product" p
    where p."deletedAt" is null and p."manualUrl" <> '' and not p."specSyncNotNeeded"
      and (p."specSyncedAt" is null or exists (
        select 1 from "FileVersion" f
        where f."entityType" = 'Product' and f."entityId" = p.id and f.field = 'manualUrl' and f."replacedAt" > p."specSyncedAt"))`);
  const groups = [];
  for (const { manualUrl } of stale) {
    const { rows: products } = await pool.query(`
      select p.id, p.model, p."nameEn", p."specSyncedAt",
        (select max(f."replacedAt") from "FileVersion" f where f."entityType" = 'Product' and f."entityId" = p.id and f.field = 'manualUrl') as "replacedAt",
        (select count(*)::int from "ProductSpec" s where s."productId" = p.id) as specs
      from "Product" p
      where p."deletedAt" is null and p."manualUrl" = $1 and not p."specSyncNotNeeded" order by p.model`, [manualUrl]);
    const latest = products.reduce((m, p) => (p.replacedAt && (!m || p.replacedAt > m) ? p.replacedAt : m), null);
    groups.push({
      manualUrl, products,
      reason: products.every((p) => !p.specSyncedAt) ? 'ยังไม่เคยซิงก์สเปกกับ Catalog นี้' : 'มีการอัปโหลด Catalog ไฟล์ใหม่ทับ',
      signature: `${manualUrl}|${latest ? new Date(latest).toISOString() : 'never'}`,
    });
  }
  return groups;
}

// A catalog she asks about by hand, even when nothing is stale.
export async function groupByUrl(pool, manualUrl, reason = 'หนิงสั่งตรวจเอง') {
  const { rows: products } = await pool.query(`select p.id, p.model, p."nameEn", p."specSyncedAt", null as "replacedAt", (select count(*)::int from "ProductSpec" s where s."productId" = p.id) as specs from "Product" p where p."deletedAt" is null and p."manualUrl" = $1 order by p.model`, [manualUrl]);
  return products.length ? { manualUrl, products, reason, signature: `${manualUrl}|manual` } : null;
}

export async function groupByModelText(pool, text) {
  const t = String(text || '').toLowerCase();
  if (t.length < 3) return null;
  const { rows } = await pool.query(`select distinct "manualUrl", model from "Product" where "deletedAt" is null and "manualUrl" <> ''`);
  const hit = rows.filter((r) => r.model.length > 2 && t.includes(r.model.toLowerCase())).sort((a, b) => b.model.length - a.model.length)[0];
  return hit ? groupByUrl(pool, hit.manualUrl) : null;
}

export async function allCatalogs(pool) {
  const { rows } = await pool.query(`select p."manualUrl", string_agg(p.model, ', ' order by p.model) as models from "Product" p where p."deletedAt" is null and p."manualUrl" <> '' group by p."manualUrl"`);
  return rows;
}

export async function groupSpecs(pool, productIds) {
  const { rows } = await pool.query(`select s.*, p.model as "productModel" from "ProductSpec" s join "Product" p on p.id = s."productId" where s."productId" = any($1) order by p.model, s.btu, s."unitModel"`, [productIds]);
  return rows;
}

const readable = (text) => String(text || '').replace(/\s/g, '').length >= 200;
const ocrCache = new Map();
// Digits and model names are what matter, so English OCR is enough.
async function ocrPdf(file, dir, run, maxPages = 20) {
  await run('/opt/homebrew/bin/pdftoppm', ['-png', '-r', '300', '-l', String(maxPages), file, path.join(dir, 'ocr')]);
  const pages = fs.readdirSync(dir).filter((x) => /^ocr-\d+\.png$/.test(x)).sort((a, b) => parseInt(a.slice(4), 10) - parseInt(b.slice(4), 10));
  const out = [];
  for (const f of pages) out.push(await run('/opt/homebrew/bin/tesseract', [path.join(dir, f), '-', '--psm', '6', '-l', 'eng']).catch(() => ''));
  return out.join('\f');
}

// Downloads the PDF, returns its text and (optionally) page pictures for the
// agent to look at. pagesDir gets p-1.png … for at most maxPages pages.
export async function loadPdf(manualUrl, { pagesDir = '', maxPages = 10 } = {}) {
  if (!/^\/manuals\/[\w.-]+\.pdf$/i.test(manualUrl || '')) throw new Error('ที่อยู่ไฟล์ Catalog ไม่ถูกต้อง');
  const res = await fetch(`${WEB_BASE}/api/files${manualUrl}`, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`ดึงไฟล์ Catalog ไม่ได้ (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.subarray(0, 5).toString() !== '%PDF-') throw new Error('ไฟล์ที่ได้ไม่ใช่ PDF');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-'));
  const file = path.join(dir, 'c.pdf');
  fs.writeFileSync(file, buf);
  const run = (bin, args) => new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 32 * 1024 * 1024, timeout: 90000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
  try {
    let text = await run('/opt/homebrew/bin/pdftotext', ['-layout', file, '-']);
    // Text exported as outlines (e.g. from Illustrator) leaves almost nothing
    // to extract: read the rendered pages with OCR instead. Each upload gets a
    // new URL, so the OCR text is cached per URL.
    let ocr = false;
    if (!readable(text)) {
      if (!ocrCache.has(manualUrl)) ocrCache.set(manualUrl, await ocrPdf(file, dir, run));
      const read = ocrCache.get(manualUrl);
      if (readable(read)) { text = read; ocr = true; }
    }
    const images = [];
    const details = [];
    if (pagesDir) {
      fs.mkdirSync(pagesDir, { recursive: true });
      await run('/opt/homebrew/bin/pdftoppm', ['-png', '-r', '60', '-l', String(maxPages), file, path.join(pagesDir, 'p')]);
      for (const f of fs.readdirSync(pagesDir).filter((x) => /^p-\d+\.png$/.test(x)).sort((a, b) => parseInt(a.slice(2), 10) - parseInt(b.slice(2), 10))) images.push(path.join(pagesDir, f));
      // A labelled pixel grid lets the agent read a logo's position off the picture.
      if (images.length) await run('/usr/bin/python3', [path.join(path.dirname(fileURLToPath(import.meta.url)), 'pageGrid.py'), ...images]);
      // Sharp copies without the grid, for reading small table cells and marks.
      const detailDir = path.join(pagesDir, 'detail');
      fs.mkdirSync(detailDir, { recursive: true });
      await run('/opt/homebrew/bin/pdftoppm', ['-png', '-r', '150', '-l', String(maxPages), file, path.join(detailDir, 'd')]);
      for (const f of fs.readdirSync(detailDir).filter((x) => /^d-\d+\.png$/.test(x)).sort((a, b) => parseInt(a.slice(2), 10) - parseInt(b.slice(2), 10))) details.push(path.join(detailDir, f));
    }
    let meta = [];
    try {
      const out = await run('/usr/bin/python3', [path.join(path.dirname(fileURLToPath(import.meta.url)), 'metaBrandScrub.py'), 'scan', file, META_BRANDS]);
      meta = JSON.parse(out.trim().split('\n').pop()).hits || [];
    } catch { /* metadata scan is best effort */ }
    return { text, images, details, meta, ocr };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Saves the catalog as a file (for editing with PDFCraft).
export async function savePdf(manualUrl, file) {
  if (!/^\/manuals\/[\w.-]+\.pdf$/i.test(manualUrl || '')) throw new Error('ที่อยู่ไฟล์ Catalog ไม่ถูกต้อง');
  const res = await fetch(`${WEB_BASE}/api/files${manualUrl}`, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`ดึงไฟล์ Catalog ไม่ได้ (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.subarray(0, 5).toString() !== '%PDF-') throw new Error('ไฟล์ที่ได้ไม่ใช่ PDF');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
}

export const UNREADABLE_PDF = 'อ่านตัวหนังสือจาก PDF ไม่ได้ ทั้งข้อความในไฟล์และ OCR จากภาพหน้า';
export async function pdfText(manualUrl) {
  const { text } = await loadPdf(manualUrl);
  if (!readable(text)) throw new Error(UNREADABLE_PDF);
  return text;
}

export const META_BRANDS = '\\b(midea|daikin|mitsubishi|gree|panasonic|toshiba|hitachi|samsung|haier|hisense|fujitsu|trane|lennox|chigo|kaysun|saijo|electrolux)\\b';
// Other makers' names and foreign web addresses left in a Tasaki catalog
// (e.g. an OEM's original cover). Text only; logos are checked by the agent.
const FOREIGN_BRANDS = /\b(midea|daikin|mitsubishi|gree|panasonic|toshiba|hitachi|samsung|haier|hisense|fujitsu|trane|lennox|chigo|kaysun|saijo|electrolux|carrier|york)\b/gi;
const WEB_ADDRESS = /\b(?:[a-z0-9-]+\.)+(?:com|org|net|cn|co\.th|or\.th|go\.th)\b/gi;
const OWN_ADDRESSES = /tasaki|ahridirectory|eurovent|tisi|iso\.org/i;
// Template filler that slipped into a finished catalog; always removed.
export const PLACEHOLDER = /\blorem(?:\s+ipsum)?(?:\s+dolor(?:\s+sit(?:\s+amet)?)?)?\b[,.]?/gi;
export function brandHits(text) {
  const found = new Map();
  text.split('\f').forEach((page, i) => {
    const add = (kind, term) => {
      const key = `${kind}:${term.toLowerCase()}`;
      const hit = found.get(key) || { kind, term, count: 0, pages: new Set() };
      hit.count += 1; hit.pages.add(i + 1);
      found.set(key, hit);
    };
    for (const m of page.matchAll(FOREIGN_BRANDS)) add('brand', m[0]);
    for (const m of page.matchAll(WEB_ADDRESS)) if (!OWN_ADDRESSES.test(m[0])) add('web', m[0]);
    for (const m of page.matchAll(PLACEHOLDER)) add('placeholder', m[0].trim());
  });
  return [...found.values()].map((h) => ({ ...h, pages: [...h.pages] })).sort((a, b) => b.count - a.count);
}

// -layout pads tables with long runs of spaces; squeeze them so big catalogs fit whole.
export const clipPdfText = (text) => {
  const t = text.replace(/[ \t]{3,}/g, '  ');
  return t.length > PDF_TEXT_LIMIT ? `${t.slice(0, PDF_TEXT_LIMIT)}\n[…ตัดท้ายเพราะยาวเกิน]` : t;
};

const numberTokens = (text) => new Set((String(text).replace(/(\d),(\d)/g, '$1$2').match(/\d+(?:\.\d+)?/g) || []).map((n) => String(Number(n))));
const alnum = (t) => String(t).toLowerCase().replace(/[^a-z0-9ก-๙]/g, '');
const sameValue = (a, b) => String(a ?? '').trim() === String(b ?? '').trim() || (a !== '' && b !== '' && a != null && b != null && Number(a) === Number(b));

// Keep only proposals that are checkable against the live row and the PDF.
export function checkChanges(changes, rows, columns, text) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const tokens = numberTokens(text);
  const flat = alnum(text);
  const kept = [];
  const dropped = [];
  for (const c of changes || []) {
    const row = byId.get(c.specId);
    const type = columns.get(c.field);
    const label = `${row?.unitModel || c.specId} · ${c.field}`;
    if (!row || !type) { dropped.push(`${label}: ไม่รู้จักแถวหรือช่องนี้`); continue; }
    const newValue = String(c.newValue ?? '').trim();
    if (!newValue) { dropped.push(`${label}: ค่าใหม่ว่าง`); continue; }
    if (!sameValue(c.oldValue, row[c.field])) { dropped.push(`${label}: ค่าเดิมที่โมเดลอ้างไม่ตรงกับในเว็บ`); continue; }
    if (sameValue(newValue, row[c.field])) continue;
    if (type !== 'text' && !Number.isFinite(Number(newValue.replace(/,/g, '')))) { dropped.push(`${label}: ค่าใหม่ไม่ใช่ตัวเลข`); continue; }
    const digits = [...numberTokens(newValue)];
    // Watt columns may be printed in kW in the PDF (0.70 kW stored as 700 W).
    const inPdf = (n) => tokens.has(n) || (/W$/.test(c.field) && type !== 'text' && tokens.has(String(Number(n) / 1000)));
    const found = c.field === 'unitModel' ? flat.includes(alnum(newValue))
      : digits.length ? digits.every(inPdf) : flat.includes(alnum(newValue));
    if (!found) { dropped.push(`${label}: ไม่พบค่า ${newValue} ใน PDF`); continue; }
    kept.push({
      specId: row.id, unitModel: row.unitModel, productModel: row.productModel, field: c.field,
      oldValue: row[c.field] == null ? '' : String(row[c.field]), newValue: type === 'text' ? newValue : String(Number(newValue.replace(/,/g, ''))), quote: String(c.quote || '').slice(0, 300),
    });
  }
  return { kept, dropped };
}

// Writes the approved changes in one transaction, after saving the old rows.
export async function applyChanges(pool, { products, changes, markSynced, by, backupDir }) {
  const columns = await specColumns(pool);
  const ids = [...new Set(changes.map((c) => c.specId))];
  const client = await pool.connect();
  try {
    await client.query('begin');
    const { rows: before } = ids.length ? await client.query(`select * from "ProductSpec" where id = any($1)`, [ids]) : { rows: [] };
    let backupFile = '';
    if (before.length) {
      fs.mkdirSync(backupDir, { recursive: true });
      backupFile = path.join(backupDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${products.map((p) => p.model).join('_').replace(/[^\w.-]+/g, '-').slice(0, 60)}.json`);
      fs.writeFileSync(backupFile, JSON.stringify(before, null, 2));
    }
    const current = new Map(before.map((r) => [r.id, r]));
    for (const c of changes) {
      const type = columns.get(c.field);
      const row = current.get(c.specId);
      if (!type || !row) throw new Error(`แถวหรือช่องหายไประหว่างบันทึก: ${c.unitModel} ${c.field}`);
      if (!sameValue(c.oldValue, row[c.field])) throw new Error(`${c.unitModel} ${c.field} ในเว็บเปลี่ยนไปแล้วหลังตรวจ ให้สั่งตรวจใหม่`);
      const value = type === 'int' ? Math.round(Number(c.newValue)) : type === 'float' ? Number(c.newValue) : c.newValue;
      await client.query(`update "ProductSpec" set "${c.field}" = $1, "updatedAt" = now() where id = $2`, [value, c.specId]);
    }
    if (markSynced) {
      await client.query(`update "Product" set "specSyncedAt" = now(), "specSyncedBy" = $1, "updatedAt" = now() where id = any($2)`, [by, products.map((p) => p.id)]);
    }
    await client.query('commit');
    return { backupFile, applied: changes.length };
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ─── Upload a fixed catalog to the website (CATALOG_BOT account) ─────────────
// Talks to the public site over normal, verified HTTPS. The account may only
// upload a catalog PDF and set Product.manualUrl (enforced by the website);
// the website keeps the replaced file in its file history so it can be restored.
const SITE = process.env.TASAKI_WEB_SITE || 'https://www.tasaki.co.th';

const siteFetch = (pathname, init = {}, cookie = '') => fetch(`${SITE}${pathname}`, {
  ...init, headers: { ...(init.headers || {}), ...(cookie ? { cookie } : {}) }, signal: AbortSignal.timeout(120000),
});

export async function uploadFixedCatalog({ file, products }) {
  const email = process.env.TASAKI_WEB_BOT_EMAIL;
  const password = process.env.TASAKI_WEB_BOT_PASSWORD;
  if (!email || !password) throw new Error('ยังไม่ได้ตั้งบัญชีทีม AI ของเว็บใน .env');
  if (!file || !fs.existsSync(file)) throw new Error('ไม่พบไฟล์ที่แก้แล้ว สั่งแคทตรวจใหม่');
  let buf = fs.readFileSync(file);
  if (buf.subarray(0, 5).toString() !== '%PDF-') throw new Error('ไฟล์ที่แก้แล้วไม่ใช่ PDF');
  // The website refuses uploads over ~10 MB (answers 500). Its own upload step
  // recompresses images with Ghostscript anyway, so do the same here first.
  if (buf.length > 8 * 1024 * 1024) {
    const small = path.join(os.tmpdir(), `catalog-up-${Date.now()}.pdf`);
    try {
      await new Promise((resolve, reject) => {
        execFile('/opt/homebrew/bin/gs', ['-sDEVICE=pdfwrite', '-dCompatibilityLevel=1.4', '-dPDFSETTINGS=/ebook', '-dNOPAUSE', '-dQUIET', '-dBATCH', `-sOutputFile=${small}`, file], { timeout: 180000 }, (err) => (err ? reject(err) : resolve()));
      });
      const out = fs.readFileSync(small);
      if (out.subarray(0, 5).toString() === '%PDF-' && out.length < buf.length) buf = out;
    } catch { /* fall through to the size check */ } finally { fs.rmSync(small, { force: true }); }
    if (buf.length > 9.5 * 1024 * 1024) throw new Error(`ไฟล์ใหญ่เกินที่เว็บรับได้ (${(buf.length / 1048576).toFixed(1)} MB) ลดขนาดไฟล์ก่อน`);
  }

  const login = await siteFetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  if (!login.ok) throw new Error(`ล็อกอินบัญชีทีม AI ของเว็บไม่สำเร็จ (${login.status})`);
  const cookie = (login.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  if (!cookie) throw new Error('ล็อกอินแล้วแต่ไม่ได้รับ session');
  try {
    const form = new FormData();
    form.append('file', new Blob([buf], { type: 'application/pdf' }), path.basename(file));
    const up = await siteFetch('/api/upload/manual', { method: 'POST', body: form }, cookie);
    const upBody = await up.json().catch(() => ({}));
    if (!up.ok || !upBody.url) throw new Error(`อัปโหลดไฟล์ไม่สำเร็จ (${up.status}) ${upBody.error || ''}`.trim());
    const done = [];
    for (const p of products) {
      const r = await siteFetch(`/api/products/${encodeURIComponent(p.id)}/manual`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ manualUrl: upBody.url }) }, cookie);
      if (!r.ok) throw new Error(`ผูกไฟล์กับ ${p.model} ไม่สำเร็จ (${r.status}) ผูกสำเร็จแล้ว: ${done.join(', ') || 'ยังไม่มี'} · ไฟล์ใหม่อยู่ที่ ${upBody.url}`);
      done.push(p.model);
    }
    return { url: upBody.url, models: done };
  } finally {
    await siteFetch('/api/auth/logout', { method: 'POST' }, cookie).catch(() => {});
  }
}
