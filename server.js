import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { PrismaClient } from '@prisma/client';
import { PrismaNeon } from '@prisma/adapter-neon';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const COLUMNS = ['idea', 'clip', 'youtube', 'published'];
const CLIP_TAGS = ['factory', 'office', 'ai', 'archive', 'motion', 'knowledge', 'product', 'trend', 'branding'];
const PLATFORMS = ['facebook', 'instagram', 'tiktok', 'youtube'];
const TODO_STATUSES = ['plan', 'in_progress', 'done'];
const MAX_ACTIVITY = 100;
const PUBLIC_PATHS = new Set(['/login.html', '/api/login']);
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
const TASAKI_WEB_URL = 'https://tasaki-web-cyan.vercel.app';
const IMAGE_MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

try { fs.mkdirSync(UPLOADS_DIR, { recursive: true }); } catch {}

// ─── Auth ────────────────────────────────────────────────────────────────────
function getPassword() {
  return process.env.DASHBOARD_PASSWORD || null;
}

function parseCookies(req) {
  const cookies = {};
  (req.headers.cookie || '').split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    cookies[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return cookies;
}

const app = express();
app.use(express.json({ limit: '15mb' }));

app.use((req, res, next) => {
  if (PUBLIC_PATHS.has(req.path)) return next();
  const password = getPassword();
  const cookies = parseCookies(req);
  if (!password || cookies.dashboard_token === password) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  return res.redirect('/login.html');
});

app.post('/api/login', (req, res) => {
  const { password } = req.body;
  const actual = getPassword();
  if (!actual || password !== actual) return res.status(401).json({ error: 'Invalid password' });
  res.setHeader('Set-Cookie', `dashboard_token=${encodeURIComponent(password)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'dashboard_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── Cards ───────────────────────────────────────────────────────────────────
function serializeCard(c) {
  return {
    ...c,
    createdAt: c.createdAt?.toISOString?.() ?? c.createdAt,
    updatedAt: c.updatedAt?.toISOString?.() ?? c.updatedAt,
  };
}

app.get('/api/cards', async (req, res) => {
  try {
    const where = req.query.column ? { column: req.query.column } : {};
    const cards = await prisma.card.findMany({ where, orderBy: { order: 'asc' } });
    res.json({ cards: cards.map(serializeCard) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/cards', async (req, res) => {
  const { title, description, column } = req.body;
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
      },
    });
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
      const card = await prisma.card.findUnique({ where: { id } });
      if (!card) return;
      const data = { order: index, updatedAt: new Date() };
      if (card.column !== column) {
        data.column = column;
        if (column === 'published') data.publishedAt = now;
      }
      await prisma.card.update({ where: { id }, data });
    }));
    const cards = await prisma.card.findMany({ orderBy: { order: 'asc' } });
    res.json({ cards: cards.map(serializeCard) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/cards/:id/image', async (req, res) => {
  try {
    const card = await prisma.card.findUnique({ where: { id: req.params.id } });
    if (!card) return res.status(404).json({ error: 'card not found' });
    const { image } = req.body;
    if (!image || !image.startsWith('data:image/')) return res.status(400).json({ error: 'invalid image data' });
    const updated = await prisma.card.update({ where: { id: req.params.id }, data: { imageUrl: image } });
    res.json(serializeCard(updated));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/cards/:id/image', async (req, res) => {
  try {
    const card = await prisma.card.findUnique({ where: { id: req.params.id } });
    if (!card) return res.status(404).json({ error: 'card not found' });
    const updated = await prisma.card.update({ where: { id: req.params.id }, data: { imageUrl: null } });
    res.json(serializeCard(updated));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/cards/:id', async (req, res) => {
  try {
    const card = await prisma.card.findUnique({ where: { id: req.params.id } });
    if (!card) return res.status(404).json({ error: 'card not found' });

    const { title, description, column, status, rejectionReason, tags, platforms, todos, issues, comments, links, plannedPublishDate, pinned } = req.body;
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
      data.comments = comments.map((c) => ({ id: c.id, text: c.text.trim(), authorName: c.authorName.trim(), authorImage: typeof c.authorImage === 'string' ? c.authorImage : null, createdAt: c.createdAt || new Date().toISOString() }));
    }
    if (column !== undefined) {
      if (!COLUMNS.includes(column)) return res.status(400).json({ error: `column must be one of ${COLUMNS.join(', ')}` });
      if (column === 'published' && card.column !== 'published') data.publishedAt = new Date().toISOString();
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
    if (pinned !== undefined) data.pinned = Boolean(pinned);

    const updated = await prisma.card.update({ where: { id: req.params.id }, data });
    res.json(serializeCard(updated));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/cards/:id', async (req, res) => {
  try {
    const card = await prisma.card.findUnique({ where: { id: req.params.id } });
    if (!card) return res.status(404).json({ error: 'card not found' });
    await prisma.card.delete({ where: { id: req.params.id } });
    res.json(serializeCard(card));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Status / Bots (local-only — returns defaults on Vercel) ─────────────────
app.get('/api/status', async (req, res) => {
  try {
    const activity = await prisma.activityEntry.findMany({ orderBy: { createdAt: 'desc' }, take: MAX_ACTIVITY });
    const cronJobs = await prisma.cronJob.findMany();
    res.json({ gatewayRunning: false, lastRestart: null, bots: [], activity, cronJobs });
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
    res.status(201).json(entry);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/activity', async (req, res) => {
  try {
    await prisma.activityEntry.deleteMany();
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
    res.json({ cronJobs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Key Messages ─────────────────────────────────────────────────────────────
app.get('/api/key-messages', async (req, res) => {
  try {
    const messages = await prisma.keyMessage.findMany();
    res.json({ messages });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/key-messages', async (req, res) => {
  const { text } = req.body;
  if (!text || typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'text is required' });
  try {
    const message = await prisma.keyMessage.create({ data: { id: crypto.randomUUID(), text: text.trim() } });
    res.status(201).json(message);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/key-messages/:id', async (req, res) => {
  const { text } = req.body;
  if (text !== undefined && (!typeof text === 'string' || !text.trim())) return res.status(400).json({ error: 'text must be a non-empty string' });
  try {
    const message = await prisma.keyMessage.update({ where: { id: req.params.id }, data: text ? { text: text.trim() } : {} });
    res.json(message);
  } catch { res.status(404).json({ error: 'message not found' }); }
});

app.delete('/api/key-messages/:id', async (req, res) => {
  try {
    const removed = await prisma.keyMessage.delete({ where: { id: req.params.id } });
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

// ─── Website Changelog (read-only from DB) ───────────────────────────────────
app.get('/api/website-changelog', (req, res) => {
  res.json({ entries: [], siteUrl: TASAKI_WEB_URL });
});

// ─── Website Issues ───────────────────────────────────────────────────────────
app.get('/api/website-issues', async (req, res) => {
  try {
    const rows = await prisma.websiteIssue.findMany();
    const result = {};
    rows.forEach((r) => { result[r.id] = r.issues; });
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
    res.json(removed);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Marketing Changelog ──────────────────────────────────────────────────────
app.get('/api/marketing-changelog', async (req, res) => {
  try {
    const entries = await prisma.marketingChangelog.findMany({ orderBy: { date: 'desc' } });
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
