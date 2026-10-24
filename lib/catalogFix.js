// Puts the pieces of catalogBrandFix together for one catalog: save the PDF,
// fix the other brand's text/web (only edits that leave the picture
// unchanged), cover logos the agent saw with the Tasaki logo, check the
// result, and leave before/after pictures for her.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { savePdf, brandHits } from './catalogSync.js';
import { planTextEdits, applySafeTextEdits, stripHiddenBrands, applyFix, pageCount, pdfTextOf, proofs, scanMeta, scrubMeta, pagePreviews } from './catalogBrandFix.js';

const PT_PER_PX = 72 / 60; // the agent looks at 60 dpi page pictures

function pngSize(file) {
  try {
    const b = fs.readFileSync(file);
    return [b.readUInt32BE(16), b.readUInt32BE(20)];
  } catch { return null; }
}

// Turns what the agent saw (a box in picture pixels) into a box in PDF points,
// refusing boxes that are empty, off the page or too big to be a logo.
export function logoBoxes(visual, pageImages) {
  const boxes = [];
  const skipped = [];
  for (const v of visual || []) {
    const r = Array.isArray(v.rect) ? v.rect.map(Number) : [];
    const img = pageImages.find((f) => parseInt(path.basename(f).replace(/\D/g, ''), 10) === Number(v.page));
    const size = img && pngSize(img);
    if (r.length !== 4 || r.some((n) => !Number.isFinite(n)) || !size) { skipped.push({ page: v.page, what: v.what, why: 'กะตำแหน่งไม่ได้' }); continue; }
    const [x0, y0, x1, y1] = [Math.max(0, r[0]), Math.max(0, r[1]), Math.min(size[0], r[2]), Math.min(size[1], r[3])];
    const w = x1 - x0; const h = y1 - y0;
    if (w < 6 || h < 6) { skipped.push({ page: v.page, what: v.what, why: 'กรอบเล็กเกินไป' }); continue; }
    if ((w * h) / (size[0] * size[1]) > 0.08) { skipped.push({ page: v.page, what: v.what, why: 'กรอบใหญ่เกินกว่าจะเป็นโลโก้' }); continue; }
    boxes.push({ page: Number(v.page), what: v.what, rect: [x0, y0, x1, y1].map((n) => +(n * PT_PER_PX).toFixed(1)) });
  }
  return { boxes, skipped };
}

export async function fixCatalogBrands({ manualUrl, visual, pageImages, outDir, urlBase }) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-fix-'));
  try {
    const src = path.join(work, 'orig.pdf');
    await savePdf(manualUrl, src);
    const pages = await pageCount(src);
    const dirA = path.join(work, 'a'); const dirB = path.join(work, 'b');
    fs.mkdirSync(dirA); fs.mkdirSync(dirB); fs.mkdirSync(path.join(work, 'c'));
    const plan = await planTextEdits(src, Array.from({ length: pages }, (_, i) => i + 1), dirA);
    const { boxes, skipped: logoSkipped } = logoBoxes(visual, pageImages);
    const metaBefore = await scanMeta(src).catch(() => []);
    if (!plan.edits.length && !boxes.length && !metaBefore.length) return { nothing: true, manual: plan.manual, logoSkipped };

    const stage1 = path.join(work, 'stage1.pdf');
    const { kept, skipped } = await applySafeTextEdits(src, stage1, plan.edits, dirA);
    // Lines where another brand sits under someone's "Tasaki" label: drop just
    // those glyphs so the file no longer contains the name; the page must look
    // the same or the step is refused.
    let covered = null;
    let stage2 = stage1;
    if (skipped.length) {
      const dirC = path.join(work, 'c'); fs.mkdirSync(dirC, { recursive: true });
      const out = path.join(work, 'stage2.pdf');
      covered = await stripHiddenBrands(stage1, out, [...new Set(skipped.map((e) => e.page))], dirC);
      if (covered.applied) stage2 = out;
    }
    const stage3 = path.join(work, 'final.pdf');
    const final = stage3;
    const stage2b = path.join(work, 'stage2b.pdf');
    let patched = [];
    if (boxes.length) {
      const res = await applyFix(stage2, stage2b, { edits: [], logos: boxes }, dirB);
      patched = res.patched;
      logoSkipped.push(...res.refused);
    }
    const pre = !boxes.length || !patched.length ? stage2 : stage2b;
    // Last: brand names in metadata / editor data (needs no look, page unchanged).
    let meta = { replaced: 0, hitsAfter: [] };
    try { meta = await scrubMeta(pre, final); } catch { fs.copyFileSync(pre, final); }

    const afterText = await pdfTextOf(final);
    const remaining = brandHits(afterText);
    const checks = { pagesBefore: pages, pagesAfter: await pageCount(final) };
    if (checks.pagesBefore !== checks.pagesAfter) throw new Error('จำนวนหน้าเปลี่ยนหลังแก้ ยกเลิกไฟล์ที่แก้');

    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    const name = `${path.basename(manualUrl, '.pdf')}-tasaki.pdf`;
    fs.copyFileSync(final, path.join(outDir, name));
    const coverShots = covered?.applied ? await proofs(src, final, skipped.slice(0, 6).map((e) => ({ page: e.page, rect: e.rect, label: e.from })), outDir, 'cov') : [];
    const changedPages = [...new Set([...kept.map((e) => e.page), ...(covered?.applied ? Object.keys(covered.removed).map(Number) : []), ...patched.map((l) => l.page)])].sort((a, b) => a - b).slice(0, 6);
    const spots = [
      ...kept.map((e) => ({ page: e.page, rect: e.rect })),
      ...skipped.map((e) => ({ page: e.page, rect: e.rect })),
      ...patched.map((l) => ({ page: l.page, rect: l.rect })),
    ];
    const previews = await pagePreviews(final, changedPages.length ? changedPages : [1], outDir, 'prev', spots);
    const shots = await proofs(src, final, patched.map((b) => ({ page: b.page, rect: b.rect, label: b.what })), outDir, 'logo');
    return {
      file: `${urlBase}/${name}`, localFile: path.join(outDir, name),
      textKept: kept.filter((e) => e.kind === 'brand').map((e) => ({ page: e.page, from: e.from.slice(0, 120), to: e.to.slice(0, 120) })),
      placeholders: kept.filter((e) => e.kind === 'placeholder').map((e) => ({ page: e.page, from: e.from.slice(0, 120) })),
      textHidden: skipped.map((e) => ({ page: e.page, text: e.from.slice(0, 120) })),
      covered: covered?.applied ? Object.entries(covered.removed).map(([page, count]) => ({ page: Number(page), count })) : [],
      coveredShots: coverShots.map((c) => ({ page: c.page, from: c.label.slice(0, 100), before: `${urlBase}/${path.basename(c.before)}`, after: `${urlBase}/${path.basename(c.after)}` })),
      coveredFailed: covered && !covered.applied ? { pages: skipped.map((e) => e.page).filter((v, i, a) => a.indexOf(v) === i), why: covered.bad?.length ? 'ลบแล้วภาพเปลี่ยน (ชื่อแบรนด์เป็นตัวหนังสือที่มองเห็นอยู่จริง)' : 'ลบไม่ได้ (ฟอนต์ที่ไฟล์ใช้ไม่รองรับ)' } : null,
      previews: previews.map((p) => ({ page: p.page, marks: p.marks, url: `${urlBase}/${path.basename(p.file)}?v=${Date.now()}` })),
      metaCleaned: { replaced: meta.replaced, found: metaBefore, remaining: meta.hitsAfter },
      addresses: kept.filter((e) => e.kind === 'address').map((e) => ({ page: e.page, from: e.from.slice(0, 100), to: e.to.slice(0, 140) })),
      manual: plan.manual.map((m) => ({ page: m.page, text: m.text })),
      logos: patched.map((l, i) => ({ page: l.page, what: l.what, bg: l.bg, color: l.logo, before: `${urlBase}/${path.basename(shots[i]?.before || '')}`, after: `${urlBase}/${path.basename(shots[i]?.after || '')}` })),
      logoSkipped, remaining: remaining.map((h) => ({ term: h.term, count: h.count, pages: h.pages })), checks,
    };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
