// Fixes another maker's name / web address / logo left in a catalog PDF, with
// PDFCraft's own CLI (no AI edits the file). Text keeps its font, size and
// colour (text_edit on the line); a logo is covered by a patch of the
// surrounding colour carrying the Tasaki logo. Nothing is uploaded: the fixed
// copy is saved locally and shown to her before/after.
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(os.homedir(), '.local', 'bin', 'pdfcraft-cli');
const LOGO_LIGHT = path.join(ROOT, 'public', 'assets', 'tasaki-logo-blue.png');
const LOGO_DARK = path.join(ROOT, 'public', 'assets', 'tasaki-logo-white.png');
const LOGO_GRAY = path.join(ROOT, 'public', 'assets', 'tasaki-logo-gray.png');
const OWN_SITE = 'www.tasaki.co.th';

// Same list as the scan, minus the ones that are also ordinary words.
const FIX_BRANDS = /\b(midea|daikin|mitsubishi|gree|panasonic|toshiba|hitachi|samsung|haier|hisense|fujitsu|trane|lennox|chigo|kaysun|saijo|electrolux)\b/gi;
const THAI_BRANDS = /(มีเดีย|ไดกิ้น|ไดกิ้น|มิตซูบิชิ|พานาโซนิค|โตชิบา|ฮิตาชิ|ซัมซุง|ไฮเออร์|ฟูจิตสึ)/g;
const WEB_ADDRESS = /\b(?:[a-z0-9-]+\.)+(?:com|org|net|cn|co\.th|or\.th|go\.th)\b/gi;
const OWN_ADDRESSES = /tasaki|ahridirectory|eurovent|tisi|iso\.org/i;
const PLACEHOLDER = /\blorem(?:\s+ipsum)?(?:\s+dolor(?:\s+sit(?:\s+amet)?)?)?\b[,.]?/gi;
// The other maker's postal address can't be fixed by swapping a word.
const FOREIGN_ADDRESS = /\b(china|shunde|foshan|guangdong|guangzhou|shenzhen|postal code)\b|,\s*PRC\b/i;

// Tasaki's own head office (as on tasaki.co.th/contact) replaces another
// maker's address block, in the language the line was written in.
const ADDRESS_EN = 'Add.: Thai Tasaki Engineering Co., Ltd., 89/55 Moo 20, Teparak Road, Bangpleeyai, Bangplee, Samuthprakarn, Thailand';
const ADDRESS_TH = 'ที่อยู่: บริษัท ไทย ทาซากิ เอ็นจิเนียริ่ง จำกัด 89/55 หมู่ 20 ถ.เทพารักษ์ ต.บางพลีใหญ่ อ.บางพลี จ.สมุทรปราการ';
export function replaceAddress(text) {
  const t = String(text);
  const thai = /[\u0E00-\u0E7F]/.test(t);
  if (/postal code/i.test(t) && /\d{5,6}/.test(t)) return t.replace(/(postal code:?\s*)\d{5,6}/i, '$110540');
  if (/รหัสไปรษณีย์/.test(t) && /\d{5,6}/.test(t)) return t.replace(/(รหัสไปรษณีย์:?\s*)\d{5,6}/, '$110540');
  if (/\b(china|shunde|foshan|guangdong|guangzhou|shenzhen)\b|,\s*PRC\b/i.test(t) && /\b(add(ress)?\.?|ที่อยู่)/i.test(t)) return thai ? ADDRESS_TH : ADDRESS_EN;
  return null;
}

// What a line becomes: Latin names → Tasaki, Thai names → ทาซากิ, other
// maker's web addresses → Tasaki's. (Keeps ALL CAPS if the original was.)
export function replaceBrands(text) {
  return String(text)
    .replace(WEB_ADDRESS, (m) => (OWN_ADDRESSES.test(m) ? m : OWN_SITE))
    .replace(FIX_BRANDS, (m) => (m === m.toUpperCase() && m.length > 1 ? 'TASAKI' : 'Tasaki'))
    .replace(THAI_BRANDS, 'ทาซากิ');
}

// pdfcraft-cli prints one JSON object per step, back to back.
function parseStream(out) {
  const results = [];
  let depth = 0; let start = -1; let inStr = false; let esc = false;
  for (let i = 0; i < out.length; i += 1) {
    const ch = out[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') { if (depth === 0) start = i; depth += 1; }
    else if (ch === '}') { depth -= 1; if (depth === 0 && start >= 0) { try { results.push(JSON.parse(out.slice(start, i + 1))); } catch {} start = -1; } }
  }
  return results;
}

function run(args, { timeout = 300000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(CLI, args, { maxBuffer: 256 * 1024 * 1024, timeout }, (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim().slice(-400))) : resolve(stdout)));
  });
}

async function runSteps(dir, steps) {
  const file = path.join(dir, `steps-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(steps));
  const results = parseStream(await run(['run', '--script', file, '--root', dir]));
  if (results.length < steps.length) throw new Error('PDFCraft ทำงานไม่ครบทุกขั้น');
  return results;
}

const py = (args) => new Promise((resolve, reject) => {
  execFile('/usr/bin/python3', [path.join(ROOT, 'lib', 'logoPatch.py'), ...args], (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim().slice(-300))) : resolve(stdout.trim())));
});

const cropPy = `
import sys
from PIL import Image
src, dpi, x0, y0, x1, y1, out = sys.argv[1:8]
k = float(dpi) / 72.0
im = Image.open(src).convert('RGB')
pad = 24
box = (max(0, int(float(x0) * k) - pad), max(0, int(float(y0) * k) - pad), min(im.width, int(float(x1) * k) + pad), min(im.height, int(float(y1) * k) + pad))
if box[2] <= box[0] or box[3] <= box[1]:
    box = (0, 0, min(im.width, 200), min(im.height, 60))
c = im.crop(box)
if c.width < 400:
    f = 400 / c.width
    c = c.resize((400, max(1, int(c.height * f))), Image.LANCZOS)
c.save(out)
`;
const crop = (src, dpi, rect, out) => new Promise((resolve, reject) => {
  execFile('/usr/bin/python3', ['-c', cropPy, src, String(dpi), ...rect.map(String), out], (err, _o, stderr) => (err ? reject(new Error(stderr.slice(-200))) : resolve(out)));
});

const diffPy = `
import sys, json
from PIL import Image, ImageChops
b, a, dpi, rects = sys.argv[1], sys.argv[2], float(sys.argv[3]), json.loads(sys.argv[4])
k = dpi / 72.0
ib, ia = Image.open(b).convert('L'), Image.open(a).convert('L')
out = []
for x0, y0, x1, y1 in rects:
    box = (max(0, int(x0 * k) - 3), max(0, int(y0 * k) - 3), min(ib.width, int(x1 * k) + 3), min(ib.height, int(y1 * k) + 3))
    if box[2] <= box[0] or box[3] <= box[1]:
        out.append(0)
        continue
    d = ImageChops.difference(ib.crop(box), ia.crop(box))
    h = d.histogram()
    n = sum(h) or 1
    out.append(sum(i * v for i, v in enumerate(h)) / n)
print(json.dumps(out))
`;
const regionDiffs = (before, after, rects) => new Promise((resolve, reject) => {
  execFile('/usr/bin/python3', ['-c', diffPy, before, after, '100', JSON.stringify(rects)], (err, stdout, stderr) => (err ? reject(new Error(stderr.slice(-200))) : resolve(JSON.parse(stdout))));
});

// Text edits that change how the page looks are rolled back: in files where
// someone already covered the other brand with a white patch labelled
// "Tasaki", rewriting the hidden line underneath breaks that patch. Only edits
// that leave the picture unchanged (pure text-layer fixes) are kept.
export async function applySafeTextEdits(srcPdf, outPdf, edits, workDir, threshold = 1.5) {
  if (!edits.length) { fs.copyFileSync(srcPdf, outPdf); return { kept: [], skipped: [] }; }
  const trial = path.join(workDir, 'trial.pdf');
  await applyFix(srcPdf, trial, { edits, logos: [] }, workDir);
  const kept = []; const skipped = [];
  for (const page of [...new Set(edits.map((e) => e.page))]) {
    const b = path.join(workDir, `sb${page}.png`); const a = path.join(workDir, `sa${page}.png`);
    await run(['render', srcPdf, '--page', String(page), '--dpi', '100', '--out', b]);
    await run(['render', trial, '--page', String(page), '--dpi', '100', '--out', a]);
    const mine = edits.filter((e) => e.page === page);
    const diffs = await regionDiffs(b, a, mine.map((e) => e.rect));
    // Removing filler text is meant to change the picture: always kept.
    mine.forEach((e, i) => (e.kind === 'placeholder' || diffs[i] <= threshold ? kept : skipped).push(e));
  }
  if (!skipped.length) fs.copyFileSync(trial, outPdf);
  else await applyFix(srcPdf, outPdf, { edits: kept, logos: [] }, workDir);
  return { kept, skipped };
}

// Where another brand is still in the text but covered by someone's "Tasaki"
// label, re-typesetting the text breaks the page. hiddenBrandStrip.py drops
// just those glyphs from the content stream and keeps every other glyph in
// place; the result is only accepted when the pages look the same.
export async function stripHiddenBrands(srcPdf, outPdf, pages, workDir, maxMeanDiff = 0.6) {
  const trial = path.join(workDir, 'strip.pdf');
  const out = await new Promise((resolve, reject) => {
    execFile('/usr/bin/python3', [path.join(ROOT, 'lib', 'hiddenBrandStrip.py'), srcPdf, trial, FIX_BRANDS.source], { maxBuffer: 16 * 1024 * 1024, timeout: 300000 }, (err, stdout, stderr) => (err ? reject(new Error(stderr.slice(-300))) : resolve(stdout)));
  });
  const info = JSON.parse(out.trim().split('\n').pop());
  const touched = Object.keys(info.removed).map(Number);
  const diffs = [];
  for (const page of touched) {
    const b = path.join(workDir, `hb${page}.png`); const a = path.join(workDir, `ha${page}.png`);
    await run(['render', srcPdf, '--page', String(page), '--dpi', '100', '--out', b]);
    await run(['render', trial, '--page', String(page), '--dpi', '100', '--out', a]);
    const [d] = await regionDiffs(b, a, [[0, 0, 100000, 100000]]);
    diffs.push({ page, diff: d });
  }
  const bad = diffs.filter((d) => d.diff > maxMeanDiff);
  if (bad.length || !touched.length) return { applied: false, removed: info.removed, bad, skippedFonts: info.skippedFonts };
  fs.copyFileSync(trial, outPdf);
  return { applied: true, removed: info.removed, bad: [], skippedFonts: info.skippedFonts };
}

const META_PY = path.join(ROOT, 'lib', 'metaBrandScrub.py');
const metaPattern = () => FIX_BRANDS.source;
const pyJson = (args) => new Promise((resolve, reject) => {
  execFile('/usr/bin/python3', args, { maxBuffer: 16 * 1024 * 1024, timeout: 300000 }, (err, stdout, stderr) => (err ? reject(new Error(stderr.slice(-300))) : resolve(JSON.parse(stdout.trim().split('\n').pop()))));
});

// Brand names outside the page text: info, XMP, editor private data (old file
// paths), swatch names such as "Midea Blue". Swapped for Tasaki; the page
// drawing is untouched.
export const scanMeta = async (file) => (await pyJson([META_PY, 'scan', file, metaPattern()])).hits;
export async function scrubMeta(srcPdf, outPdf) {
  const r = await pyJson([META_PY, 'scrub', srcPdf, outPdf, metaPattern()]);
  return { replaced: r.replaced, hitsAfter: r.hits_after };
}

// Page pictures of the fixed file for the chat, with a red circle around every
// spot that was changed (the circles are only in the picture, never in the PDF).
// spots: [{ page, rect }] in PDF points.
export async function pagePreviews(pdf, pages, outDir, prefix, spots = [], dpi = 75) {
  fs.mkdirSync(outDir, { recursive: true });
  const out = [];
  for (const page of pages) {
    const file = path.join(outDir, `${prefix}-p${page}.png`);
    await run(['render', pdf, '--page', String(page), '--dpi', String(dpi), '--out', file]);
    const rects = spots.filter((s) => s.page === page && Array.isArray(s.rect)).map((s) => s.rect);
    if (rects.length) {
      await new Promise((resolve, reject) => {
        execFile('/usr/bin/python3', [path.join(ROOT, 'lib', 'circleMarks.py'), file, String(dpi), file, JSON.stringify(rects)], (err, _o, stderr) => (err ? reject(new Error(stderr.slice(-200))) : resolve()));
      });
    }
    out.push({ page, file, marks: rects.length });
  }
  return out;
}

// Plan the text edits: which lines on which pages mention another brand.
export async function planTextEdits(srcPdf, pages, workDir) {
  fs.copyFileSync(srcPdf, path.join(workDir, 'src.pdf'));
  const steps = [{ tool: 'doc_open', args: { path: 'src.pdf' } }, ...pages.map((page) => ({ tool: 'text_lines', args: { doc: 1, page } }))];
  const results = await runSteps(workDir, steps);
  const edits = [];
  const manual = [];
  pages.forEach((page, i) => {
    for (const l of results[i + 1].lines || []) {
      const cleaned = l.text.replace(PLACEHOLDER, '').replace(/\s{2,}/g, ' ').trim();
      const placeholder = cleaned !== l.text.replace(/\s{2,}/g, ' ').trim();
      const next = placeholder ? (replaceBrands(cleaned) || ' ') : replaceBrands(l.text);
      if (next === l.text && !FOREIGN_ADDRESS.test(l.text)) continue;
      if (FOREIGN_ADDRESS.test(l.text)) {
        const addr = replaceAddress(l.text);
        if (addr && addr.trim() === l.text.trim()) continue;
        if (addr) edits.push({ page, line: l.line, from: l.text.trim(), to: addr, rect: l.rect, kind: 'address' });
        else manual.push({ page, line: l.line, text: l.text.trim().slice(0, 160), rect: l.rect });
        continue;
      }
      edits.push({ page, line: l.line, from: l.text.trim(), to: next.trim() || ' ', rect: l.rect, kind: placeholder ? 'placeholder' : 'brand' });
    }
  });
  return { edits, manual };
}

// Applies text edits and logo patches to a copy and saves it to outPdf.
// logos: [{ page, rect: [x0,y0,x1,y1] in points from the top-left, what }]
export async function applyFix(srcPdf, outPdf, { edits, logos }, workDir) {
  fs.copyFileSync(srcPdf, path.join(workDir, 'src.pdf'));
  const steps = [{ tool: 'doc_open', args: { path: 'src.pdf' } }];
  // Edit lines of one page from the bottom up so line numbers stay valid.
  for (const e of [...edits].sort((a, b) => a.page - b.page || b.line - a.line)) steps.push({ tool: 'text_edit', args: { doc: 1, page: e.page, line: e.line, text: e.to } });
  const patched = []; const refused = [];
  for (const [i, logo] of (logos || []).entries()) {
    const pagePng = path.join(workDir, `page-${logo.page}.png`);
    if (!fs.existsSync(pagePng)) await run(['render', path.join(workDir, 'src.pdf'), '--page', String(logo.page), '--dpi', '100', '--out', pagePng]);
    const patch = path.join(workDir, `patch-${i}.png`);
    let bg; let tight; let used;
    try { ({ bg, rect: tight, logo: used } = JSON.parse(await py([pagePng, '100', ...logo.rect.map(String), LOGO_LIGHT, LOGO_DARK, patch, LOGO_GRAY]))); } catch (e) { refused.push({ page: logo.page, what: logo.what, why: /blank/.test(e.message) ? 'ตำแหน่งที่กะไว้เป็นพื้นว่าง (กะพลาด)' : e.message }); continue; }
    patched.push({ ...logo, rect: tight, bg, logo: used });
    steps.push({ tool: 'page_add_image', args: { doc: 1, page: logo.page, path: path.basename(patch), rect: tight } });
  }
  // PDFCraft only writes inside its --root, so save there and move it out.
  steps.push({ tool: 'doc_save', args: { doc: 1, path: 'fixed.pdf', full: true } });
  await runSteps(workDir, steps);
  fs.mkdirSync(path.dirname(outPdf), { recursive: true });
  fs.copyFileSync(path.join(workDir, 'fixed.pdf'), outPdf);
  return { patched, refused };
}

export async function pageCount(file) {
  return Number(JSON.parse(await run(['info', file], { timeout: 60000 })).pages) || 0;
}

export const pdfTextOf = (file) => run(['text', file], { timeout: 120000 });

// Before / after pictures of every edited spot, for her to check by eye.
export async function proofs(beforePdf, afterPdf, spots, outDir, prefix) {
  fs.mkdirSync(outDir, { recursive: true });
  const out = [];
  const pages = [...new Set(spots.map((s) => s.page))];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-'));
  try {
    for (const page of pages) {
      await run(['render', beforePdf, '--page', String(page), '--dpi', '100', '--out', path.join(dir, `b${page}.png`)]);
      await run(['render', afterPdf, '--page', String(page), '--dpi', '100', '--out', path.join(dir, `a${page}.png`)]);
    }
    for (const [i, s] of spots.slice(0, 12).entries()) {
      const b = path.join(outDir, `${prefix}-${i}-before.png`);
      const a = path.join(outDir, `${prefix}-${i}-after.png`);
      await crop(path.join(dir, `b${s.page}.png`), 100, s.rect, b);
      await crop(path.join(dir, `a${s.page}.png`), 100, s.rect, a);
      out.push({ page: s.page, label: s.label, before: b, after: a });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return out;
}
