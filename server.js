import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import nodemailer from 'nodemailer';
import multer from 'multer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// tasaki-web keeps its own DB (same LAN Postgres server, different database).
// Read-only access to its PageView table powers the Website Updates page below.
// Prisma writes its `timestamp without time zone` columns (PageView.createdAt
// etc.) as UTC, but this Postgres server's session timezone is Asia/Bangkok
// and pg parses such values as local time — so both reads and range filters
// came out 7 hours early. Pin the session to UTC and read those columns as UTC.
const TIMESTAMP_OID = 1114;
const tasakiWebPool = new pg.Pool({
  connectionString: process.env.TASAKI_WEB_DATABASE_URL,
  options: '-c timezone=UTC',
  types: {
    getTypeParser: (oid, format) => (oid === TIMESTAMP_OID
      ? (value) => new Date(`${value.replace(' ', 'T')}Z`)
      : pg.types.getTypeParser(oid, format)),
  },
});
///// END /////
const COLUMNS = ['idea', 'clip', 'youtube', 'published'];
const GRAPHIC_COLUMNS = ['todo', 'in_progress', 'done'];
const GRAPHIC_USAGE = ['website', 'facebook_ads', 'instagram_ads', 'other'];
const CLIP_TAGS = ['factory', 'office', 'onsite', 'ai', 'archive', 'motion', 'knowledge', 'product', 'trend', 'branding'];
const PLATFORMS = ['facebook', 'instagram', 'tiktok', 'youtube'];
const TODO_STATUSES = ['plan', 'in_progress', 'done'];
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
const VIDEOS_DIR = path.join(UPLOADS_DIR, 'videos');
const TASAKI_WEB_URL = 'https://tasaki-web-cyan.vercel.app';
const IMAGE_MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const VIDEO_MIME_EXT = { 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm' };

try { fs.mkdirSync(UPLOADS_DIR, { recursive: true }); } catch {}
try { fs.mkdirSync(VIDEOS_DIR, { recursive: true }); } catch {}

const videoUpload = multer({
  storage: multer.diskStorage({
    destination: VIDEOS_DIR,
    filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}.${VIDEO_MIME_EXT[file.mimetype] || 'mp4'}`),
  }),
  fileFilter: (req, file, cb) => cb(null, Boolean(VIDEO_MIME_EXT[file.mimetype])),
  limits: { fileSize: 500 * 1024 * 1024 },
});

// ─── Read cache ──────────────────────────────────────────────────────────────
// The board is polled every few seconds by every open tab. Short-lived caching
// on the list endpoints means concurrent pollers within the same window share
// one Neon query instead of each re-running it, and writes invalidate
// immediately so nothing goes stale.
const READ_CACHE_TTL_MS = 2500;
const readCache = new Map();
async function cached(key, fn) {
  const hit = readCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.data;
  const data = await fn();
  readCache.set(key, { data, expires: Date.now() + READ_CACHE_TTL_MS });
  return data;
}
function invalidateCache(prefix) {
  for (const key of readCache.keys()) {
    if (key.startsWith(prefix)) readCache.delete(key);
  }
}

// ─── Planner sync ────────────────────────────────────────────────────────────
// Mirrors cards with a plan date or that have been published into Microsoft
// Planner via a Power Automate flow triggered by "When a new email arrives"
// (a standard, non-premium Outlook trigger). We mail the card as base64 JSON
// so the flow can decode + Parse JSON without HTML-mangling the payload.
const plannerMailer = process.env.SMTP_USER && process.env.SMTP_PASS
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.office365.com',
      port: Number(process.env.SMTP_PORT) || 587,
      secure: false,
      requireTLS: true,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    })
  : null;

function notifyPlanner(card) {
  if (!plannerMailer || !process.env.PLANNER_EMAIL_TO) return;
  const shouldSync = Boolean(card.plannedPublishDate) || Boolean(card.publishedAt) || Boolean(card.shootDate) || card.column === 'published';
  if (!shouldSync) return;
  const payload = {
    id: card.id,
    title: card.title,
    description: card.description,
    column: card.column,
    plannedPublishDate: card.plannedPublishDate || null,
    publishedAt: card.publishedAt || null,
    shootDate: card.shootDate || null,
    shootNote: card.shootNote || '',
  };
  plannerMailer.sendMail({
    from: process.env.SMTP_USER,
    to: process.env.PLANNER_EMAIL_TO,
    subject: 'PlannerSync',
    text: Buffer.from(JSON.stringify(payload)).toString('base64'),
  }).catch((e) => console.error('Planner sync email failed:', e.message));
}

// ─── Auto-post to Facebook/Instagram ────────────────────────────────────────
// Fires (fire-and-forget) when a card transitions into "published". Every
// published clip is a Reel posted to 3 destinations at once (confirmed
// 2026-08-24): Facebook Reel, Facebook Story, Instagram Reel. Off by default
// (AUTO_POST_ENABLED unset/false) — logs a "dry_run" attempt per destination
// instead of calling the real API, so the report can be previewed safely.
const AUTO_POST_ENABLED = process.env.AUTO_POST_ENABLED === 'true';
const GRAPH_VERSION = 'v26.0';
const AUTO_POST_DESTINATIONS = [
  { platform: 'instagram', placement: 'Reel' },
  { platform: 'facebook', placement: 'Reel' },
  { platform: 'facebook', placement: 'Story' },
];

async function logAutoPostAttempt(card, dest, status, extra = {}) {
  try {
    await prisma.autoPostLog.create({
      data: {
        cardId: card.id,
        cardTitle: card.title,
        platform: dest.platform,
        placement: dest.placement,
        status,
        postUrl: extra.postUrl || null,
        errorMessage: extra.errorMessage || null,
      },
    });
    invalidateCache('auto-post-log');
  } catch (e) { console.error('Failed to write auto-post log:', e.message); }
}

// Facebook's resumable upload protocol: start -> upload raw bytes -> finish.
// Reels and Stories use the same 3-phase shape on sibling endpoints.
// scheduledPublishTime (unix seconds, reel only) queues it in Facebook's own
// scheduler instead of publishing immediately — Meta requires it to be more
// than 10 minutes and no more than 29 days from now.
async function uploadFacebookReelOrStory(card, kind, scheduledPublishTime = null) {
  const pageId = process.env.FB_PAGE_ID;
  const token = process.env.FB_PAGE_ACCESS_TOKEN;
  const endpoint = kind === 'reel' ? 'video_reels' : 'video_stories';
  const fileBuffer = fs.readFileSync(path.join(__dirname, 'public', card.videoUrl));

  const startRes = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/${endpoint}?upload_phase=start&access_token=${token}`, { method: 'POST' });
  const startJson = await startRes.json();
  if (startJson.error) throw new Error(startJson.error.message);
  const { video_id, upload_url } = startJson;

  const uploadRes = await fetch(upload_url, {
    method: 'POST',
    headers: { Authorization: `OAuth ${token}`, offset: '0', file_size: String(fileBuffer.length) },
    body: fileBuffer,
  });
  const uploadJson = await uploadRes.json().catch(() => ({}));
  if (uploadJson.error) throw new Error(uploadJson.error.message);

  const finishParams = new URLSearchParams({ upload_phase: 'finish', video_id, access_token: token });
  if (kind === 'reel' && scheduledPublishTime) {
    finishParams.set('video_state', 'SCHEDULED');
    finishParams.set('scheduled_publish_time', String(scheduledPublishTime));
  } else {
    finishParams.set('video_state', 'PUBLISHED');
  }
  if (kind === 'reel' && card.caption) finishParams.set('description', card.caption);
  const finishRes = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/${endpoint}?${finishParams}`, { method: 'POST' });
  const finishJson = await finishRes.json();
  if (finishJson.error) throw new Error(finishJson.error.message);

  return { videoId: video_id, postUrl: kind === 'reel' ? `https://www.facebook.com/reel/${video_id}` : null };
}

async function postToFacebook(card) {
  if (!card.videoUrl) {
    // No video attached almost always means the card was posted by hand outside
    // the dashboard (see feedback 2026-08-28) rather than a real failure.
    for (const dest of AUTO_POST_DESTINATIONS) {
      await logAutoPostAttempt(card, dest, 'manual', { errorMessage: 'Nungning โพสเอง' });
    }
    return;
  }

  if (!AUTO_POST_ENABLED) {
    for (const dest of AUTO_POST_DESTINATIONS) {
      await logAutoPostAttempt(card, dest, 'dry_run');
    }
    return;
  }

  // Reels can be queued in Facebook's own scheduler (video_state=SCHEDULED) so we
  // upload right away but it only goes live at card.scheduledPublishAt. Facebook
  // Stories have no such scheduling support, so to still land together with the
  // Reel, the Story leg is deferred to postDueScheduledStories() below instead of
  // posting (or skipping) it now — scheduledPublishAt is left on the card so that
  // poll loop can find it once the time actually arrives.
  let scheduledPublishTime = null;
  if (card.scheduledPublishAt) {
    const ts = Math.floor(new Date(card.scheduledPublishAt).getTime() / 1000);
    const now = Math.floor(Date.now() / 1000);
    if (isNaN(ts) || ts < now + 11 * 60 || ts > now + 29 * 24 * 60 * 60) {
      const errorMessage = 'เวลาที่ตั้งไว้อยู่นอกช่วงที่ Facebook อนุญาตให้ตั้งเวลาล่วงหน้า (ต้องมากกว่า 10 นาที และไม่เกิน 29 วันจากตอนนี้) — ไม่ได้โพสอัตโนมัติ กรุณาโพสเองหรือแก้เวลาแล้วลองย้ายการ์ดใหม่';
      for (const dest of AUTO_POST_DESTINATIONS) {
        await logAutoPostAttempt(card, dest, 'failed', { errorMessage });
      }
      await prisma.card.update({ where: { id: card.id }, data: { scheduledPublishAt: null } }).catch(() => {});
      invalidateCache('cards');
      return;
    }
    scheduledPublishTime = ts;
  }

  try {
    const r = await uploadFacebookReelOrStory(card, 'reel', scheduledPublishTime);
    await logAutoPostAttempt(card, { platform: 'facebook', placement: 'Reel' }, scheduledPublishTime ? 'scheduled' : 'success', { postUrl: r.postUrl });
  } catch (e) {
    await logAutoPostAttempt(card, { platform: 'facebook', placement: 'Reel' }, 'failed', { errorMessage: e.message });
  }

  if (scheduledPublishTime) {
    await logAutoPostAttempt(card, { platform: 'facebook', placement: 'Story' }, 'scheduled', {});
  } else {
    try {
      await uploadFacebookReelOrStory(card, 'story');
      await logAutoPostAttempt(card, { platform: 'facebook', placement: 'Story' }, 'success', {});
    } catch (e) {
      await logAutoPostAttempt(card, { platform: 'facebook', placement: 'Story' }, 'failed', { errorMessage: e.message });
    }
  }

  // Instagram's Content Publishing API needs a `video_url` its own servers can
  // fetch over the public internet — our video lives at localhost/LAN only, so
  // this leg can't work until the video is reachable from outside (a tunnel or
  // a public storage URL). Logged honestly rather than attempted and failing
  // opaquely against the Graph API.
  await logAutoPostAttempt(card, { platform: 'instagram', placement: 'Reel' }, 'failed', {
    errorMessage: 'ยังโพสต์ Instagram อัตโนมัติไม่ได้ — ต้องมี URL วิดีโอที่เข้าถึงได้จากอินเทอร์เน็ต แต่วิดีโอตอนนี้เก็บอยู่ที่ localhost เท่านั้น',
  });
}

// Polls once a minute for published cards whose scheduledPublishAt has arrived —
// this is what actually posts the deferred Story leg from postToFacebook() above,
// so it lands alongside the Reel (already scheduled natively in Facebook) instead
// of hours/days early. Relies on this Node process being alive at that minute —
// same caveat as the insights-sync launchd jobs (not itself launchd/pm2-managed).
async function postDueScheduledStories() {
  if (!AUTO_POST_ENABLED) return;
  const nowIso = new Date().toISOString();
  const dueCards = await prisma.card.findMany({
    where: { column: 'published', scheduledPublishAt: { lte: nowIso }, videoUrl: { not: null } },
  });
  for (const card of dueCards) {
    // Clear first so a slow request can't get picked up twice by the next tick.
    await prisma.card.update({ where: { id: card.id }, data: { scheduledPublishAt: null } }).catch(() => {});
    invalidateCache('cards');
    try {
      await uploadFacebookReelOrStory(card, 'story');
      await logAutoPostAttempt(card, { platform: 'facebook', placement: 'Story' }, 'success', {});
    } catch (e) {
      await logAutoPostAttempt(card, { platform: 'facebook', placement: 'Story' }, 'failed', { errorMessage: e.message });
    }
  }
}
setInterval(() => postDueScheduledStories().catch((e) => console.error('postDueScheduledStories failed:', e.message)), 60 * 1000);

const app = express();
app.use(express.json({ limit: '15mb' }));

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (/\.(js|css|html)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

// ─── Cards ───────────────────────────────────────────────────────────────────
function serializeCard(c) {
  return {
    ...c,
    createdAt: c.createdAt?.toISOString?.() ?? c.createdAt,
    updatedAt: c.updatedAt?.toISOString?.() ?? c.updatedAt,
  };
}

// List responses are polled every few seconds. Selecting the imageUrl column (a
// large base64 @db.Text field) through the Neon driver adapter is drastically
// slower regardless of value size (~10s+ vs ~1.5s omitted), so list queries omit
// it entirely and use a lightweight id-only lookup to know which cards have one.
// Comment author avatars (also base64, embedded in the comments Json column) are
// swapped for small, cacheable URLs instead of re-sending the image bytes every poll.
async function cardIdsWithImage() {
  const rows = await prisma.$queryRaw`SELECT id FROM "Card" WHERE "imageUrl" IS NOT NULL`;
  return new Set(rows.map((r) => r.id));
}

function isBase64Image(v) {
  return typeof v === 'string' && /^data:[^;]+;base64,/.test(v);
}

// Comment avatars are resolved from the commenter's Team Profile at read time rather
// than storing a copy per comment, so there's nothing to go stale or get overwritten.
// profileNames is just which names currently have a picture, to decide whether the
// avatar URL is worth generating; isBase64Image(cm.authorImage) is a fallback for
// comments created before this (their image lives on the comment itself, not a Profile).
async function profileNamesWithImage() {
  const rows = await prisma.profile.findMany({ select: { name: true } });
  return new Set(rows.map((r) => r.name));
}

function serializeCardLite(c, hasImageIds, profileNames) {
  const card = serializeCard(c);
  card.imageUrl = hasImageIds.has(c.id) ? `/api/cards/${c.id}/image?t=${new Date(c.updatedAt).getTime()}` : null;
  card.comments = (Array.isArray(c.comments) ? c.comments : []).map((cm) => ({
    ...cm,
    authorImage: (profileNames.has(cm.authorName) || isBase64Image(cm.authorImage)) ? `/api/cards/${c.id}/comments/${cm.id}/image` : null,
  }));
  return card;
}

app.get('/api/cards', async (req, res) => {
  try {
    const cacheKey = `cards:${req.query.column || ''}`;
    const cards = await cached(cacheKey, async () => {
      const where = req.query.column ? { column: req.query.column } : {};
      const [rows, hasImageIds, profileNames] = await Promise.all([
        prisma.card.findMany({ where, orderBy: { order: 'asc' }, omit: { imageUrl: true } }),
        cardIdsWithImage(),
        profileNamesWithImage(),
      ]);
      const linkedVideoIds = rows.map((c) => c.linkedVideoId).filter(Boolean);
      const videoRows = linkedVideoIds.length
        ? await prisma.pageVideoInsight.findMany({ where: { videoId: { in: linkedVideoIds } } })
        : [];
      const videoByCardVideoId = new Map(videoRows.map((v) => [v.videoId, v]));
      return rows.map((c) => {
        const card = serializeCardLite(c, hasImageIds, profileNames);
        const v = c.linkedVideoId ? videoByCardVideoId.get(c.linkedVideoId) : null;
        card.videoStats = v ? { views: v.views, likes: v.likes, comments: v.comments, shares: v.shares, permalinkUrl: v.permalinkUrl } : null;
        return card;
      });
    });
    res.json({ cards });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/cards/:id/image', async (req, res) => {
  try {
    const card = await prisma.card.findUnique({ where: { id: req.params.id }, select: { imageUrl: true } });
    const match = card?.imageUrl ? /^data:([^;]+);base64,(.+)$/.exec(card.imageUrl) : null;
    if (!match) return res.status(404).end();
    res.setHeader('Content-Type', match[1]);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.end(Buffer.from(match[2], 'base64'));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/cards', async (req, res) => {
  const { title, description, column, shootDate, shootNote, caption } = req.body;
  if (!title || typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({ error: 'title is required' });
  }
  try {
    const card = await prisma.card.create({
      data: {
        id: crypto.randomUUID(),
        title: title.trim(),
        description: typeof description === 'string' ? description.trim() : '',
        column: COLUMNS.includes(column) ? column : 'idea',
        order: Date.now(),
        shootDate: shootDate || null,
        shootNote: typeof shootNote === 'string' ? shootNote.trim() : '',
        caption: typeof caption === 'string' ? caption.trim() : '',
      },
    });
    notifyPlanner(card);
    invalidateCache('cards');
    res.status(201).json(serializeCard(card));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/cards/reorder', async (req, res) => {
  const { column, order } = req.body;
  if (!COLUMNS.includes(column)) return res.status(400).json({ error: `column must be one of ${COLUMNS.join(', ')}` });
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array of card ids' });
  try {
    const now = new Date().toISOString();
    await Promise.all(order.map(async (id, index) => {
      const card = await prisma.card.findUnique({ where: { id }, select: { column: true } });
      if (!card) return;
      const data = { order: index, updatedAt: new Date() };
      let enteringPublished = false;
      if (card.column !== column) {
        data.column = column;
        if (column === 'published') {
          data.publishedAt = now;
          data.plannedPublishDate = null;
          enteringPublished = true;
        } else if (card.column === 'published') {
          data.publishedAt = null;
        }
      }
      const updated = await prisma.card.update({ where: { id }, data, omit: { imageUrl: true } });
      if (data.column) notifyPlanner(updated);
      if (enteringPublished) postToFacebook(updated).catch((e) => console.error('postToFacebook failed:', e.message));
    }));
    invalidateCache('cards');
    const [cards, hasImageIds, profileNames] = await Promise.all([
      prisma.card.findMany({ orderBy: { order: 'asc' }, omit: { imageUrl: true } }),
      cardIdsWithImage(),
      profileNamesWithImage(),
    ]);
    res.json({ cards: cards.map((c) => serializeCardLite(c, hasImageIds, profileNames)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/cards/:id/comments/:commentId/image', async (req, res) => {
  try {
    const card = await prisma.card.findUnique({ where: { id: req.params.id }, select: { comments: true } });
    const comments = Array.isArray(card?.comments) ? card.comments : [];
    const comment = comments.find((cm) => cm.id === req.params.commentId);
    if (!comment) return res.status(404).end();
    let source = null;
    if (comment.authorName) {
      const profile = await prisma.profile.findUnique({ where: { name: comment.authorName } });
      if (isBase64Image(profile?.imageUrl)) source = profile.imageUrl;
    }
    if (!source && isBase64Image(comment.authorImage)) source = comment.authorImage;
    const match = source ? /^data:([^;]+);base64,(.+)$/.exec(source) : null;
    if (!match) return res.status(404).end();
    res.setHeader('Content-Type', match[1]);
    // Not immutable anymore — it now follows the Profile, which can change.
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.end(Buffer.from(match[2], 'base64'));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/cards/:id/image', async (req, res) => {
  try {
    const card = await prisma.card.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!card) return res.status(404).json({ error: 'card not found' });
    const { image } = req.body;
    if (!image || !image.startsWith('data:image/')) return res.status(400).json({ error: 'invalid image data' });
    const updated = await prisma.card.update({ where: { id: req.params.id }, data: { imageUrl: image }, omit: { imageUrl: true } });
    invalidateCache('cards');
    res.json(serializeCard(updated));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/cards/:id/image', async (req, res) => {
  try {
    const card = await prisma.card.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!card) return res.status(404).json({ error: 'card not found' });
    const updated = await prisma.card.update({ where: { id: req.params.id }, data: { imageUrl: null }, omit: { imageUrl: true } });
    invalidateCache('cards');
    res.json(serializeCard(updated));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Video files live on local disk (public/uploads/videos/), not in Postgres —
// base64-in-DB doesn't scale to video file sizes the way it does for images.
app.post('/api/cards/:id/video', videoUpload.single('video'), async (req, res) => {
  try {
    const card = await prisma.card.findUnique({ where: { id: req.params.id }, select: { id: true, videoUrl: true } });
    if (!card) return res.status(404).json({ error: 'card not found' });
    if (!req.file) return res.status(400).json({ error: 'video file is required (field name "video", mp4/mov/webm)' });
    if (card.videoUrl) {
      const oldPath = path.join(__dirname, 'public', card.videoUrl);
      fs.unlink(oldPath, () => {});
    }
    const videoUrl = `/uploads/videos/${req.file.filename}`;
    const updated = await prisma.card.update({
      where: { id: req.params.id },
      data: { videoUrl, videoMimeType: req.file.mimetype },
      omit: { imageUrl: true },
    });
    invalidateCache('cards');
    res.json(serializeCard(updated));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/cards/:id/video', async (req, res) => {
  try {
    const card = await prisma.card.findUnique({ where: { id: req.params.id }, select: { id: true, videoUrl: true } });
    if (!card) return res.status(404).json({ error: 'card not found' });
    if (card.videoUrl) {
      const oldPath = path.join(__dirname, 'public', card.videoUrl);
      fs.unlink(oldPath, () => {});
    }
    const updated = await prisma.card.update({ where: { id: req.params.id }, data: { videoUrl: null, videoMimeType: null }, omit: { imageUrl: true } });
    invalidateCache('cards');
    res.json(serializeCard(updated));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Graphic Design board ─────────────────────────────────────────────────────
// Tracks progress of graphic assets (product cutouts, website banners, ad
// creatives) from draft to done — separate from the content Marketing Pipeline
// above, so it doesn't touch COLUMNS or trigger Facebook auto-posting.
function serializeGraphicCard(c) {
  return { ...serializeCard(c) };
}

async function graphicCardIdsWithImage() {
  const rows = await prisma.$queryRaw`SELECT id FROM "GraphicDesignCard" WHERE "imageUrl" IS NOT NULL`;
  return new Set(rows.map((r) => r.id));
}

app.get('/api/graphic-cards', async (req, res) => {
  try {
    const cacheKey = `graphic-cards:${req.query.column || ''}`;
    const cards = await cached(cacheKey, async () => {
      const where = req.query.column ? { column: req.query.column } : {};
      const [rows, hasImageIds] = await Promise.all([
        prisma.graphicDesignCard.findMany({ where, orderBy: { order: 'asc' }, omit: { imageUrl: true } }),
        graphicCardIdsWithImage(),
      ]);
      return rows.map((c) => {
        const card = serializeGraphicCard(c);
        card.imageUrl = hasImageIds.has(c.id) ? `/api/graphic-cards/${c.id}/image?t=${new Date(c.updatedAt).getTime()}` : null;
        return card;
      });
    });
    res.json({ cards });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/graphic-cards/:id/image', async (req, res) => {
  try {
    const card = await prisma.graphicDesignCard.findUnique({ where: { id: req.params.id }, select: { imageUrl: true } });
    const match = card?.imageUrl ? /^data:([^;]+);base64,(.+)$/.exec(card.imageUrl) : null;
    if (!match) return res.status(404).end();
    res.setHeader('Content-Type', match[1]);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.end(Buffer.from(match[2], 'base64'));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/graphic-cards', async (req, res) => {
  const { title, description, column, usage } = req.body;
  if (!title || typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({ error: 'title is required' });
  }
  try {
    const card = await prisma.graphicDesignCard.create({
      data: {
        id: crypto.randomUUID(),
        title: title.trim(),
        description: typeof description === 'string' ? description.trim() : '',
        column: GRAPHIC_COLUMNS.includes(column) ? column : 'todo',
        usage: Array.isArray(usage) ? usage.filter((u) => GRAPHIC_USAGE.includes(u)) : [],
        order: Date.now(),
      },
      omit: { imageUrl: true },
    });
    invalidateCache('graphic-cards');
    res.status(201).json(serializeGraphicCard(card));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/graphic-cards/:id', async (req, res) => {
  try {
    const existing = await prisma.graphicDesignCard.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!existing) return res.status(404).json({ error: 'card not found' });
    const data = {};
    if (typeof req.body.title === 'string' && req.body.title.trim()) data.title = req.body.title.trim();
    if (typeof req.body.description === 'string') data.description = req.body.description.trim();
    if (Array.isArray(req.body.usage)) data.usage = req.body.usage.filter((u) => GRAPHIC_USAGE.includes(u));
    if (GRAPHIC_COLUMNS.includes(req.body.column)) data.column = req.body.column;
    const updated = await prisma.graphicDesignCard.update({ where: { id: req.params.id }, data, omit: { imageUrl: true } });
    invalidateCache('graphic-cards');
    res.json(serializeGraphicCard(updated));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/graphic-cards/reorder', async (req, res) => {
  const { column, order } = req.body;
  if (!GRAPHIC_COLUMNS.includes(column)) return res.status(400).json({ error: `column must be one of ${GRAPHIC_COLUMNS.join(', ')}` });
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array of card ids' });
  try {
    await Promise.all(order.map((id, index) =>
      prisma.graphicDesignCard.update({ where: { id }, data: { column, order: index }, omit: { imageUrl: true } }).catch(() => null)
    ));
    invalidateCache('graphic-cards');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/graphic-cards/:id/image', async (req, res) => {
  try {
    const card = await prisma.graphicDesignCard.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!card) return res.status(404).json({ error: 'card not found' });
    const { image } = req.body;
    if (!image || !image.startsWith('data:image/')) return res.status(400).json({ error: 'invalid image data' });
    const updated = await prisma.graphicDesignCard.update({ where: { id: req.params.id }, data: { imageUrl: image }, omit: { imageUrl: true } });
    invalidateCache('graphic-cards');
    res.json(serializeGraphicCard(updated));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/graphic-cards/:id/image', async (req, res) => {
  try {
    const card = await prisma.graphicDesignCard.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!card) return res.status(404).json({ error: 'card not found' });
    const updated = await prisma.graphicDesignCard.update({ where: { id: req.params.id }, data: { imageUrl: null }, omit: { imageUrl: true } });
    invalidateCache('graphic-cards');
    res.json(serializeGraphicCard(updated));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/graphic-cards/:id/comments', async (req, res) => {
  try {
    const card = await prisma.graphicDesignCard.findUnique({ where: { id: req.params.id }, select: { comments: true } });
    if (!card) return res.status(404).json({ error: 'card not found' });
    const { text, authorName } = req.body;
    if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'text is required' });
    const comment = {
      id: crypto.randomUUID(),
      text: text.trim(),
      authorName: typeof authorName === 'string' && authorName.trim() ? authorName.trim() : 'Unknown',
      createdAt: new Date().toISOString(),
    };
    const comments = [...(Array.isArray(card.comments) ? card.comments : []), comment];
    const updated = await prisma.graphicDesignCard.update({ where: { id: req.params.id }, data: { comments }, omit: { imageUrl: true } });
    invalidateCache('graphic-cards');
    res.status(201).json(serializeGraphicCard(updated));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/graphic-cards/:id/comments/:commentId', async (req, res) => {
  try {
    const card = await prisma.graphicDesignCard.findUnique({ where: { id: req.params.id }, select: { comments: true } });
    if (!card) return res.status(404).json({ error: 'card not found' });
    const comments = (Array.isArray(card.comments) ? card.comments : []).filter((c) => c.id !== req.params.commentId);
    const updated = await prisma.graphicDesignCard.update({ where: { id: req.params.id }, data: { comments }, omit: { imageUrl: true } });
    invalidateCache('graphic-cards');
    res.json(serializeGraphicCard(updated));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/graphic-cards/:id', async (req, res) => {
  try {
    await prisma.graphicDesignCard.delete({ where: { id: req.params.id } });
    invalidateCache('graphic-cards');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/cards/:id', async (req, res) => {
  try {
    const card = await prisma.card.findUnique({ where: { id: req.params.id }, omit: { imageUrl: true } });
    if (!card) return res.status(404).json({ error: 'card not found' });

    const { title, description, column, status, rejectionReason, tags, platforms, todos, issues, comments, links, plannedPublishDate, scheduledPublishAt, publishedAt, shootDate, shootNote, caption, linkedVideoId, pinned } = req.body;
    const data = {};

    if (title !== undefined) {
      if (typeof title !== 'string' || !title.trim()) return res.status(400).json({ error: 'title must be a non-empty string' });
      data.title = title.trim();
    }
    if (description !== undefined) data.description = typeof description === 'string' ? description.trim() : '';
    if (tags !== undefined) {
      if (!Array.isArray(tags) || tags.some((t) => !CLIP_TAGS.includes(t))) return res.status(400).json({ error: `tags must be an array of: ${CLIP_TAGS.join(', ')}` });
      data.tags = [...new Set(tags)];
    }
    if (platforms !== undefined) {
      if (!Array.isArray(platforms) || platforms.some((p) => !PLATFORMS.includes(p))) return res.status(400).json({ error: `platforms must be an array of: ${PLATFORMS.join(', ')}` });
      data.platforms = [...new Set(platforms)];
    }
    if (todos !== undefined) {
      const valid = Array.isArray(todos) && todos.every((t) => t && typeof t.id === 'string' && typeof t.text === 'string' && t.text.trim() && TODO_STATUSES.includes(t.status));
      if (!valid) return res.status(400).json({ error: `todos must be an array of { id, text, status }` });
      data.todos = todos.map((t) => ({ id: t.id, text: t.text.trim(), status: t.status }));
    }
    if (issues !== undefined) {
      const valid = Array.isArray(issues) && issues.every((t) => t && typeof t.id === 'string' && typeof t.text === 'string' && t.text.trim());
      if (!valid) return res.status(400).json({ error: 'issues must be an array of { id, text, status? }' });
      data.issues = issues.map((t) => ({ id: t.id, text: t.text.trim(), status: t.status === 'solved' ? 'solved' : 'problem' }));
    }
    if (comments !== undefined) {
      const valid = Array.isArray(comments) && comments.every((c) => c && typeof c.id === 'string' && typeof c.text === 'string' && c.text.trim() && typeof c.authorName === 'string');
      if (!valid) return res.status(400).json({ error: 'comments must be an array of { id, text, authorName, authorImage, createdAt }' });
      // GET /api/cards replaces authorImage with a /image URL for list rendering — if that
      // gets echoed back here on an unrelated save, keep the stored image instead of
      // overwriting it with the URL string (a comment's real image lives only as base64).
      const existingComments = Array.isArray(card.comments) ? card.comments : [];
      data.comments = comments.map((c) => {
        const isRealImage = isBase64Image(c.authorImage);
        const existing = existingComments.find((e) => e.id === c.id);
        return { id: c.id, text: c.text.trim(), authorName: c.authorName.trim(), authorImage: isRealImage ? c.authorImage : (existing ? existing.authorImage : null), createdAt: c.createdAt || new Date().toISOString() };
      });
    }
    let enteringPublished = false;
    if (column !== undefined) {
      if (!COLUMNS.includes(column)) return res.status(400).json({ error: `column must be one of ${COLUMNS.join(', ')}` });
      if (column === 'published' && card.column !== 'published') {
        data.publishedAt = new Date().toISOString();
        data.plannedPublishDate = null;
        enteringPublished = true;
      } else if (column !== 'published' && card.column === 'published') {
        data.publishedAt = null;
      }
      data.column = column;
    }
    if (status !== undefined) {
      if (!['active', 'rejected'].includes(status)) return res.status(400).json({ error: 'status must be active or rejected' });
      if (status === 'rejected') {
        const reason = typeof rejectionReason === 'string' ? rejectionReason.trim() : '';
        if (!reason) return res.status(400).json({ error: 'rejectionReason is required when rejecting a card' });
        data.rejectionReason = reason;
      } else {
        data.rejectionReason = '';
      }
      data.status = status;
    }
    if (links !== undefined) {
      const valid = Array.isArray(links) && links.every((l) => l && typeof l.id === 'string' && typeof l.url === 'string' && l.url.trim());
      if (!valid) return res.status(400).json({ error: 'links must be an array of { id, label, url }' });
      data.links = links.map((l) => ({ id: l.id, label: typeof l.label === 'string' ? l.label.trim() : '', url: l.url.trim() }));
    }
    if (plannedPublishDate !== undefined) data.plannedPublishDate = plannedPublishDate || null;
    if (scheduledPublishAt !== undefined) {
      if (scheduledPublishAt !== null && isNaN(new Date(scheduledPublishAt).getTime())) return res.status(400).json({ error: 'scheduledPublishAt must be a valid date' });
      data.scheduledPublishAt = scheduledPublishAt || null;
    }
    if (publishedAt !== undefined) {
      if (publishedAt !== null && isNaN(new Date(publishedAt).getTime())) return res.status(400).json({ error: 'publishedAt must be a valid date' });
      data.publishedAt = publishedAt;
    }
    if (shootDate !== undefined) data.shootDate = shootDate || null;
    if (shootNote !== undefined) data.shootNote = typeof shootNote === 'string' ? shootNote.trim() : '';
    if (caption !== undefined) data.caption = typeof caption === 'string' ? caption.trim() : '';
    if (linkedVideoId !== undefined) data.linkedVideoId = linkedVideoId || null;
    if (pinned !== undefined) data.pinned = Boolean(pinned);

    const updated = await prisma.card.update({ where: { id: req.params.id }, data, omit: { imageUrl: true } });
    notifyPlanner(updated);
    invalidateCache('cards');
    if (enteringPublished) postToFacebook(updated).catch((e) => console.error('postToFacebook failed:', e.message));
    res.json(serializeCard(updated));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/cards/:id', async (req, res) => {
  try {
    const card = await prisma.card.findUnique({ where: { id: req.params.id }, omit: { imageUrl: true } });
    if (!card) return res.status(404).json({ error: 'card not found' });
    if (card.videoUrl) fs.unlink(path.join(__dirname, 'public', card.videoUrl), () => {});
    await prisma.card.delete({ where: { id: req.params.id } });
    invalidateCache('cards');
    res.json(serializeCard(card));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Key Messages ─────────────────────────────────────────────────────────────
app.get('/api/key-messages', async (req, res) => {
  try {
    const messages = await cached('key-messages', () => prisma.keyMessage.findMany());
    res.json({ messages });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/key-messages', async (req, res) => {
  const { text } = req.body;
  if (!text || typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'text is required' });
  try {
    const message = await prisma.keyMessage.create({ data: { id: crypto.randomUUID(), text: text.trim() } });
    invalidateCache('key-messages');
    res.status(201).json(message);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/key-messages/:id', async (req, res) => {
  const { text } = req.body;
  if (text !== undefined && (!typeof text === 'string' || !text.trim())) return res.status(400).json({ error: 'text must be a non-empty string' });
  try {
    const message = await prisma.keyMessage.update({ where: { id: req.params.id }, data: text ? { text: text.trim() } : {} });
    invalidateCache('key-messages');
    res.json(message);
  } catch { res.status(404).json({ error: 'message not found' }); }
});

app.delete('/api/key-messages/:id', async (req, res) => {
  try {
    const removed = await prisma.keyMessage.delete({ where: { id: req.params.id } });
    invalidateCache('key-messages');
    res.json(removed);
  } catch { res.status(404).json({ error: 'message not found' }); }
});

app.put('/api/key-messages/reorder', async (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array of message ids' });
  try {
    const messages = await prisma.keyMessage.findMany();
    const byId = new Map(messages.map((m) => [m.id, m]));
    const reordered = order.map((id) => byId.get(id)).filter(Boolean);
    if (reordered.length !== messages.length) return res.status(400).json({ error: 'order must include every existing message id exactly once' });
    res.json({ messages: reordered });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Website Changelog ─────────────────────────────────────────────────────
app.get('/api/website-changelog', async (req, res) => {
  try {
    const entries = await cached('website-changelog', async () => {
      const rows = await prisma.websiteChangelog.findMany({ orderBy: { date: 'desc' } });
      return rows.map((r) => ({ id: r.id, date: r.date, feature: r.text }));
    });
    res.json({ entries, siteUrl: TASAKI_WEB_URL });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/website-changelog', async (req, res) => {
  const { text, date } = req.body;
  if (!text || typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'text is required' });
  try {
    const row = await prisma.websiteChangelog.create({
      data: { text: text.trim(), ...(date ? { date: new Date(date) } : {}) },
    });
    invalidateCache('website-changelog');
    res.status(201).json({ id: row.id, date: row.date, feature: row.text });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/website-changelog/:id', async (req, res) => {
  const { text, date } = req.body;
  try {
    const row = await prisma.websiteChangelog.update({
      where: { id: req.params.id },
      data: {
        ...(text !== undefined ? { text: String(text).trim() } : {}),
        ...(date !== undefined ? { date: new Date(date) } : {}),
      },
    });
    invalidateCache('website-changelog');
    res.json({ id: row.id, date: row.date, feature: row.text });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Ad Action Log ──────────────────────────────────────────────────────────
// A short manual log of what's actually been done on the ad account (campaigns
// launched, Custom Audiences built, etc.) — separate from AdInsight (real
// spend/CTR numbers) since actions taken manually in Ads Manager aren't
// something the API sync can detect on its own. Meant to be skimmable by a
// manager, not a full audit trail.
app.get('/api/ad-action-log', async (req, res) => {
  try {
    const entries = await cached('ad-action-log', async () => {
      const rows = await prisma.adActionLog.findMany({ orderBy: { createdAt: 'desc' } });
      return rows.map((r) => ({ id: r.id, text: r.text, method: r.method, createdAt: r.createdAt }));
    });
    res.json({ entries });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/ad-action-log', async (req, res) => {
  const { text, method } = req.body;
  if (!text || typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'text is required' });
  try {
    const row = await prisma.adActionLog.create({
      data: { id: crypto.randomUUID(), text: text.trim(), method: typeof method === 'string' ? method.trim() : '' },
    });
    invalidateCache('ad-action-log');
    res.status(201).json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/ad-action-log/:id', async (req, res) => {
  try {
    await prisma.adActionLog.delete({ where: { id: req.params.id } });
    invalidateCache('ad-action-log');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Competitor Watch ("ส่องคู่แข่ง") ────────────────────────────────────────
// section: 'meta_ads' (active FB ad count per brand, verified via the
// Advertiser filter in Meta Ad Library — never trust plain keyword search,
// it pollutes badly for generic brand names) | 'ai_search' (whether the
// brand's site blocks AI crawlers in robots.txt).
app.get('/api/competitor-metrics', async (req, res) => {
  try {
    const section = typeof req.query.section === 'string' ? req.query.section : null;
    const entries = await cached(`competitor-metrics:${section || 'all'}`, async () => {
      const rows = await prisma.competitorMetric.findMany({
        where: section ? { section } : undefined,
        orderBy: { checkedAt: 'desc' },
      });
      return rows;
    });
    res.json({ entries });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Upserts by (section, brand) — each brand has one current value per section,
// re-checking just overwrites it (checkedAt bumps to now).
app.post('/api/competitor-metrics', async (req, res) => {
  const { section, brand, value, score, note, verified } = req.body;
  if (!section || !brand) return res.status(400).json({ error: 'section and brand are required' });
  try {
    const existing = await prisma.competitorMetric.findFirst({ where: { section, brand } });
    const data = {
      value: value != null ? String(value) : '',
      score: score != null && score !== '' ? Number(score) : null,
      note: note ? String(note) : '',
      verified: Boolean(verified),
      checkedAt: new Date(),
    };
    const row = existing
      ? await prisma.competitorMetric.update({ where: { id: existing.id }, data })
      : await prisma.competitorMetric.create({ data: { section: String(section), brand: String(brand), ...data } });
    invalidateCache('competitor-metrics');
    res.status(existing ? 200 : 201).json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/competitor-metrics/:id', async (req, res) => {
  try {
    await prisma.competitorMetric.delete({ where: { id: req.params.id } });
    invalidateCache('competitor-metrics');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/competitor-seo-notes', async (req, res) => {
  try {
    const entries = await cached('competitor-seo-notes', async () => {
      return prisma.competitorSeoNote.findMany({ orderBy: { createdAt: 'desc' } });
    });
    res.json({ entries });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/competitor-seo-notes', async (req, res) => {
  const { text } = req.body;
  if (!text || typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'text is required' });
  try {
    const row = await prisma.competitorSeoNote.create({ data: { text: text.trim() } });
    invalidateCache('competitor-seo-notes');
    res.status(201).json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/competitor-seo-notes/:id', async (req, res) => {
  try {
    await prisma.competitorSeoNote.delete({ where: { id: req.params.id } });
    invalidateCache('competitor-seo-notes');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── SEO keyword checklist (30 target keywords, checked by hand) ────────────
app.get('/api/seo-keywords', async (req, res) => {
  try {
    const entries = await cached('seo-keywords', async () => {
      return prisma.seoKeyword.findMany({ orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] });
    });
    res.json({ entries });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/seo-keywords', async (req, res) => {
  const { keyword, category, sortOrder } = req.body;
  if (!keyword || !String(keyword).trim()) return res.status(400).json({ error: 'keyword is required' });
  try {
    const row = await prisma.seoKeyword.create({
      data: { keyword: String(keyword).trim(), category: category ? String(category) : '', sortOrder: Number(sortOrder) || 0 },
    });
    invalidateCache('seo-keywords');
    res.status(201).json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/seo-keywords/:id', async (req, res) => {
  const { organic, ads, note, sortOrder } = req.body;
  try {
    const data = {};
    if (organic !== undefined) data.organic = Boolean(organic);
    if (ads !== undefined) data.ads = Boolean(ads);
    if (note !== undefined) data.note = String(note).trim();
    if (sortOrder !== undefined) data.sortOrder = Number(sortOrder) || 0;
    if (organic !== undefined || ads !== undefined || note !== undefined) data.checkedAt = new Date();
    const row = await prisma.seoKeyword.update({ where: { id: req.params.id }, data });
    invalidateCache('seo-keywords');
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/seo-keywords/:id', async (req, res) => {
  try {
    await prisma.seoKeyword.delete({ where: { id: req.params.id } });
    invalidateCache('seo-keywords');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Website Todo ("แผนเว็บไซต์เป็นอันดับ 1") ───────────────────────────────
app.get('/api/website-todos', async (req, res) => {
  try {
    const entries = await cached('website-todos', async () => {
      return prisma.websiteTodo.findMany({ orderBy: [{ phase: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }] });
    });
    res.json({ entries });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/website-todos', async (req, res) => {
  const { phase, text, sortOrder } = req.body;
  if (!phase || !text || !String(text).trim()) return res.status(400).json({ error: 'phase and text are required' });
  try {
    const row = await prisma.websiteTodo.create({
      data: { phase: String(phase), text: String(text).trim(), sortOrder: Number(sortOrder) || 0 },
    });
    invalidateCache('website-todos');
    res.status(201).json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/website-todos/:id', async (req, res) => {
  const { done, text, phase } = req.body;
  try {
    const data = {};
    if (done !== undefined) { data.done = Boolean(done); data.doneAt = done ? new Date() : null; }
    if (text !== undefined) data.text = String(text).trim();
    if (phase !== undefined) data.phase = String(phase).trim();
    const row = await prisma.websiteTodo.update({ where: { id: req.params.id }, data });
    invalidateCache('website-todos');
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/website-todos/:id', async (req, res) => {
  try {
    await prisma.websiteTodo.delete({ where: { id: req.params.id } });
    invalidateCache('website-todos');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Ad Insights ────────────────────────────────────────────────────────────
// Will be populated by scripts/sync-ad-insights.mjs pulling the Facebook
// Marketing Insights API on a daily launchd schedule, once Meta Business
// Manager access to the Tasaki ad account is granted.
app.get('/api/ad-insights', async (req, res) => {
  try {
    const data = await cached('ad-insights', async () => {
      const rows = await prisma.adInsight.findMany({ orderBy: { date: 'desc' } });
      const entries = rows.map((r) => ({
        id: r.id,
        date: r.date,
        campaignName: r.campaignName,
        spend: r.spend,
        reach: r.reach,
        impressions: r.impressions,
        clicks: r.clicks,
        ctr: r.ctr,
        cpc: r.cpc,
        targetAudience: r.targetAudience,
        creativeName: r.creativeName,
        creativeImageUrl: r.creativeImageUrl,
      }));
      const lastSyncedAt = rows.reduce((max, r) => (!max || r.updatedAt > max ? r.updatedAt : max), null);
      return { entries, lastSyncedAt };
    });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/ad-insights', async (req, res) => {
  const { date, adId, campaignName, spend, reach, impressions, clicks, ctr, cpc, targetAudience, creativeName, creativeImageUrl } = req.body;
  if (!date || !campaignName) return res.status(400).json({ error: 'date and campaignName are required' });
  try {
    const data = {
      date: new Date(date),
      adId: adId ? String(adId) : '',
      campaignName: String(campaignName),
      spend: Number(spend) || 0,
      reach: Number(reach) || 0,
      impressions: Number(impressions) || 0,
      clicks: Number(clicks) || 0,
      ctr: Number(ctr) || 0,
      cpc: Number(cpc) || 0,
      targetAudience: targetAudience ? String(targetAudience) : '',
      creativeName: creativeName ? String(creativeName) : '',
      ...(creativeImageUrl ? { creativeImageUrl: String(creativeImageUrl) } : {}),
    };
    // Re-syncing a day (overlapping ranges, a manual re-pull after the 8:15
    // job) must replace that day's row, not add a second one — duplicates
    // doubled the day's spend on the Ads page. Older rows have no adId, so
    // also match on the names.
    const existing = await prisma.adInsight.findFirst({
      where: {
        date: data.date,
        OR: [
          ...(data.adId ? [{ adId: data.adId }] : []),
          { campaignName: data.campaignName, targetAudience: data.targetAudience, creativeName: data.creativeName },
        ],
      },
      orderBy: { createdAt: 'desc' },
    });
    const row = existing
      ? await prisma.adInsight.update({ where: { id: existing.id }, data })
      : await prisma.adInsight.create({ data });
    invalidateCache('ad-insights');
    res.status(existing ? 200 : 201).json({ id: row.id, updated: Boolean(existing) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Website page views ─────────────────────────────────────────────────────
// tasaki-web tracks visitor page views itself (PageViewTracker.tsx -> PageView
// table in its own DB) but never had a viewer for that data. We read it
// straight from the LAN Postgres server rather than duplicating the tracker.
app.get('/api/website-pageviews', async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
  // Explicit calendar-day range (e.g. "วันนี้"/"เมื่อวาน" presets computed
  // client-side) overrides the rolling `days` window when both are given.
  const sinceParam = typeof req.query.since === 'string' ? new Date(req.query.since) : null;
  const untilParam = typeof req.query.until === 'string' ? new Date(req.query.until) : null;
  const hasRange = sinceParam && !isNaN(sinceParam) && untilParam && !isNaN(untilParam);
  const sinceDate = hasRange ? sinceParam : new Date(Date.now() - days * 86400000);
  const untilDate = hasRange ? untilParam : new Date();
  const cacheKey = hasRange ? `${sinceDate.toISOString()}:${untilDate.toISOString()}` : `days:${days}`;
  try {
    const data = await cached(`website-pageviews:${cacheKey}`, async () => {
      const range = [sinceDate, untilDate];
      const [totals, daily, topPages, devices, statusBreakdown, referrers, utmCampaigns, aiReferrals, aiBotHits] = await Promise.all([
        tasakiWebPool.query(`
          SELECT count(*)::int AS views, count(DISTINCT "sessionId")::int AS sessions
          FROM "PageView" WHERE "createdAt" >= $1 AND "createdAt" <= $2
        `, range),
        tasakiWebPool.query(`
          SELECT to_char("createdAt", 'YYYY-MM-DD') AS date, count(*)::int AS views, count(DISTINCT "sessionId")::int AS sessions
          FROM "PageView" WHERE "createdAt" >= $1 AND "createdAt" <= $2
          GROUP BY 1 ORDER BY 1
        `, range),
        tasakiWebPool.query(`
          SELECT path, count(*)::int AS views, count(DISTINCT "sessionId")::int AS sessions
          FROM "PageView" WHERE "createdAt" >= $1 AND "createdAt" <= $2
          GROUP BY path ORDER BY views DESC LIMIT 25
        `, range),
        tasakiWebPool.query(`
          SELECT device, count(*)::int AS views
          FROM "PageView" WHERE "createdAt" >= $1 AND "createdAt" <= $2
          GROUP BY device ORDER BY views DESC
        `, range),
        tasakiWebPool.query(`
          SELECT status, count(*)::int AS views
          FROM "PageView" WHERE "createdAt" >= $1 AND "createdAt" <= $2
          GROUP BY status ORDER BY views DESC
        `, range),
        tasakiWebPool.query(`
          SELECT referrer, count(*)::int AS views
          FROM "PageView" WHERE "createdAt" >= $1 AND "createdAt" <= $2
          GROUP BY referrer ORDER BY views DESC LIMIT 200
        `, range),
        tasakiWebPool.query(`
          SELECT "utmSource" AS source, "utmMedium" AS medium, "utmCampaign" AS campaign, "utmContent" AS content,
            count(*)::int AS views, count(DISTINCT "sessionId")::int AS sessions,
            min("createdAt") AS "firstSeen", max("createdAt") AS "lastSeen"
          FROM "PageView" WHERE "createdAt" >= $1 AND "createdAt" <= $2 AND "utmSource" != ''
          GROUP BY "utmSource", "utmMedium", "utmCampaign", "utmContent"
          ORDER BY views DESC
        `, range),
        // Referrer-domain based (not UTM-based) AI referral detection — most AI
        // engines besides ChatGPT don't tag outbound links with utm_source, so
        // this is the only way to see Gemini/Perplexity/Copilot/Claude clicks
        // at all. Bing is deliberately kept separate: its Copilot chat answers
        // share the same bing.com referrer as plain search, so a Bing hit can't
        // be attributed to AI vs. regular search.
        tasakiWebPool.query(`
          SELECT
            CASE
              WHEN referrer ILIKE '%chatgpt.com%' OR referrer ILIKE '%chat.openai.com%' THEN 'ChatGPT'
              WHEN referrer ILIKE '%perplexity.ai%' THEN 'Perplexity'
              WHEN referrer ILIKE '%gemini.google.com%' THEN 'Gemini'
              WHEN referrer ILIKE '%copilot.microsoft.com%' THEN 'Copilot'
              WHEN referrer ILIKE '%claude.ai%' THEN 'Claude'
              WHEN referrer ILIKE '%you.com%' THEN 'You.com'
              WHEN referrer ILIKE '%bing.com%' THEN 'Bing (ค้นหา+AI ปนกัน)'
            END AS source,
            count(*)::int AS views, count(DISTINCT "sessionId")::int AS sessions,
            min("createdAt") AS "firstSeen", max("createdAt") AS "lastSeen"
          FROM "PageView"
          WHERE "createdAt" >= $1 AND "createdAt" <= $2 AND (
            referrer ILIKE '%chatgpt.com%' OR referrer ILIKE '%chat.openai.com%' OR
            referrer ILIKE '%perplexity.ai%' OR referrer ILIKE '%gemini.google.com%' OR
            referrer ILIKE '%copilot.microsoft.com%' OR referrer ILIKE '%claude.ai%' OR
            referrer ILIKE '%you.com%' OR referrer ILIKE '%bing.com%'
          )
          GROUP BY source ORDER BY views DESC
        `, range),
        // Server-side AI crawler hits (GPTBot, ClaudeBot, PerplexityBot, etc.)
        // — logged by tasaki-web's proxy.ts on every request, separate from
        // PageView (which only fires from client-side JS that bots never run).
        // Table may not exist yet on older DB snapshots, so tolerate that.
        tasakiWebPool.query(`
          SELECT "botName", count(*)::int AS hits, count(DISTINCT path)::int AS paths,
            min("createdAt") AS "firstSeen", max("createdAt") AS "lastSeen"
          FROM "AiBotHit" WHERE "createdAt" >= $1 AND "createdAt" <= $2
          GROUP BY "botName" ORDER BY hits DESC
        `, range).catch((e) => (e.code === '42P01' ? { rows: [] } : Promise.reject(e))),
      ]);
      return {
        totals: totals.rows[0],
        daily: daily.rows,
        topPages: topPages.rows,
        devices: devices.rows,
        statusBreakdown: statusBreakdown.rows,
        referrers: referrers.rows,
        utmCampaigns: utmCampaigns.rows,
        aiReferrals: aiReferrals.rows,
        aiBotHits: aiBotHits.rows,
      };
    });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Page-by-page journey for one UTM row — lets "เข้าชม (หน้า) 13" resolve into
// the actual sequence a visitor took (หน้าแรก → สินค้า → ... ) grouped by
// session, instead of just a raw count.
// Paid-ad UTM rows only (utm_medium=paid, as set in each ad's URL
// parameters) for the Ads page — same shape as website-pageviews'
// utmCampaigns so both pages share public/utm-journey.js.

// ─── Website 404s: where they come from, and are they redirected yet ────────
// tasaki-web logs a 404 as a PageView with status 404. For the top paths we
// group the referrers (where the broken link was clicked) and ask the live
// site what the path does *now* — a 3xx means a redirect has since been
// added (lib/wixRedirects.ts, proxy.ts, or a product page's own redirect),
// so the count is history, not an open problem. Checked against www (the
// apex host only 308s to www, which would hide the real answer).
const LIVE_STATUS_TTL_MS = 10 * 60 * 1000;
const liveStatusCache = new Map();
async function liveStatus(path) {
  const hit = liveStatusCache.get(path);
  if (hit && hit.expires > Date.now()) return hit.data;
  let data;
  try {
    const r = await fetch(`https://www.tasaki.co.th${path}`, {
      redirect: 'manual',
      headers: { 'user-agent': 'TasakiMarketingDashboard/1.0 (404 check)' },
      signal: AbortSignal.timeout(8000),
    });
    data = { status: r.status, location: r.headers.get('location') || '' };
    // A redirect thrown from a Next.js page after streaming has started
    // (tasaki-web's deleted-product / missing-BTU redirects) arrives as a 200
    // carrying a meta refresh instead of a 3xx — report it as the redirect it is.
    if (r.status === 200) {
      const html = await r.text();
      const m = html.match(/id="__next-page-redirect"[^>]*content="\d+;url=([^"]+)"/);
      if (m) data = { status: 308, location: m[1], soft: true };
    } else {
      r.body?.cancel().catch(() => {});
    }
  } catch (e) {
    data = { status: 0, location: '', error: e.cause?.code || e.name };
  }
  liveStatusCache.set(path, { data, expires: Date.now() + LIVE_STATUS_TTL_MS });
  return data;
}

function referrerSource(referrer) {
  if (!referrer) return 'ไม่มี referrer (พิมพ์เอง/บุ๊กมาร์ก/แอป/บอต)';
  let url;
  try { url = new URL(referrer); } catch { return referrer.slice(0, 80); }
  const host = url.hostname.replace(/^www\./, '');
  if (host === 'tasaki.co.th') return `ลิงก์ในเว็บเอง: ${url.pathname}`;
  if (/(^|\.)google\./.test(host)) return 'Google';
  if (/facebook\.com$|fb\.com$|fb\.me$/.test(host)) return 'Facebook';
  if (/(^|\.)line\.me$/.test(host)) return 'LINE';
  if (/(^|\.)bing\.com$/.test(host)) return 'Bing';
  if (/chatgpt\.com$|openai\.com$/.test(host)) return 'ChatGPT';
  return host;
}

app.get('/api/website-404s', async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
  const sinceParam = typeof req.query.since === 'string' ? new Date(req.query.since) : null;
  const untilParam = typeof req.query.until === 'string' ? new Date(req.query.until) : null;
  const hasRange = sinceParam && !isNaN(sinceParam) && untilParam && !isNaN(untilParam);
  const range = hasRange ? [sinceParam, untilParam] : [new Date(Date.now() - days * 86400000), new Date()];
  try {
    const [{ rows: totals }, { rows: paths }] = await Promise.all([
      tasakiWebPool.query(`
        SELECT count(*)::int AS views, count(DISTINCT path)::int AS paths
        FROM "PageView" WHERE "createdAt" >= $1 AND "createdAt" <= $2 AND status = 404
      `, range),
      tasakiWebPool.query(`
        SELECT path, count(*)::int AS views, count(DISTINCT "sessionId")::int AS sessions, max("createdAt") AS "lastSeen"
        FROM "PageView" WHERE "createdAt" >= $1 AND "createdAt" <= $2 AND status = 404
        GROUP BY path ORDER BY views DESC, "lastSeen" DESC LIMIT 200
      `, range),
    ]);
    // Check a wider pool than the 50 we show: paths that now redirect (or open
    // fine) are dropped, and the still-broken ones further down move up.
    // A handful of checks at a time so a cold cache doesn't fire them all at once.
    const live = new Array(paths.length);
    for (let i = 0; i < paths.length; i += 6) {
      const batch = paths.slice(i, i + 6);
      const results = await Promise.all(batch.map((p) => (p.path.startsWith('/') ? liveStatus(p.path) : { status: 0, location: '' })));
      results.forEach((r, j) => { live[i + j] = r; });
    }
    const isFixed = (l) => l && ((l.status >= 300 && l.status < 400) || l.status === 200);
    const fixed = { paths: 0, views: 0 };
    const shown = [];
    paths.forEach((p, i) => {
      if (isFixed(live[i])) { fixed.paths++; fixed.views += p.views; return; }
      if (shown.length < 50) shown.push({ ...p, live: live[i] });
    });

    const { rows: refRows } = shown.length ? await tasakiWebPool.query(`
      SELECT path, referrer, count(*)::int AS views
      FROM "PageView" WHERE "createdAt" >= $1 AND "createdAt" <= $2 AND status = 404 AND path = ANY($3)
      GROUP BY path, referrer
    `, [...range, shown.map((p) => p.path)]) : { rows: [] };

    const sources = new Map();
    for (const r of refRows) {
      const bucket = sources.get(r.path) || new Map();
      const label = referrerSource(r.referrer);
      bucket.set(label, (bucket.get(label) || 0) + r.views);
      sources.set(r.path, bucket);
    }

    res.json({
      totals: totals[0],
      fixed,
      paths: shown.map((p) => ({
        ...p,
        sources: [...(sources.get(p.path) || new Map())].map(([label, views]) => ({ label, views })).sort((a, b) => b.views - a.views),
      })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/ad-utm-visits', async (req, res) => {
  const sinceParam = typeof req.query.since === 'string' ? new Date(req.query.since) : null;
  const untilParam = typeof req.query.until === 'string' ? new Date(req.query.until) : null;
  const since = sinceParam && !isNaN(sinceParam) ? sinceParam : new Date(Date.now() - 90 * 86400000);
  const until = untilParam && !isNaN(untilParam) ? untilParam : new Date();
  try {
    const { rows } = await tasakiWebPool.query(`
      SELECT "utmSource" AS source, "utmMedium" AS medium, "utmCampaign" AS campaign, "utmContent" AS content,
        count(*)::int AS views, count(DISTINCT "sessionId")::int AS sessions,
        min("createdAt") AS "firstSeen", max("createdAt") AS "lastSeen",
        -- Scroll depth only exists from 2026-09-29 16:17 on; 0 = not measured.
        count(DISTINCT "sessionId") FILTER (WHERE "maxScrollPct" > 0)::int AS "scrollTracked",
        round(avg("maxScrollPct") FILTER (WHERE "maxScrollPct" > 0))::int AS "avgScrollPct",
        count(DISTINCT "sessionId") FILTER (WHERE "dealerCtaSeen")::int AS "ctaSeen",
        count(DISTINCT "sessionId") FILTER (WHERE "dealerCtaClicked")::int AS "ctaClicked"
      FROM "PageView" WHERE "createdAt" >= $1 AND "createdAt" <= $2 AND "utmMedium" = 'paid'
      GROUP BY "utmSource", "utmMedium", "utmCampaign", "utmContent"
      ORDER BY max("createdAt") DESC
    `, [since, until]);
    // Every measured visitor's own furthest scroll, not just the average —
    // a few "didn't scroll at all" visitors and a few "read to the end" ones
    // average out to a middle number nobody actually scrolled to.
    const { rows: perVisitor } = await tasakiWebPool.query(`
      SELECT "utmSource" AS source, "utmMedium" AS medium, "utmCampaign" AS campaign, "utmContent" AS content,
        max("maxScrollPct")::int AS pct
      FROM "PageView" WHERE "createdAt" >= $1 AND "createdAt" <= $2 AND "utmMedium" = 'paid'
      GROUP BY "utmSource", "utmMedium", "utmCampaign", "utmContent", "sessionId"
      HAVING max("maxScrollPct") > 0
    `, [since, until]);
    const keyOf = (r) => [r.source, r.medium, r.campaign, r.content].join('\u0000');
    const lists = new Map();
    perVisitor.forEach((r) => {
      if (!lists.has(keyOf(r))) lists.set(keyOf(r), []);
      lists.get(keyOf(r)).push(r.pct);
    });
    rows.forEach((r) => { r.scrollList = (lists.get(keyOf(r)) || []).sort((a, b) => b - a); });
    res.json({ utmCampaigns: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Marketing funnel for one Facebook campaign: Meta's side (reach,
// engagement, link clicks) straight from the Graph API — reach is only
// correct when Meta de-duplicates it over the whole range, so it can't be
// summed from the daily AdInsight rows — joined to the website's own tracker
// for what happened after the click. The campaign's utm_campaign comes from
// its ads' URL tags (FB name "FWEEIAFM36_Leads_Sep26" ≠ utm "FWEEIAFM_Leads_Sep26").
const AD_FUNNEL_TTL_MS = 5 * 60 * 1000;
const adFunnelCache = new Map();
async function graphGet(pathAndQuery) {
  const sep = pathAndQuery.includes('?') ? '&' : '?';
  const r = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${pathAndQuery}${sep}access_token=${process.env.FB_USER_ACCESS_TOKEN}`);
  const json = await r.json();
  if (json.error) throw new Error(`Graph API: ${json.error.message}`);
  return json;
}
const actionValue = (row, type) => Number((row?.actions || []).find((a) => a.action_type === type)?.value || 0);
const bkkDate = (d) => new Date(d.getTime() + 7 * 3600e3).toISOString().slice(0, 10);

// Daily budget currently set on every running campaign, live from Meta.
// Budget sits on the campaign (Advantage campaign budget) or on each ad set,
// in satang. Only ACTIVE campaigns/ad sets count — a paused one spends nothing.
// Lifetime budgets have no per-day figure, so they're listed separately.
const AD_BUDGETS_TTL_MS = 60 * 1000;
let adBudgetsCache = null;
app.get('/api/ad-budgets', async (req, res) => {
  if (!process.env.FB_AD_ACCOUNT_ID || !process.env.FB_USER_ACCESS_TOKEN) {
    return res.status(503).json({ error: 'Missing FB_AD_ACCOUNT_ID or FB_USER_ACCESS_TOKEN' });
  }
  if (adBudgetsCache && adBudgetsCache.expires > Date.now() && req.query.fresh !== '1') return res.json(adBudgetsCache.data);
  try {
    const account = process.env.FB_AD_ACCOUNT_ID;
    const active = encodeURIComponent(JSON.stringify([{ field: 'effective_status', operator: 'IN', value: ['ACTIVE'] }]));
    const json = await graphGet(`${account}/campaigns?filtering=${active}&limit=100`
      + '&fields=name,daily_budget,lifetime_budget,adsets.limit(100){name,effective_status,daily_budget,lifetime_budget,ads.limit(100){effective_status}}');
    const baht = (v) => Number(v || 0) / 100;
    const campaigns = (json.data || []).map((c) => {
      const adsets = (c.adsets?.data || []).filter((a) => a.effective_status === 'ACTIVE');
      const adStatuses = adsets.flatMap((a) => (a.ads?.data || []).map((ad) => ad.effective_status));
      const campaignLevel = baht(c.daily_budget) > 0 || baht(c.lifetime_budget) > 0;
      const daily = campaignLevel ? baht(c.daily_budget) : adsets.reduce((sum, a) => sum + baht(a.daily_budget), 0);
      const lifetime = campaignLevel ? baht(c.lifetime_budget) : adsets.reduce((sum, a) => sum + baht(a.lifetime_budget), 0);
      return {
        name: c.name,
        daily,
        lifetime,
        adsets: adsets.length,
        // Running = at least one ad actually delivering; otherwise e.g. still in review.
        running: adStatuses.includes('ACTIVE'),
        pendingReview: adStatuses.some((st) => st === 'PENDING_REVIEW' || st === 'IN_PROCESS'),
      };
    }).filter((c) => c.adsets > 0 || c.daily > 0 || c.lifetime > 0);
    const data = { campaigns, totalDaily: campaigns.reduce((sum, c) => sum + c.daily, 0), fetchedAt: new Date().toISOString() };
    adBudgetsCache = { data, expires: Date.now() + AD_BUDGETS_TTL_MS };
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/ad-funnel', async (req, res) => {
  const { campaign } = req.query;
  const since = typeof req.query.since === 'string' ? req.query.since : '';
  const until = typeof req.query.until === 'string' ? req.query.until : '';
  if (!campaign || !/^\d{4}-\d{2}-\d{2}$/.test(since) || !/^\d{4}-\d{2}-\d{2}$/.test(until)) {
    return res.status(400).json({ error: 'campaign, since and until (YYYY-MM-DD) are required' });
  }
  if (!process.env.FB_AD_ACCOUNT_ID || !process.env.FB_USER_ACCESS_TOKEN) {
    return res.status(503).json({ error: 'Missing FB_AD_ACCOUNT_ID or FB_USER_ACCESS_TOKEN' });
  }
  const cacheKey = `${campaign}|${since}|${until}`;
  const hit = adFunnelCache.get(cacheKey);
  if (hit && hit.expires > Date.now()) return res.json(hit.data);
  try {
    const account = process.env.FB_AD_ACCOUNT_ID;
    const filtering = encodeURIComponent(JSON.stringify([{ field: 'campaign.name', operator: 'EQUAL', value: campaign }]));
    const timeRange = encodeURIComponent(JSON.stringify({ since, until }));
    const fields = 'reach,impressions,frequency,spend,inline_link_clicks,actions';
    const [total, daily, ads] = await Promise.all([
      graphGet(`${account}/insights?level=campaign&filtering=${filtering}&time_range=${timeRange}&fields=${fields}`),
      graphGet(`${account}/insights?level=campaign&filtering=${filtering}&time_range=${timeRange}&time_increment=1&fields=${fields}&limit=200`),
      graphGet(`${account}/ads?fields=campaign{name},creative{url_tags}&limit=200`),
    ]);
    const utmCampaigns = [...new Set((ads.data || [])
      .filter((a) => a.campaign?.name === campaign)
      .map((a) => new URLSearchParams(a.creative?.url_tags || '').get('utm_campaign'))
      .filter(Boolean))];

    // Bangkok-day range → UTC instants for the PageView filter.
    const sinceUtc = new Date(`${since}T00:00:00+07:00`);
    const untilUtc = new Date(`${until}T23:59:59.999+07:00`);
    const { rows: sessions } = utmCampaigns.length ? await tasakiWebPool.query(`
      SELECT "sessionId", min("createdAt") AS t0, count(*)::int AS views,
        max("maxScrollPct")::int AS scroll, bool_or("dealerCtaSeen") AS seen, bool_or("dealerCtaClicked") AS clicked
      FROM "PageView"
      WHERE "createdAt" >= $1 AND "createdAt" <= $2 AND "utmMedium" = 'paid' AND "utmCampaign" = ANY($3)
      GROUP BY "sessionId"
    `, [sinceUtc, untilUtc, utmCampaigns]) : { rows: [] };

    // Dealer contact taps (ClickEvent rows carry sessionId only since the
    // add_clickevent_session_id deploy, so earlier sessions can't match;
    // contactTrackingSince tells the page where the data starts). Before the
    // migration runs, the column doesn't exist (42703) → contacts = null.
    let contacts = null;
    let contactTrackingSince = null;
    try {
      const sessionIds = sessions.map((s) => s.sessionId).filter(Boolean);
      const [{ rows: clicks }, { rows: [start] }] = await Promise.all([
        sessionIds.length ? tasakiWebPool.query(`
          SELECT "sessionId",
            bool_or(label LIKE 'DealerContact:%') AS dealer,
            bool_or(label LIKE 'DealerContact:phone:%') AS phone,
            bool_or(label LIKE 'DealerContact:directions:%') AS directions,
            bool_or(label = 'FloatingContact:LINE') AS "floatingLine",
            bool_or(label = 'FloatingContact:Phone') AS "floatingPhone",
            bool_or(label = 'FloatingContact:Facebook') AS "floatingFacebook"
          FROM "ClickEvent"
          WHERE "sessionId" = ANY($1)
            AND (label LIKE 'DealerContact:%' OR label IN ('FloatingContact:LINE', 'FloatingContact:Phone', 'FloatingContact:Facebook'))
          GROUP BY "sessionId"
        `, [sessionIds]) : { rows: [] },
        tasakiWebPool.query(`SELECT min("createdAt") AS t FROM "ClickEvent" WHERE "sessionId" <> ''`),
      ]);
      contacts = new Map(clicks.map((c) => [c.sessionId, c]));
      contactTrackingSince = start?.t ? bkkDate(start.t) : null;
    } catch (e) {
      if (e.code !== '42703') throw e;
    }
    const contactCount = (key) => (contacts ? [...contacts.values()].filter((c) => c[key]).length : null);
    // Every row in `contacts` tapped at least one contact button (dealer
    // phone/directions or floating LINE/Phone/Facebook) — one person per session.
    const anyContact = (sessionId) => !!contacts?.get(sessionId);

    const t = total.data?.[0] || {};
    // Scroll depth / dealer button only exist from 2026-09-29 16:17 on (0 = not measured).
    const measured = sessions.filter((s) => s.scroll > 0);
    const site = {
      visitors: sessions.length,
      measured: measured.length,
      read50: measured.filter((s) => s.scroll >= 50).length,
      ctaSeen: sessions.filter((s) => s.seen).length,
      ctaClicked: sessions.filter((s) => s.clicked).length,
      // "Took action": pressed the dealer button OR tapped any contact button
      // (floating LINE/Phone/Facebook don't go through the dealer button, so
      // this union keeps the funnel step >= the Contact step below it).
      acted: sessions.filter((s) => s.clicked || anyContact(s.sessionId)).length,
      multiPage: sessions.filter((s) => s.views > 1).length,
      contacted: contacts ? contacts.size : null,
      contactBreakdown: {
        phone: contactCount('phone'),
        directions: contactCount('directions'),
        floatingLine: contactCount('floatingLine'),
        floatingPhone: contactCount('floatingPhone'),
        floatingFacebook: contactCount('floatingFacebook'),
      },
      contactTrackingSince,
    };
    const meta = {
      reach: Number(t.reach || 0),
      impressions: Number(t.impressions || 0),
      frequency: Number(t.frequency || 0),
      spend: Number(t.spend || 0),
      engagement: actionValue(t, 'post_engagement'),
      reactions: actionValue(t, 'post_reaction'),
      saves: actionValue(t, 'onsite_conversion.post_save'),
      comments: actionValue(t, 'comment'),
      linkClicks: Number(t.inline_link_clicks || 0),
      landingPageViews: actionValue(t, 'landing_page_view'),
      leads: actionValue(t, 'lead'),
    };

    const days = new Map();
    const day = (d) => {
      if (!days.has(d)) days.set(d, { date: d, reach: 0, engagement: 0, linkClicks: 0, visitors: 0, ctaClicked: 0, acted: 0, contacted: 0 });
      return days.get(d);
    };
    for (const r of daily.data || []) {
      const d = day(r.date_start);
      d.reach = Number(r.reach || 0);
      d.engagement = actionValue(r, 'post_engagement');
      d.linkClicks = Number(r.inline_link_clicks || 0);
    }
    for (const s of sessions) {
      const d = day(bkkDate(s.t0));
      d.visitors += 1;
      if (s.clicked) d.ctaClicked += 1;
      if (anyContact(s.sessionId)) d.contacted += 1;
      if (s.clicked || anyContact(s.sessionId)) d.acted += 1;
    }
    const data = { campaign, since, until, utmCampaigns, meta, site, daily: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)) };
    adFunnelCache.set(cacheKey, { data, expires: Date.now() + AD_FUNNEL_TTL_MS });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/website-utm-sessions', async (req, res) => {
  const { source = '', medium = '', campaign = '', content = '' } = req.query;
  const sinceParam = typeof req.query.since === 'string' ? new Date(req.query.since) : null;
  const untilParam = typeof req.query.until === 'string' ? new Date(req.query.until) : null;
  const since = sinceParam && !isNaN(sinceParam) ? sinceParam : new Date(Date.now() - 30 * 86400000);
  const until = untilParam && !isNaN(untilParam) ? untilParam : new Date();
  try {
    const { rows } = await tasakiWebPool.query(`
      SELECT "sessionId", path, "createdAt", "maxScrollPct", "dealerCtaSeen", "dealerCtaClicked"
      FROM "PageView"
      WHERE "createdAt" >= $1 AND "createdAt" <= $2
        AND "utmSource" = $3 AND "utmMedium" = $4 AND "utmCampaign" = $5 AND "utmContent" = $6
      ORDER BY "sessionId", "createdAt"
    `, [since, until, source, medium, campaign, content]);

    // /products/{typeId}/{productId}/{btu?} paths are IDs, not readable —
    // resolve them to real category/model names so the journey reads like
    // "หมวดติดผนัง → FWCE09-AF2M 9,000 BTU" instead of raw path segments.
    const typeIds = new Set();
    const productIds = new Set();
    for (const r of rows) {
      const m = r.path.match(/^\/products\/(\d+)(?:\/([^/]+))?/);
      if (m) {
        typeIds.add(Number(m[1]));
        if (m[2]) productIds.add(m[2]);
      }
    }
    const [typeRows, productRows] = await Promise.all([
      typeIds.size
        ? tasakiWebPool.query(`SELECT id, "nameTh" FROM "ProductType" WHERE id = ANY($1)`, [[...typeIds]])
        : { rows: [] },
      productIds.size
        ? tasakiWebPool.query(`SELECT id, "nameTh", model FROM "Product" WHERE id = ANY($1)`, [[...productIds]])
        : { rows: [] },
    ]);
    const typeNameById = new Map(typeRows.rows.map((t) => [t.id, t.nameTh]));
    const productById = new Map(productRows.rows.map((p) => [p.id, p]));

    function labelForPath(path) {
      const m = path.match(/^\/products\/(\d+)(?:\/([^/]+)(?:\/(\d+))?)?$/);
      if (!m) return null;
      const typeName = typeNameById.get(Number(m[1]));
      if (!typeName) return null;
      if (!m[2]) return `หมวด${typeName}`;
      const product = productById.get(m[2]);
      if (!product) return `หมวด${typeName}`;
      const productLabel = [product.nameTh, product.model].filter(Boolean).join(' ');
      const btuLabel = m[3] ? ` ${Number(m[3]).toLocaleString('th-TH')} BTU` : '';
      return `${productLabel}${btuLabel}`;
    }

    const bySession = new Map();
    for (const r of rows) {
      if (!bySession.has(r.sessionId)) bySession.set(r.sessionId, []);
      bySession.get(r.sessionId).push({
        path: r.path, label: labelForPath(r.path), createdAt: r.createdAt,
        maxScrollPct: r.maxScrollPct, dealerCtaSeen: r.dealerCtaSeen, dealerCtaClicked: r.dealerCtaClicked,
      });
    }
    const sessions = [...bySession.entries()].map(([sessionId, views]) => ({ sessionId, views }));
    res.json({ sessions });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Auto-post log ──────────────────────────────────────────────────────────
// Will be written to by the postToFacebook(card) side effect once real Page
// credentials exist (see server.js's card-published hook, not yet built) —
// one row per attempt, so this is a history/report, not live status.
app.get('/api/auto-post-log', async (req, res) => {
  try {
    const entries = await cached('auto-post-log', async () => {
      const rows = await prisma.autoPostLog.findMany({ orderBy: { postedAt: 'desc' }, take: 50 });
      return rows.map((r) => ({
        id: r.id,
        cardId: r.cardId,
        cardTitle: r.cardTitle,
        platform: r.platform,
        placement: r.placement,
        status: r.status,
        postUrl: r.postUrl,
        errorMessage: r.errorMessage,
        postedAt: r.postedAt,
      }));
    });
    res.json({ entries });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auto-post-log', async (req, res) => {
  const { cardId, cardTitle, platform, placement, status, postUrl, errorMessage, postedAt } = req.body;
  if (!cardTitle || !platform) return res.status(400).json({ error: 'cardTitle and platform are required' });
  try {
    const row = await prisma.autoPostLog.create({
      data: {
        cardId: cardId ? String(cardId) : null,
        cardTitle: String(cardTitle),
        platform: String(platform),
        placement: placement ? String(placement) : 'Feed',
        status: status ? String(status) : 'success',
        postUrl: postUrl ? String(postUrl) : null,
        errorMessage: errorMessage ? String(errorMessage) : null,
        ...(postedAt ? { postedAt: new Date(postedAt) } : {}),
      },
    });
    invalidateCache('auto-post-log');
    res.status(201).json({ id: row.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Page Video Insights ────────────────────────────────────────────────────
// Organic (non-paid) video performance on the Tasaki Air Facebook Page, pulled
// by scripts/sync-page-video-insights.mjs from the Graph API. Upserted by
// videoId so re-running the sync just refreshes view/like counts.
app.get('/api/page-video-insights', async (req, res) => {
  try {
    const data = await cached('page-video-insights', async () => {
      const rows = await prisma.pageVideoInsight.findMany({ orderBy: { createdTime: 'desc' } });
      const entries = rows.map((r) => ({
        id: r.id,
        videoId: r.videoId,
        description: r.description,
        createdTime: r.createdTime,
        length: r.length,
        permalinkUrl: r.permalinkUrl,
        views: r.views,
        postViews: r.postViews,
        adViews: r.adViews,
        likes: r.likes,
        comments: r.comments,
        shares: r.shares,
        fetchedAt: r.fetchedAt,
      }));
      const lastSyncedAt = entries.reduce((max, e) => (!max || e.fetchedAt > max ? e.fetchedAt : max), null);
      return { entries, lastSyncedAt };
    });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/page-video-insights', async (req, res) => {
  const { videoId, description, createdTime, length, permalinkUrl, views, postViews, likes, comments, shares } = req.body;
  if (!videoId || !createdTime) return res.status(400).json({ error: 'videoId and createdTime are required' });
  try {
    const data = {
      description: typeof description === 'string' ? description : '',
      createdTime: new Date(createdTime),
      length: Number(length) || 0,
      permalinkUrl: typeof permalinkUrl === 'string' ? permalinkUrl : '',
      views: Number(views) || 0,
      postViews: Number(postViews) || 0,
      likes: Number(likes) || 0,
      comments: Number(comments) || 0,
      shares: Number(shares) || 0,
      fetchedAt: new Date(),
    };
    const row = await prisma.pageVideoInsight.upsert({
      where: { videoId: String(videoId) },
      create: { videoId: String(videoId), ...data },
      update: data,
    });
    invalidateCache('page-video-insights');
    res.status(201).json({ id: row.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Set by scripts/sync-video-ad-views.mjs — the view count attributable to a
// Facebook ad promoting this exact video, kept separate from the regular
// sync above so a normal re-sync never wipes it back to 0.
app.patch('/api/page-video-insights/:videoId', async (req, res) => {
  const { adViews } = req.body;
  if (adViews == null) return res.status(400).json({ error: 'adViews is required' });
  try {
    const row = await prisma.pageVideoInsight.update({
      where: { videoId: req.params.videoId },
      data: { adViews: Number(adViews) || 0 },
    });
    invalidateCache('page-video-insights');
    res.json({ id: row.id, videoId: row.videoId, adViews: row.adViews });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Used by sync-page-video-insights.mjs to drop rows that no longer belong —
// a Facebook Story leg (not a real Page post) or a near-zero-view upload that
// never actually distributed (test cut, failed retry). See that script for
// the filtering rules; this just removes what it decides to exclude.
app.delete('/api/page-video-insights/:videoId', async (req, res) => {
  try {
    await prisma.pageVideoInsight.delete({ where: { videoId: req.params.videoId } });
    invalidateCache('page-video-insights');
    res.status(204).end();
  } catch (e) {
    if (e.code === 'P2025') return res.status(404).json({ error: 'not found' });
    res.status(500).json({ error: e.message });
  }
});

// ─── Website Issues ───────────────────────────────────────────────────────────
app.get('/api/website-issues', async (req, res) => {
  try {
    const result = await cached('website-issues', async () => {
      const rows = await prisma.websiteIssue.findMany();
      const byId = {};
      rows.forEach((r) => { byId[r.id] = r.issues; });
      return byId;
    });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/website-issues/:entryId', async (req, res) => {
  const { text, authorName, authorImage } = req.body;
  if (!text || typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'text is required' });
  if (!authorName || typeof authorName !== 'string' || !authorName.trim()) return res.status(400).json({ error: 'authorName is required' });
  try {
    let row = await prisma.websiteIssue.findUnique({ where: { id: req.params.entryId } });
    const issue = { id: crypto.randomUUID(), text: text.trim(), authorName: authorName.trim(), authorImage: typeof authorImage === 'string' ? authorImage : null, createdAt: new Date().toISOString(), comments: [] };
    if (!row) {
      row = await prisma.websiteIssue.create({ data: { id: req.params.entryId, date: '', feature: '', issues: [issue] } });
    } else {
      const issues = Array.isArray(row.issues) ? row.issues : [];
      issues.push(issue);
      row = await prisma.websiteIssue.update({ where: { id: req.params.entryId }, data: { issues } });
    }
    invalidateCache('website-issues');
    res.status(201).json(issue);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/website-issues/:entryId/:issueId/comments', async (req, res) => {
  const { text, authorName, authorImage, link } = req.body;
  if (!text || typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'text is required' });
  if (!authorName || typeof authorName !== 'string' || !authorName.trim()) return res.status(400).json({ error: 'authorName is required' });
  try {
    const row = await prisma.websiteIssue.findUnique({ where: { id: req.params.entryId } });
    const issues = Array.isArray(row?.issues) ? [...row.issues] : [];
    const issue = issues.find((i) => i.id === req.params.issueId);
    if (!issue) return res.status(404).json({ error: 'issue not found' });
    if (!Array.isArray(issue.comments)) issue.comments = [];
    const comment = { id: crypto.randomUUID(), text: text.trim(), link: typeof link === 'string' && link.trim() ? link.trim() : null, authorName: authorName.trim(), authorImage: typeof authorImage === 'string' ? authorImage : null, createdAt: new Date().toISOString() };
    issue.comments.push(comment);
    await prisma.websiteIssue.update({ where: { id: req.params.entryId }, data: { issues } });
    invalidateCache('website-issues');
    res.status(201).json(comment);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/website-issues/:entryId/:issueId/comments/:commentId', async (req, res) => {
  const { text } = req.body;
  if (!text || typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'text is required' });
  try {
    const row = await prisma.websiteIssue.findUnique({ where: { id: req.params.entryId } });
    const issues = Array.isArray(row?.issues) ? [...row.issues] : [];
    const issue = issues.find((i) => i.id === req.params.issueId);
    if (!issue) return res.status(404).json({ error: 'issue not found' });
    const comment = (issue.comments || []).find((c) => c.id === req.params.commentId);
    if (!comment) return res.status(404).json({ error: 'comment not found' });
    comment.text = text.trim();
    comment.updatedAt = new Date().toISOString();
    await prisma.websiteIssue.update({ where: { id: req.params.entryId }, data: { issues } });
    invalidateCache('website-issues');
    res.json(comment);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/website-issues/:entryId/:issueId/comments/:commentId', async (req, res) => {
  try {
    const row = await prisma.websiteIssue.findUnique({ where: { id: req.params.entryId } });
    const issues = Array.isArray(row?.issues) ? [...row.issues] : [];
    const issue = issues.find((i) => i.id === req.params.issueId);
    if (!issue || !Array.isArray(issue.comments)) return res.status(404).json({ error: 'comment not found' });
    const idx = issue.comments.findIndex((c) => c.id === req.params.commentId);
    if (idx === -1) return res.status(404).json({ error: 'comment not found' });
    const [removed] = issue.comments.splice(idx, 1);
    await prisma.websiteIssue.update({ where: { id: req.params.entryId }, data: { issues } });
    invalidateCache('website-issues');
    res.json(removed);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/website-issues/:entryId/:issueId', async (req, res) => {
  const { text, newEntryId } = req.body;
  try {
    const row = await prisma.websiteIssue.findUnique({ where: { id: req.params.entryId } });
    let issues = Array.isArray(row?.issues) ? [...row.issues] : [];
    const issue = issues.find((i) => i.id === req.params.issueId);
    if (!issue) return res.status(404).json({ error: 'issue not found' });
    if (text && typeof text === 'string' && text.trim()) { issue.text = text.trim(); issue.updatedAt = new Date().toISOString(); }
    if (typeof req.body.solved === 'boolean') { issue.solved = req.body.solved; issue.updatedAt = new Date().toISOString(); }
    if (newEntryId && typeof newEntryId === 'string' && newEntryId !== req.params.entryId) {
      issues = issues.filter((i) => i.id !== req.params.issueId);
      await prisma.websiteIssue.update({ where: { id: req.params.entryId }, data: { issues } });
      let target = await prisma.websiteIssue.findUnique({ where: { id: newEntryId } });
      const targetIssues = Array.isArray(target?.issues) ? [...target.issues, issue] : [issue];
      if (!target) await prisma.websiteIssue.create({ data: { id: newEntryId, date: '', feature: '', issues: targetIssues } });
      else await prisma.websiteIssue.update({ where: { id: newEntryId }, data: { issues: targetIssues } });
    } else {
      await prisma.websiteIssue.update({ where: { id: req.params.entryId }, data: { issues } });
    }
    invalidateCache('website-issues');
    res.json(issue);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/website-issues/:entryId/:issueId', async (req, res) => {
  try {
    const row = await prisma.websiteIssue.findUnique({ where: { id: req.params.entryId } });
    const issues = Array.isArray(row?.issues) ? [...row.issues] : [];
    const idx = issues.findIndex((i) => i.id === req.params.issueId);
    if (idx === -1) return res.status(404).json({ error: 'issue not found' });
    const [removed] = issues.splice(idx, 1);
    await prisma.websiteIssue.update({ where: { id: req.params.entryId }, data: { issues } });
    invalidateCache('website-issues');
    res.json(removed);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Marketing Changelog ──────────────────────────────────────────────────────
app.get('/api/marketing-changelog', async (req, res) => {
  try {
    const entries = await cached('marketing-changelog', async () => {
      const rows = await prisma.marketingChangelog.findMany({ orderBy: { date: 'desc' } });
      return rows.map((r) => ({ id: r.id, date: r.date, feature: r.text }));
    });
    res.json({ entries });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/marketing-changelog', async (req, res) => {
  const { text, date } = req.body;
  if (!text || typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'text is required' });
  try {
    const row = await prisma.marketingChangelog.create({
      data: { text: text.trim(), ...(date ? { date: new Date(date) } : {}) },
    });
    invalidateCache('marketing-changelog');
    res.status(201).json({ id: row.id, date: row.date, feature: row.text });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/marketing-changelog/:id', async (req, res) => {
  const { text, date } = req.body;
  try {
    const row = await prisma.marketingChangelog.update({
      where: { id: req.params.id },
      data: {
        ...(text !== undefined ? { text: String(text).trim() } : {}),
        ...(date !== undefined ? { date: new Date(date) } : {}),
      },
    });
    invalidateCache('marketing-changelog');
    res.json({ id: row.id, date: row.date, feature: row.text });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Profiles ─────────────────────────────────────────────────────────────────
app.get('/api/profiles', async (req, res) => {
  try {
    const profiles = await prisma.profile.findMany();
    const cards = await prisma.card.findMany({ select: { comments: true } });
    const stored = new Set(profiles.map((p) => p.name));
    const extras = [];
    cards.forEach((c) => {
      (Array.isArray(c.comments) ? c.comments : []).forEach((cm) => {
        if (cm.authorName && !stored.has(cm.authorName)) {
          extras.push({ name: cm.authorName, imageUrl: cm.authorImage || null });
          stored.add(cm.authorName);
        }
      });
    });
    res.json([...profiles, ...extras]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/profiles', async (req, res) => {
  const { name, imageUrl } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
  try {
    await prisma.profile.upsert({
      where: { name: name.trim() },
      update: { imageUrl: imageUrl || '' },
      create: { id: crypto.randomUUID(), name: name.trim(), imageUrl: imageUrl || '' },
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// "When did X last have this tab open" — one row per profile+page,
// overwritten on every visit (see server.js's TabView model comment).
app.post('/api/tab-views', async (req, res) => {
  const { profileName, page } = req.body;
  if (!profileName || !page) return res.status(400).json({ error: 'profileName and page are required' });
  try {
    await prisma.tabView.upsert({
      where: { profileName_page: { profileName: String(profileName), page: String(page) } },
      update: { viewedAt: new Date() },
      create: { profileName: String(profileName), page: String(page) },
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tab-views', async (req, res) => {
  try {
    const rows = await prisma.tabView.findMany({ orderBy: { viewedAt: 'desc' } });
    res.json({ entries: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5050;
app.listen(PORT, () => console.log(`Dashboard running at http://localhost:${PORT}`));

export default app;
