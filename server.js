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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });
///// END /////
const COLUMNS = ['idea', 'clip', 'youtube', 'published'];
const CLIP_TAGS = ['factory', 'office', 'ai', 'archive', 'motion', 'knowledge', 'product', 'trend', 'branding'];
const PLATFORMS = ['facebook', 'instagram', 'tiktok', 'youtube'];
const TODO_STATUSES = ['plan', 'in_progress', 'done'];
const MAX_ACTIVITY = 100;
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
const TASAKI_WEB_URL = 'https://tasaki-web-cyan.vercel.app';
const IMAGE_MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

try { fs.mkdirSync(UPLOADS_DIR, { recursive: true }); } catch {}

// ─── Claude agent roster ──────────────────────────────────────────────────────
// Mission Control used to monitor a separate Discord bot gateway ("Clawbot").
// That gateway no longer runs — this project is now driven by Claude Code, so
// the roster instead reflects the main agent plus the subagents configured in
// .claude/agents/*.md. There's no live process to poll for "online" status
// (Claude Code is session-based, not a persistent server), so status here
// means "configured and available", and last-active comes from the Activity
// Feed whenever an agent logs a `[Agent Name] ...` entry via POST /api/activity.
const AGENTS_DIR = path.join(__dirname, '.claude', 'agents');

function loadAgentRoster() {
  const roster = [
    { name: 'Claude', role: 'Main agent — handles the marketing-dashboard project directly: features, fixes, content, DB operations', model: 'Claude Sonnet 5' },
  ];
  try {
    const files = fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md'));
    for (const file of files) {
      const raw = fs.readFileSync(path.join(AGENTS_DIR, file), 'utf8');
      const frontmatter = raw.match(/^---\n([\s\S]*?)\n---/);
      if (!frontmatter) continue;
      const nameMatch = frontmatter[1].match(/^name:\s*(.+)$/m);
      const descMatch = frontmatter[1].match(/^description:\s*(.+)$/m);
      roster.push({
        name: nameMatch ? nameMatch[1].trim() : file.replace(/\.md$/, ''),
        role: descMatch ? descMatch[1].trim().split(/(?<=[.!])\s/)[0] : 'Subagent',
        model: null,
      });
    }
  } catch {}
  return roster;
}

function withAgentActivity(roster, activity) {
  return roster.map((a) => {
    const last = activity.find((e) => e.text.startsWith(`[${a.name}]`));
    return { ...a, online: true, lastActiveAt: last ? last.createdAt : null };
  });
}

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
      return rows.map((c) => serializeCardLite(c, hasImageIds, profileNames));
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
  const { title, description, column, shootDate, shootNote } = req.body;
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
      if (card.column !== column) {
        data.column = column;
        if (column === 'published') {
          data.publishedAt = now;
          data.plannedPublishDate = null;
        } else if (card.column === 'published') {
          data.publishedAt = null;
        }
      }
      const updated = await prisma.card.update({ where: { id }, data, omit: { imageUrl: true } });
      if (data.column) notifyPlanner(updated);
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

app.patch('/api/cards/:id', async (req, res) => {
  try {
    const card = await prisma.card.findUnique({ where: { id: req.params.id }, omit: { imageUrl: true } });
    if (!card) return res.status(404).json({ error: 'card not found' });

    const { title, description, column, status, rejectionReason, tags, platforms, todos, issues, comments, links, plannedPublishDate, publishedAt, shootDate, shootNote, pinned } = req.body;
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
    if (column !== undefined) {
      if (!COLUMNS.includes(column)) return res.status(400).json({ error: `column must be one of ${COLUMNS.join(', ')}` });
      if (column === 'published' && card.column !== 'published') {
        data.publishedAt = new Date().toISOString();
        data.plannedPublishDate = null;
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
    if (publishedAt !== undefined) {
      if (publishedAt !== null && isNaN(new Date(publishedAt).getTime())) return res.status(400).json({ error: 'publishedAt must be a valid date' });
      data.publishedAt = publishedAt;
    }
    if (shootDate !== undefined) data.shootDate = shootDate || null;
    if (shootNote !== undefined) data.shootNote = typeof shootNote === 'string' ? shootNote.trim() : '';
    if (pinned !== undefined) data.pinned = Boolean(pinned);

    const updated = await prisma.card.update({ where: { id: req.params.id }, data, omit: { imageUrl: true } });
    notifyPlanner(updated);
    invalidateCache('cards');
    res.json(serializeCard(updated));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/cards/:id', async (req, res) => {
  try {
    const card = await prisma.card.findUnique({ where: { id: req.params.id }, omit: { imageUrl: true } });
    if (!card) return res.status(404).json({ error: 'card not found' });
    await prisma.card.delete({ where: { id: req.params.id } });
    invalidateCache('cards');
    res.json(serializeCard(card));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Status / Bots (local-only — returns defaults on Vercel) ─────────────────
app.get('/api/status', async (req, res) => {
  try {
    const data = await cached('status', async () => {
      const activity = await prisma.activityEntry.findMany({ orderBy: { createdAt: 'desc' }, take: MAX_ACTIVITY });
      const cronJobs = await prisma.cronJob.findMany();
      const bots = withAgentActivity(loadAgentRoster(), activity);
      return { gatewayRunning: true, lastRestart: null, bots, activity, cronJobs };
    });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Activity ────────────────────────────────────────────────────────────────
app.post('/api/activity', async (req, res) => {
  const { message, type } = req.body;
  if (!message || typeof message !== 'string' || !message.trim()) return res.status(400).json({ error: 'message is required' });
  try {
    const entry = await prisma.activityEntry.create({
      data: { id: crypto.randomUUID(), text: message.trim() },
    });
    invalidateCache('status');
    res.status(201).json(entry);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/activity', async (req, res) => {
  try {
    await prisma.activityEntry.deleteMany();
    invalidateCache('status');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/cron-jobs', async (req, res) => {
  const { jobs } = req.body;
  if (!Array.isArray(jobs)) return res.status(400).json({ error: 'jobs must be an array' });
  try {
    await prisma.cronJob.deleteMany();
    await prisma.cronJob.createMany({ data: jobs.map((j) => ({ id: j.id || crypto.randomUUID(), name: j.name || '', schedule: j.schedule || '', command: j.command || '', enabled: j.enabled !== false })) });
    const cronJobs = await prisma.cronJob.findMany();
    invalidateCache('status');
    res.json({ cronJobs });
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

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5050;
app.listen(PORT, () => console.log(`Dashboard running at http://localhost:${PORT}`));

export default app;
