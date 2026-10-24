// Campaign prep checklist for the Ads page. Everything that can be measured is
// read live (website products, graphic cards, video cards); only the two cover
// images are ticked by hand. Campaigns and ticks live in AgentSetting rows so
// no schema change is needed.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { staleCatalogs, loadPdf } from './catalogSync.js';

const UPLOAD_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'uploads', 'campaigns');

const LIST_KEY = '__campaign_list';
const manualKey = (id) => `__campaign_manual_${id}`;
// The ready-to-paste launch plan for a campaign (names, settings, UTM links).
// Naming follows the earlier ads: utm_campaign = the Ads Manager campaign name,
// utm_source=facebook, utm_medium=paid, utm_content = romanized Thai in snake_case.
const SITE = 'https://www.tasaki.co.th';
const solarPlan = () => {
  const campaignName = 'SolarHybrid_Leads_Oct26';
  const ad = (adSet, name, utmContent, productId) => {
    const landing = `${SITE}/products/11/${productId}`;
    const urlParams = `utm_source=facebook&utm_medium=paid&utm_campaign=${campaignName}&utm_content=${utmContent}`;
    return { adSet, name, utmContent, landing, urlParams, fullUrl: `${landing}?${urlParams}` };
  };
  return {
    campaign: {
      name: campaignName,
      objective: 'Leads (Lead)',
      budget: 'ปิด Advantage campaign budget (CBO) · ตั้งงบรายวันที่ชุดโฆษณา เท่ากันทุกชุด',
    },
    adSetSettings: [
      { label: 'พื้นที่', value: 'Thailand (ทั้งประเทศ) · ผู้ที่อาศัยหรืออยู่ในพื้นที่นี้' },
      { label: 'อายุ / เพศ / ภาษา', value: '28–55 ปี · ทุกเพศ · ไทย' },
      { label: 'Detailed targeting (ใส่เบาๆ)', value: 'Small business owners, Entrepreneurship' },
      { label: 'Placements', value: 'Facebook Feed, Instagram Feed, Instagram Stories, Instagram Reels' },
      { label: 'ภาพที่ใช้', value: '4:5 สำหรับ Feed · 9:16 สำหรับ Stories/Reels' },
      { label: 'ช่วงทดสอบ', value: 'ยิง 3–5 วัน แล้วตัดสินใจย้ายงบเอง' },
    ],
    adSets: [{ name: 'Cafe_TH' }, { name: 'Barber_TH' }, { name: 'Restaurant_TH' }],
    ads: [
      ad('Cafe_TH', 'SolarHybrid_Cafe_ค่าไฟหารครึ่ง', 'cafe_kha_fai_harn_khrueng', 'cmqeq6lhb00159mqs7q6yz5ii'),
      ad('Barber_TH', 'SolarHybrid_Barber_แอร์ติดผนัง', 'barber_wall_unit', 'cmqeq6lhb00159mqs7q6yz5ii'),
      ad('Restaurant_TH', 'SolarHybrid_Restaurant_ฝังฝ้า4ทิศ', 'restaurant_cassette', 'cmqeq6m9t00199mqsrcv72djv'),
    ],
  };
};
const SEED = [{ id: 'solar-hybrid', name: 'Solar Hybrid', keywords: ['solar hybrid', 'โซลาร์ไฮบริด', 'โซล่าไฮบริด'], audience: 'ผู้ประกอบการ / นักธุรกิจ', exclude: [], plan: solarPlan() }];
const LIST_KEY_SEED = new Map(SEED.map((c) => [c.id, c]));

// What each campaign needs. min/max are her targets; manual items are ticked by hand.
const TARGETS = { adImages: { min: 3, max: 5 }, videos: { min: 1, max: 3 } };
const MANUAL_ITEMS = [
  { key: 'fbCover', title: 'ภาพ Cover Facebook (หน้าเพจ)' },
  { key: 'webHero', title: 'ภาพหน้าแรกของ Website (แบนเนอร์)' },
];
// Ticked by hand like the covers, but shown as its own step: who the ads are aimed at.
const AUDIENCE_KEY = 'audience';
const MANUAL_KEYS = [...MANUAL_ITEMS.map((m) => m.key), AUDIENCE_KEY];

const json = (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } };
const readSetting = async (prisma, key) => (await prisma.agentSetting.findUnique({ where: { agent: key } }))?.rules;
const writeSetting = (prisma, key, value) => prisma.agentSetting.upsert({ where: { agent: key }, create: { agent: key, rules: JSON.stringify(value) }, update: { rules: JSON.stringify(value) } });

export async function listCampaigns(prisma) {
  const stored = json(await readSetting(prisma, LIST_KEY), null);
  const list = Array.isArray(stored) && stored.length ? stored : SEED;
  // A seeded campaign keeps its ready-made plan even if the saved copy predates it.
  return list.map((c) => (c.plan || !LIST_KEY_SEED.has(c.id) ? c : { ...c, plan: LIST_KEY_SEED.get(c.id).plan }));
}

const matcher = (keywords) => {
  const ks = keywords.map((k) => k.toLowerCase());
  return (...fields) => { const t = fields.filter(Boolean).join(' ').toLowerCase(); return ks.some((k) => t.includes(k)); };
};

// A catalog whose text is all outlines can't be read or searched; cached an hour.
const textCache = new Map();
async function catalogReadable(url) {
  const hit = textCache.get(url);
  if (hit && Date.now() - hit.at < 3600 * 1000) return hit.ok;
  let ok = null;
  try { ok = (await loadPdf(url)).text.replace(/\s/g, '').length >= 200; } catch { ok = null; }
  textCache.set(url, { ok, at: Date.now() });
  return ok;
}

async function webStep(pool, isMatch) {
  const { rows } = await pool.query(`select id, model, "nameTh", "nameEn", "imageUrl", "manualUrl", "specSyncedAt", "specSyncNotNeeded", "featureStory", "catalogContent" from "Product" where "deletedAt" is null and hidden = false order by model`);
  const products = rows.filter((p) => isMatch(p.model, p.nameEn, p.nameTh));
  const stale = new Set((await staleCatalogs(pool)).flatMap((g) => g.products.map((p) => p.id)));
  const out = [];
  for (const p of products) {
    const readable = p.manualUrl ? await catalogReadable(p.manualUrl) : false;
    const features = Array.isArray(p.featureStory?.features) ? p.featureStory.features.length : 0;
    const cc = p.catalogContent || {};
    const checks = [
      { key: 'image', label: 'รูปสินค้า', ok: Boolean(p.imageUrl) },
      { key: 'catalog', label: 'มีไฟล์ Catalog', ok: Boolean(p.manualUrl) },
      { key: 'readable', label: 'Catalog อ่านข้อความได้', ok: readable === true, unknown: readable === null },
      { key: 'specs', label: 'สเปกตรงกับ Catalog แล้ว', ok: Boolean(p.manualUrl) && (p.specSyncNotNeeded || (p.specSyncedAt && !stale.has(p.id))) },
      { key: 'catalogContent', label: 'จุดเด่น/อุปกรณ์มาตรฐานใน Catalog', ok: Array.isArray(cc.coverBullets) && cc.coverBullets.length > 0 && Array.isArray(cc.standardFanCoil) && cc.standardFanCoil.length > 0 },
      { key: 'features', label: `ฟีเจอร์ (Feature) บนหน้าเว็บ${features ? ` ${features} ข้อ` : ''}`, ok: features > 0 },
    ];
    out.push({ id: p.id, model: p.model, name: p.nameTh, checks, ready: checks.every((c) => c.ok) });
  }
  return { products: out, done: out.length > 0 && out.every((p) => p.ready), total: out.length, readyCount: out.filter((p) => p.ready).length };
}

// The card's description names the folder the exports were saved in
// ("ไฟล์: public/uploads/agent-images/<job>/export/"); pick the three sizes out of it.
const EXPORT_DIR = /public\/(uploads\/agent-images\/[\w./-]+?\/export)\//;
function exportSizes(description) {
  const rel = EXPORT_DIR.exec(description || '')?.[1];
  if (!rel || rel.includes('..')) return null;
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
  let files = [];
  try { files = fs.readdirSync(path.join(root, rel)); } catch { return null; }
  const pick = (re) => { const f = files.find((x) => re.test(x) && /\.(png|jpe?g|webp)$/i.test(x)); return f ? `/${rel}/${encodeURIComponent(f)}` : null; };
  const sizes = { r916: pick(/9x16|9-16|9_16/i), r45: pick(/4x5|4-5|4_5/i), r11: pick(/1x1|1-1|1_1/i) };
  return sizes.r916 || sizes.r45 || sizes.r11 ? sizes : null;
}

async function adImageStep(prisma, isMatch, exclude = []) {
  const cards = await prisma.graphicDesignCard.findMany({ orderBy: { updatedAt: 'desc' } });
  const mine = cards.filter((c) => !exclude.includes(c.id) && c.usage.some((u) => u === 'facebook_ads' || u === 'instagram_ads') && isMatch(c.title, c.description));
  const ready = mine.filter((c) => c.column === 'done');
  return {
    items: mine.map((c) => ({ id: c.id, title: c.title, column: c.column, imageUrl: c.imageUrl || null, sizes: exportSizes(c.description), brief: (c.description.match(/จุดขายที่ภาพต้องพิสูจน์:\s*([^\n]+)/)?.[1] || c.description.split('\n').find((l) => l && !l.startsWith('แคมเปญ')) || '').slice(0, 160), ready: c.column === 'done' })),
    ready: ready.length, ...TARGETS.adImages, done: ready.length >= TARGETS.adImages.min,
  };
}

async function videoStep(prisma, isMatch, exclude = []) {
  const cards = await prisma.card.findMany({ where: { status: { not: 'rejected' } }, orderBy: { updatedAt: 'desc' }, select: { id: true, title: true, description: true, caption: true, tags: true, column: true, status: true, imageUrl: true, videoUrl: true, linkedVideoId: true } });
  const mine = cards.filter((c) => !exclude.includes(c.id) && isMatch(c.title, c.description, c.caption, ...(c.tags || [])));
  const ready = mine.filter((c) => c.column !== 'idea');
  const posts = mine.some((c) => c.linkedVideoId) ? await prisma.pageVideoInsight.findMany({ where: { videoId: { in: mine.map((c) => c.linkedVideoId).filter(Boolean) } }, select: { videoId: true, permalinkUrl: true, postViews: true, views: true } }) : [];
  const post = (id) => posts.find((x) => x.videoId === id);
  return {
    items: mine.map((c) => ({ id: c.id, title: c.title, column: c.column, imageUrl: c.imageUrl || null, videoUrl: c.videoUrl || null, postUrl: post(c.linkedVideoId)?.permalinkUrl || null, views: post(c.linkedVideoId)?.views ?? null, ready: c.column !== 'idea' })),
    ready: ready.length, ...TARGETS.videos, done: ready.length >= TARGETS.videos.min,
  };
}

export async function campaignStatus(prisma, pool, id) {
  const campaign = (await listCampaigns(prisma)).find((c) => c.id === id);
  if (!campaign) return null;
  const isMatch = matcher(campaign.keywords);
  const manual = json(await readSetting(prisma, manualKey(id)), {});
  const [web, adImages, videos] = await Promise.all([webStep(pool, isMatch), adImageStep(prisma, isMatch, campaign.exclude || []), videoStep(prisma, isMatch, campaign.exclude || [])]);
  const covers = MANUAL_ITEMS.map((m) => ({ ...m, done: Boolean(manual[m.key]?.done), note: manual[m.key]?.note || '', image: manual[m.key]?.image || null }));
  const coversDone = covers.every((c) => c.done);
  const aud = { who: campaign.audience || '', done: Boolean(manual[AUDIENCE_KEY]?.done), note: manual[AUDIENCE_KEY]?.note || '' };
  const audienceDone = aud.done && Boolean(aud.who);
  const steps = [audienceDone, web.done, adImages.done, videos.done, coversDone];
  const missing = [];
  if (!web.done) missing.push(web.total ? `เว็บ/Catalog: ผ่านครบ ${web.readyCount} จาก ${web.total} รุ่น` : 'ยังไม่พบสินค้าของแคมเปญนี้บนเว็บ');
  if (!adImages.done) missing.push(`ภาพแอด: พร้อม ${adImages.ready} จากอย่างน้อย ${adImages.min} ภาพ`);
  if (!videos.done) missing.push(`วิดีโอ: มี ${videos.ready} จากอย่างน้อย ${videos.min} ตัว`);
  if (!audienceDone) missing.push(aud.who ? 'กลุ่มเป้าหมาย: ยังไม่ได้สร้าง Audience ใน Ads Manager' : 'กลุ่มเป้าหมาย: ยังไม่ได้กำหนด');
  for (const c of covers.filter((x) => !x.done)) missing.push(c.title);
  return { campaign: { ...campaign, audience: campaign.audience || '', exclude: campaign.exclude || [] }, audience: aud, web, adImages, videos, covers, progress: { done: steps.filter(Boolean).length, total: steps.length, ready: steps.every(Boolean), missing } };
}

export function registerCampaigns(app, { prisma, tasakiWebPool }) {
  app.get('/api/campaigns', async (req, res) => {
    try { res.json({ campaigns: await listCampaigns(prisma) }); } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.get('/api/campaigns/:id', async (req, res) => {
    try {
      const status = await campaignStatus(prisma, tasakiWebPool, req.params.id);
      if (!status) return res.status(404).json({ error: 'ไม่พบแคมเปญ' });
      res.json(status);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  app.post('/api/campaigns', async (req, res) => {
    try {
      const name = String(req.body?.name || '').trim().slice(0, 60);
      const keywords = String(req.body?.keywords || name).split(',').map((k) => k.trim()).filter(Boolean).slice(0, 8);
      if (!name || !keywords.length) return res.status(400).json({ error: 'ใส่ชื่อแคมเปญ' });
      const list = await listCampaigns(prisma);
      const id = `${name.toLowerCase().replace(/[^a-z0-9ก-๙]+/g, '-').replace(/^-|-$/g, '') || 'campaign'}-${Date.now().toString(36)}`;
      const next = [...list, { id, name, keywords }];
      await writeSetting(prisma, LIST_KEY, next);
      res.json({ id, campaigns: next });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  // Audience note, and cards that don't fit this campaign (left out of the counts).
  app.put('/api/campaigns/:id', async (req, res) => {
    try {
      const list = await listCampaigns(prisma);
      const c = list.find((x) => x.id === req.params.id);
      if (!c) return res.status(404).json({ error: 'ไม่พบแคมเปญ' });
      if (typeof req.body?.audience === 'string') c.audience = req.body.audience.trim().slice(0, 120);
      const ex = new Set(c.exclude || []);
      if (typeof req.body?.excludeCard === 'string') ex.add(req.body.excludeCard);
      if (typeof req.body?.includeCard === 'string') ex.delete(req.body.includeCard);
      c.exclude = [...ex];
      await writeSetting(prisma, LIST_KEY, list);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  // Ticks the hand-checked items (the two cover images).
  app.put('/api/campaigns/:id/manual/:key', async (req, res) => {
    try {
      if (!MANUAL_KEYS.includes(req.params.key)) return res.status(400).json({ error: 'ไม่รู้จักรายการนี้' });
      const id = req.params.id;
      if (!(await listCampaigns(prisma)).some((c) => c.id === id)) return res.status(404).json({ error: 'ไม่พบแคมเปญ' });
      const manual = json(await readSetting(prisma, manualKey(id)), {});
      const prev = manual[req.params.key] || {};
      const sameAs = typeof req.body?.image === 'string' && req.body.image.startsWith('/uploads/campaigns/') && !req.body.image.includes('..') ? req.body.image : null;
      manual[req.params.key] = {
        ...prev,
        ...(sameAs ? { image: sameAs } : {}),
        done: req.body?.done === undefined ? Boolean(prev.done) : Boolean(req.body.done),
        note: req.body?.note === undefined ? prev.note || '' : String(req.body.note).slice(0, 1200),
      };
      await writeSetting(prisma, manualKey(id), manual);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
  // Drop a picture onto a cover slot so she can see how it will look.
  app.put('/api/campaigns/:id/manual/:key/image', async (req, res) => {
    try {
      if (!MANUAL_KEYS.includes(req.params.key)) return res.status(400).json({ error: 'ไม่รู้จักรายการนี้' });
      const id = req.params.id;
      if (!(await listCampaigns(prisma)).some((c) => c.id === id)) return res.status(404).json({ error: 'ไม่พบแคมเปญ' });
      const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body?.dataUrl || ''));
      if (!m) return res.status(400).json({ error: 'ต้องเป็นไฟล์ภาพ PNG, JPG หรือ WebP' });
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > 8 * 1024 * 1024) return res.status(400).json({ error: 'ไฟล์ใหญ่เกิน 8MB' });
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      const name = `${id.replace(/[^\w-]/g, '')}-${req.params.key}-${Date.now()}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
      fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
      const manual = json(await readSetting(prisma, manualKey(id)), {});
      manual[req.params.key] = { ...(manual[req.params.key] || {}), image: `/uploads/campaigns/${name}` };
      await writeSetting(prisma, manualKey(id), manual);
      res.json({ ok: true, image: manual[req.params.key].image });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}
