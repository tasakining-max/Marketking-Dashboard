const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execSync } = require('child_process');

const DATA_FILE = path.join(__dirname, 'data.json');
const ACTIVITY_FILE = path.join(__dirname, 'activity.json');
const KEY_MESSAGES_FILE = path.join(__dirname, 'key-messages.json');
const MARKETING_CHANGELOG_FILE = path.join(__dirname, 'marketing-changelog.json');
const PROFILES_FILE = path.join(__dirname, 'profiles.json');
const TASAKI_WEB_CHANGELOG_FILE = path.join(os.homedir(), 'Desktop', 'tasaki-web', 'data', 'changelog.ts');
const TASAKI_WEB_URL = 'https://tasaki-web-cyan.vercel.app';
const GATEWAY_LOG_FILE = path.join(os.homedir(), '.openclaw', 'logs', 'gateway-restart.log');
const OPENCLAW_CONFIG_FILE = path.join(os.homedir(), '.openclaw', 'openclaw.json');
const SESSIONS_FILE = path.join(os.homedir(), '.openclaw', 'agents', 'main', 'sessions', 'sessions.json');
const AGENT_BOT_ASSETS_DIR = path.join(os.homedir(), '.openclaw', 'workspace', 'assets', 'agentBot');
const AUTH_FILE = path.join(__dirname, 'auth.json');
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
const COLUMNS = ['idea', 'clip', 'youtube', 'published'];
const CLIP_TAGS = ['factory', 'office', 'ai', 'archive', 'motion', 'knowledge', 'product', 'trend', 'branding'];
const PLATFORMS = ['facebook', 'instagram', 'tiktok', 'youtube'];
const TODO_STATUSES = ['plan', 'in_progress', 'done'];
const MAX_ACTIVITY = 100;
const PUBLIC_PATHS = new Set(['/login.html', '/api/login']);
const IMAGE_MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif'
};

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

function readAuthPassword() {
  try {
    return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')).password;
  } catch {
    return null;
  }
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const cookies = {};
  if (!header) return cookies;
  header.split(';').forEach((pair) => {
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
  const password = readAuthPassword();
  const cookies = parseCookies(req);
  if (!password || cookies.dashboard_token === password) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  return res.redirect('/login.html');
});

app.post('/api/login', (req, res) => {
  const { password } = req.body;
  const actual = readAuthPassword();
  if (!actual || password !== actual) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  res.setHeader('Set-Cookie', `dashboard_token=${encodeURIComponent(password)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'dashboard_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/agent-assets', express.static(AGENT_BOT_ASSETS_DIR));

function readData() {
  if (!fs.existsSync(DATA_FILE)) return { cards: [] };
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  data.cards.forEach((card) => {
    if (!Array.isArray(card.todos)) return;
    card.todos.forEach((t) => {
      if (!TODO_STATUSES.includes(t.status)) {
        t.status = t.done ? 'done' : 'plan';
      }
      delete t.done;
    });
  });
  return data;
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function readActivity() {
  if (!fs.existsSync(ACTIVITY_FILE)) return { activity: [], cronJobs: [] };
  return JSON.parse(fs.readFileSync(ACTIVITY_FILE, 'utf8'));
}

function writeActivity(data) {
  fs.writeFileSync(ACTIVITY_FILE, JSON.stringify(data, null, 2));
}

function readKeyMessages() {
  if (!fs.existsSync(KEY_MESSAGES_FILE)) return { messages: [] };
  return JSON.parse(fs.readFileSync(KEY_MESSAGES_FILE, 'utf8'));
}

function writeKeyMessages(data) {
  fs.writeFileSync(KEY_MESSAGES_FILE, JSON.stringify(data, null, 2));
}

function readProfiles() {
  if (!fs.existsSync(PROFILES_FILE)) return [];
  return JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8'));
}

function writeProfiles(profiles) {
  fs.writeFileSync(PROFILES_FILE, JSON.stringify(profiles, null, 2));
}

function readMarketingChangelog() {
  if (!fs.existsSync(MARKETING_CHANGELOG_FILE)) return { entries: [] };
  return JSON.parse(fs.readFileSync(MARKETING_CHANGELOG_FILE, 'utf8'));
}

function readWebsiteChangelog() {
  try {
    const src = fs.readFileSync(TASAKI_WEB_CHANGELOG_FILE, 'utf8');
    const entries = [];
    const re = /\{\s*date:\s*'([^']+)'\s*,\s*feature:\s*'((?:[^'\\]|\\.)*)'\s*\}/g;
    let match;
    while ((match = re.exec(src)) !== null) {
      entries.push({ date: match[1], feature: match[2] });
    }
    return { entries, siteUrl: TASAKI_WEB_URL };
  } catch {
    return { entries: [], siteUrl: TASAKI_WEB_URL };
  }
}

function isGatewayRunning() {
  try {
    execSync('pgrep -f "openclaw.*gateway"', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function lastGatewayRestart() {
  if (!fs.existsSync(GATEWAY_LOG_FILE)) return null;
  const lines = fs.readFileSync(GATEWAY_LOG_FILE, 'utf8').trim().split('\n');
  const lastDone = lines.reverse().find((l) => l.includes('restart done'));
  if (!lastDone) return null;
  const match = lastDone.match(/^\[(.+?)\]/);
  return match ? match[1] : null;
}

function readDefaultModel() {
  try {
    const config = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG_FILE, 'utf8'));
    return (config.agents && config.agents.defaults && config.agents.defaults.model && config.agents.defaults.model.primary) || null;
  } catch {
    return null;
  }
}

function readAgentModel(agentId, fallback) {
  try {
    const config = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG_FILE, 'utf8'));
    const list = (config.agents && config.agents.list) || [];
    const agent = list.find((a) => a.id === agentId);
    return (agent && agent.model) || fallback;
  } catch {
    return fallback;
  }
}

function readBotModel(sessions, accountId) {
  let best = null;
  for (const key in sessions) {
    if (key.includes(':subagent:')) continue;
    const s = sessions[key];
    if (s.channel === 'discord' && s.route && s.route.accountId === accountId) {
      if (!best || (s.lastInteractionAt || 0) > (best.lastInteractionAt || 0)) best = s;
    }
  }
  if (!best) return { model: null, live: false };
  const model = best.modelOverride || best.model;
  if (!model) return { model: null, live: false };
  return { model: best.modelProvider ? `${best.modelProvider}/${model}` : model, live: true };
}

function readBots() {
  let discord;
  try {
    const config = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG_FILE, 'utf8'));
    discord = config.channels && config.channels.discord;
  } catch {
    discord = null;
  }
  if (!discord) return [];

  let sessions = {};
  try {
    sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
  } catch {
    sessions = {};
  }
  const defaultModel = readDefaultModel();

  const channelEnabled = !!discord.enabled;
  const defaultGuildCount = discord.guilds ? Object.keys(discord.guilds).length : 0;
  const mainagent = discord.accounts && discord.accounts.mainagent;
  const mainagentGuildCount = mainagent && mainagent.guilds ? Object.keys(mainagent.guilds).length : 0;
  const videobot = discord.accounts && discord.accounts.videobot;
  const videobotGuildCount = videobot && videobot.guilds ? Object.keys(videobot.guilds).length : 0;

  // Confirmed via Discord client logs (account token identity, not just the "mainagent"/"default" key names):
  // accountId "default" (the unnamed top-level account) runs the bot @Takujung.
  // accountId "mainagent" runs the bot @MainAgent.
  const takujungModel = readBotModel(sessions, 'default');
  const mainAgentModel = readBotModel(sessions, 'mainagent');
  const videobotModel = readBotModel(sessions, 'videobot');

  return [
    {
      name: 'Takujung',
      role: 'รอบรู้เรื่อง ทาซากิ สินค้า คู่มือ error code ค้นคว้า คิดคอนเทนต์',
      guildCount: defaultGuildCount,
      configured: channelEnabled,
      model: takujungModel.model || defaultModel,
      modelIsLive: takujungModel.live
    },
    {
      name: 'Main agent',
      role: 'ควบคุม ตั้งค่า Agent',
      guildCount: mainagentGuildCount,
      configured: channelEnabled && !!mainagent,
      model: mainAgentModel.model || defaultModel,
      modelIsLive: mainAgentModel.live
    },
    {
      name: 'Video Creator',
      role: 'สร้าง VDO',
      guildCount: videobotGuildCount,
      configured: channelEnabled && !!videobot,
      model: videobotModel.model || readAgentModel('videobot', defaultModel),
      modelIsLive: videobotModel.live
    }
  ];
}

app.get('/api/cards', (req, res) => {
  res.json(readData());
});

app.post('/api/cards', (req, res) => {
  const { title, description, column } = req.body;
  if (!title || typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({ error: 'title is required' });
  }
  const col = COLUMNS.includes(column) ? column : 'idea';
  const data = readData();
  const now = new Date().toISOString();
  const card = {
    id: crypto.randomUUID(),
    title: title.trim(),
    description: typeof description === 'string' ? description.trim() : '',
    column: col,
    status: 'active',
    rejectionReason: '',
    tags: [],
    platforms: [],
    imageUrl: null,
    todos: [],
    issues: [],
    comments: [],
    order: Date.now(),
    createdAt: now,
    updatedAt: now
  };
  data.cards.push(card);
  writeData(data);
  res.status(201).json(card);
});

app.put('/api/cards/reorder', (req, res) => {
  const { column, order } = req.body;
  if (!COLUMNS.includes(column)) {
    return res.status(400).json({ error: `column must be one of ${COLUMNS.join(', ')}` });
  }
  if (!Array.isArray(order)) {
    return res.status(400).json({ error: 'order must be an array of card ids' });
  }
  const data = readData();
  order.forEach((id, index) => {
    const card = data.cards.find((c) => c.id === id);
    if (!card) return;
    if (card.column !== column) {
      if (column === 'published') {
        card.publishedAt = new Date().toISOString();
      }
      card.column = column;
      card.updatedAt = new Date().toISOString();
    }
    card.order = index;
  });
  writeData(data);
  res.json(readData());
});

app.post('/api/cards/:id/image', (req, res) => {
  const data = readData();
  const card = data.cards.find((c) => c.id === req.params.id);
  if (!card) return res.status(404).json({ error: 'card not found' });

  const { image } = req.body;
  const match = typeof image === 'string' && image.match(/^data:(image\/[a-z]+);base64,(.+)$/i);
  if (!match || !IMAGE_MIME_EXT[match[1].toLowerCase()]) {
    return res.status(400).json({ error: 'image must be a base64 data URL (png, jpg, webp, or gif)' });
  }

  if (card.imageUrl) {
    const oldPath = path.join(__dirname, 'public', card.imageUrl);
    fs.rm(oldPath, { force: true }, () => {});
  }

  const ext = IMAGE_MIME_EXT[match[1].toLowerCase()];
  const fileName = `${card.id}-${Date.now()}.${ext}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, fileName), Buffer.from(match[2], 'base64'));

  card.imageUrl = `/uploads/${fileName}`;
  card.updatedAt = new Date().toISOString();
  writeData(data);
  res.json(card);
});

app.delete('/api/cards/:id/image', (req, res) => {
  const data = readData();
  const card = data.cards.find((c) => c.id === req.params.id);
  if (!card) return res.status(404).json({ error: 'card not found' });

  if (card.imageUrl) {
    fs.rm(path.join(__dirname, 'public', card.imageUrl), { force: true }, () => {});
  }
  card.imageUrl = null;
  card.updatedAt = new Date().toISOString();
  writeData(data);
  res.json(card);
});

app.patch('/api/cards/:id', (req, res) => {
  const data = readData();
  const card = data.cards.find((c) => c.id === req.params.id);
  if (!card) return res.status(404).json({ error: 'card not found' });

  const { title, description, column, status, rejectionReason, tags, platforms, todos, issues, comments, links } = req.body;
  if (title !== undefined) {
    if (typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ error: 'title must be a non-empty string' });
    }
    card.title = title.trim();
  }
  if (description !== undefined) {
    card.description = typeof description === 'string' ? description.trim() : '';
  }
  if (tags !== undefined) {
    if (!Array.isArray(tags) || tags.some((t) => !CLIP_TAGS.includes(t))) {
      return res.status(400).json({ error: `tags must be an array of: ${CLIP_TAGS.join(', ')}` });
    }
    card.tags = [...new Set(tags)];
  }
  if (platforms !== undefined) {
    if (!Array.isArray(platforms) || platforms.some((p) => !PLATFORMS.includes(p))) {
      return res.status(400).json({ error: `platforms must be an array of: ${PLATFORMS.join(', ')}` });
    }
    card.platforms = [...new Set(platforms)];
  }
  if (todos !== undefined) {
    const valid = Array.isArray(todos) && todos.every(
      (t) => t && typeof t.id === 'string' && typeof t.text === 'string' && t.text.trim() && TODO_STATUSES.includes(t.status)
    );
    if (!valid) {
      return res.status(400).json({ error: `todos must be an array of { id, text, status } where status is one of: ${TODO_STATUSES.join(', ')}` });
    }
    card.todos = todos.map((t) => ({ id: t.id, text: t.text.trim(), status: t.status }));
  }
  if (issues !== undefined) {
    const valid = Array.isArray(issues) && issues.every(
      (t) => t && typeof t.id === 'string' && typeof t.text === 'string' && t.text.trim()
    );
    if (!valid) {
      return res.status(400).json({ error: 'issues must be an array of { id, text, status? }' });
    }
    card.issues = issues.map((t) => ({
      id: t.id,
      text: t.text.trim(),
      status: t.status === 'solved' ? 'solved' : 'problem'
    }));
  }
  if (comments !== undefined) {
    const valid = Array.isArray(comments) && comments.every(
      (c) => c && typeof c.id === 'string' && typeof c.text === 'string' && c.text.trim() && typeof c.authorName === 'string'
    );
    if (!valid) {
      return res.status(400).json({ error: 'comments must be an array of { id, text, authorName, authorImage, createdAt }' });
    }
    card.comments = comments.map((c) => ({
      id: c.id,
      text: c.text.trim(),
      authorName: c.authorName.trim(),
      authorImage: typeof c.authorImage === 'string' ? c.authorImage : null,
      createdAt: c.createdAt || new Date().toISOString()
    }));
  }
  if (column !== undefined) {
    if (!COLUMNS.includes(column)) {
      return res.status(400).json({ error: `column must be one of ${COLUMNS.join(', ')}` });
    }
    if (column === 'published' && card.column !== 'published') {
      card.publishedAt = new Date().toISOString();
    }
    card.column = column;
  }
  if (status !== undefined) {
    if (!['active', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'status must be active or rejected' });
    }
    if (status === 'rejected') {
      const reason = typeof rejectionReason === 'string' ? rejectionReason.trim() : '';
      if (!reason) {
        return res.status(400).json({ error: 'rejectionReason is required when rejecting a card' });
      }
      card.rejectionReason = reason;
    } else {
      card.rejectionReason = '';
    }
    card.status = status;
  }
  if (links !== undefined) {
    const valid = Array.isArray(links) && links.every(
      (l) => l && typeof l.id === 'string' && typeof l.url === 'string' && l.url.trim()
    );
    if (!valid) return res.status(400).json({ error: 'links must be an array of { id, label, url }' });
    card.links = links.map((l) => ({ id: l.id, label: typeof l.label === 'string' ? l.label.trim() : '', url: l.url.trim() }));
  }
  card.updatedAt = new Date().toISOString();
  writeData(data);
  res.json(card);
});

app.delete('/api/cards/:id', (req, res) => {
  const data = readData();
  const idx = data.cards.findIndex((c) => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'card not found' });
  const [removed] = data.cards.splice(idx, 1);
  writeData(data);
  if (removed.imageUrl) {
    fs.rm(path.join(__dirname, 'public', removed.imageUrl), { force: true }, () => {});
  }
  res.json(removed);
});

app.get('/api/status', (req, res) => {
  const activityData = readActivity();
  const gatewayRunning = isGatewayRunning();
  const bots = readBots().map((bot) => ({ ...bot, online: gatewayRunning && bot.configured }));
  res.json({
    gatewayRunning,
    lastRestart: lastGatewayRestart(),
    bots,
    activity: activityData.activity,
    cronJobs: activityData.cronJobs
  });
});

app.post('/api/activity', (req, res) => {
  const { message, type } = req.body;
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message is required' });
  }
  const activityData = readActivity();
  const entry = {
    id: crypto.randomUUID(),
    message: message.trim(),
    type: ['info', 'success', 'warning'].includes(type) ? type : 'info',
    createdAt: new Date().toISOString()
  };
  activityData.activity.unshift(entry);
  activityData.activity = activityData.activity.slice(0, MAX_ACTIVITY);
  writeActivity(activityData);
  res.status(201).json(entry);
});

app.delete('/api/activity', (req, res) => {
  const activityData = readActivity();
  activityData.activity = [];
  writeActivity(activityData);
  res.json({ ok: true });
});

app.put('/api/cron-jobs', (req, res) => {
  const { jobs } = req.body;
  if (!Array.isArray(jobs)) {
    return res.status(400).json({ error: 'jobs must be an array' });
  }
  const activityData = readActivity();
  activityData.cronJobs = jobs;
  writeActivity(activityData);
  res.json({ cronJobs: activityData.cronJobs });
});

app.get('/api/key-messages', (req, res) => {
  res.json(readKeyMessages());
});

app.post('/api/key-messages', (req, res) => {
  const { text } = req.body;
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }
  const data = readKeyMessages();
  const message = { id: crypto.randomUUID(), text: text.trim() };
  data.messages.push(message);
  writeKeyMessages(data);
  res.status(201).json(message);
});

app.patch('/api/key-messages/:id', (req, res) => {
  const data = readKeyMessages();
  const message = data.messages.find((m) => m.id === req.params.id);
  if (!message) return res.status(404).json({ error: 'message not found' });
  const { text } = req.body;
  if (text !== undefined) {
    if (typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'text must be a non-empty string' });
    }
    message.text = text.trim();
  }
  writeKeyMessages(data);
  res.json(message);
});

app.delete('/api/key-messages/:id', (req, res) => {
  const data = readKeyMessages();
  const idx = data.messages.findIndex((m) => m.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'message not found' });
  const [removed] = data.messages.splice(idx, 1);
  writeKeyMessages(data);
  res.json(removed);
});

app.put('/api/key-messages/reorder', (req, res) => {
  const { order } = req.body;
  if (!Array.isArray(order)) {
    return res.status(400).json({ error: 'order must be an array of message ids' });
  }
  const data = readKeyMessages();
  const byId = new Map(data.messages.map((m) => [m.id, m]));
  const reordered = order.map((id) => byId.get(id)).filter(Boolean);
  if (reordered.length !== data.messages.length) {
    return res.status(400).json({ error: 'order must include every existing message id exactly once' });
  }
  data.messages = reordered;
  writeKeyMessages(data);
  res.json(data);
});

app.get('/api/website-changelog', (req, res) => {
  res.json(readWebsiteChangelog());
});

app.get('/api/marketing-changelog', (req, res) => {
  res.json(readMarketingChangelog());
});

app.get('/api/profiles', (req, res) => {
  const stored = readProfiles();
  const storedNames = new Set(stored.map((p) => p.name));

  // pull in anyone who has commented but isn't in profiles.json yet
  const data = readData();
  data.cards.forEach((c) => {
    (c.comments || []).forEach((cm) => {
      if (cm.authorName && !storedNames.has(cm.authorName)) {
        stored.push({ name: cm.authorName, imageUrl: cm.authorImage || null });
        storedNames.add(cm.authorName);
      }
    });
  });

  res.json(stored);
});

app.post('/api/profiles', (req, res) => {
  const { name, imageUrl } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
  const profiles = readProfiles();
  const idx = profiles.findIndex((p) => p.name === name.trim());
  if (idx >= 0) {
    profiles[idx] = { name: name.trim(), imageUrl: imageUrl || profiles[idx].imageUrl || null };
  } else {
    profiles.push({ name: name.trim(), imageUrl: imageUrl || null });
  }
  writeProfiles(profiles);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 5050;
app.listen(PORT, () => {
  console.log(`Marketing dashboard running at http://localhost:${PORT}`);
});
