// Per-product feature report for the Website Updates panel: each product's
// "why this model" section (Product.featureStory on the Tasaki website) with
// the time each feature card was last changed.
//
// The website keeps no per-feature history, so the dashboard keeps one: a
// snapshot of every feature (hash of its content) plus its Last Update. A sync
// compares the live stories with that snapshot; a changed card takes its time
// from the website's own record of the write (admin log when an admin saved
// it, else the product's updatedAt), never from when the sync happened to run.
// WEB syncs on each daily run; the panel syncs when it loads.
import crypto from 'node:crypto';

const KEY = '__feature_tracker';
const HERO = '__hero';

const hash = (v) => crypto.createHash('md5').update(JSON.stringify(v ?? null)).digest('hex');
const heroOf = (s) => ({ hero: s?.hero, heroTitleTh: s?.heroTitleTh, heroBodyTh: s?.heroBodyTh, heroTitleEn: s?.heroTitleEn, heroBodyEn: s?.heroBodyEn });

// One story → { featureId: { title, hash } }, the cover/headline as its own row.
export function storyCards(story) {
  const cards = {};
  if (!story) return cards;
  cards[HERO] = { title: 'ภาพปกและหัวเรื่อง', hash: hash(heroOf(story)) };
  (story.features || []).forEach((f, i) => {
    cards[f.id || `#${i}`] = { title: f.titleTh || f.titleEn || `จุดเด่นที่ ${i + 1}`, hash: hash(f), optional: !!f.optional };
  });
  return cards;
}

async function load(prisma) {
  const row = await prisma.agentSetting.findUnique({ where: { agent: KEY } });
  try { return row ? JSON.parse(row.rules || '{}') : null; } catch { return null; }
}
export async function saveTracker(prisma, state) {
  const rules = JSON.stringify(state);
  await prisma.agentSetting.upsert({ where: { agent: KEY }, create: { agent: KEY, rules }, update: { rules } });
}

async function liveProducts(webPool) {
  const { rows } = await webPool.query(`
    select p.id, p.model, p."nameTh", p."featureStory", p."updatedAt", t."nameTh" as type, t.id as "typeId"
    from "Product" p join "ProductType" t on t.id = p."typeId"
    where p."deletedAt" is null and p."featureStory" is not null`);
  return rows;
}

// Admin saves of a product's story since a time, newest first, with the
// before/after of the story so each card can be matched to its own save.
async function adminSaves(webPool, productId, since) {
  const { rows } = await webPool.query(`
    select "createdAt", changes from "AdminActionLog"
    where "entityType" = 'Product' and "entityId" = $1 and "createdAt" > $2 and changes::text like '%featureStory%'
    order by "createdAt" desc`, [productId, since]);
  return rows.map((r) => ({ at: r.createdAt, change: (r.changes || []).find((c) => c.field === 'featureStory') })).filter((r) => r.change);
}

// Compare the live stories with the snapshot; returns what changed.
export async function syncFeatures(prisma, webPool) {
  const state = (await load(prisma)) || { products: {}, syncedAt: null };
  const live = await liveProducts(webPool);
  const changes = [];
  const seen = new Set();
  let moved = false;
  for (const p of live) {
    seen.add(p.id);
    const cards = storyCards(p.featureStory);
    const prev = state.products[p.id];
    const entry = { model: p.model, type: p.type, typeId: p.typeId, features: {} };
    let saves = null;
    for (const [id, c] of Object.entries(cards)) {
      const old = prev?.features?.[id];
      if (old && old.hash === c.hash && !old.removed) { entry.features[id] = { ...old, title: c.title, optional: c.optional }; continue; }
      // New or changed card: the newest admin save whose "after" holds this
      // exact card, else the product's own last write.
      saves ??= await adminSaves(webPool, p.id, prev?.checkedAt || '1970-01-01');
      const viaAdmin = saves.find((s) => storyCards(s.change.after)[id]?.hash === c.hash && storyCards(s.change.before)[id]?.hash !== c.hash);
      const at = new Date(viaAdmin?.at || p.updatedAt).toISOString();
      entry.features[id] = { title: c.title, hash: c.hash, optional: c.optional, lastUpdate: at, added: !old };
      changes.push({ productId: p.id, model: p.model, type: p.type, feature: c.title, kind: old ? 'แก้' : 'เพิ่ม', at });
    }
    for (const [id, old] of Object.entries(prev?.features || {})) {
      if (cards[id] || old.removed) { if (old.removed) entry.features[id] = old; continue; }
      const at = new Date(p.updatedAt).toISOString();
      entry.features[id] = { ...old, removed: true, lastUpdate: at };
      changes.push({ productId: p.id, model: p.model, type: p.type, feature: old.title, kind: 'เอาออก', at });
    }
    entry.checkedAt = new Date(p.updatedAt).toISOString();
    if (entry.checkedAt !== prev?.checkedAt) moved = true;
    state.products[p.id] = entry;
  }
  let dropped = false;
  for (const id of Object.keys(state.products)) if (!seen.has(id)) { delete state.products[id]; dropped = true; }
  // Only write when something moved: the panel polls this every 30 s.
  if (changes.length || dropped || moved) {
    state.syncedAt = new Date().toISOString();
    await saveTracker(prisma, state);
  }
  return changes;
}

// Panel rows: one per product, its cards newest first.
export async function featureReport(prisma, webPool) {
  await syncFeatures(prisma, webPool);
  const state = await load(prisma);
  const products = Object.entries(state?.products || {}).map(([id, p]) => {
    const features = Object.entries(p.features).map(([fid, f]) => ({ id: fid, ...f }))
      .sort((a, b) => (b.lastUpdate || '').localeCompare(a.lastUpdate || ''));
    return { id, model: p.model, type: p.type, typeId: p.typeId, lastUpdate: features.map((f) => f.lastUpdate).filter(Boolean).sort().pop() || null, features };
  }).sort((a, b) => (b.lastUpdate || '').localeCompare(a.lastUpdate || '') || a.typeId - b.typeId || a.model.localeCompare(b.model));
  return { syncedAt: state?.syncedAt, backfillFrom: state?.backfillFrom || null, products };
}

// Feature cards changed inside a window (from the snapshot, no sync), for
// WEB's daily log: one row per product, its changed cards listed.
export async function featureChangesIn(prisma, since, until) {
  const state = await load(prisma);
  const from = new Date(since).getTime();
  const to = new Date(until).getTime();
  const out = [];
  for (const [id, p] of Object.entries(state?.products || {})) {
    const cards = Object.entries(p.features).filter(([, f]) => f.lastUpdate && new Date(f.lastUpdate).getTime() >= from && new Date(f.lastUpdate).getTime() <= to);
    if (!cards.length) continue;
    const times = [...new Set(cards.map(([, f]) => f.lastUpdate))].sort();
    out.push({
      productId: id, model: p.model, type: p.type, date: times[times.length - 1], times,
      cards: cards.map(([fid, f]) => ({ title: f.title, kind: f.removed ? 'เอาออก' : f.added ? 'เพิ่ม' : 'แก้' })),
      key: `feature:${id}:${cards.map(([fid, f]) => `${fid}@${f.lastUpdate}`).sort().join(',')}`,
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
