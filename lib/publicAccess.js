// Public, view-only access through the Tasaki website.
//
// tasaki-web (next.config.ts) forwards https://www.tasaki.co.th<PUBLIC_BASE_PATH>/*
// to this dashboard on the same server, so those requests arrive from
// localhost. For them:
//   • anyone with the link can look (GET);
//   • any change (POST/PUT/PATCH/DELETE) needs the edit login
//     (DASHBOARD_EDIT_PASSWORD), kept for 30 days in a cookie on that path;
//   • absolute links ("/api/…", "/ads.html") in pages, scripts and JSON are
//     rewritten to sit under PUBLIC_BASE_PATH.
// LAN/VPN requests (not from localhost) and the Mac copy (no PUBLIC_BASE_PATH)
// are untouched.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const COOKIE = 'mk_edit';
const MAX_AGE_S = 30 * 24 * 3600;
const TEXT_EXT = /\.(html|js|css)$/;

export function setupPublicAccess(app, publicDir) {
  const BASE = (process.env.PUBLIC_BASE_PATH || '').replace(/\/+$/, '');
  const PASSWORD = process.env.DASHBOARD_EDIT_PASSWORD || '';
  if (!BASE) return;
  if (!/^\/[A-Za-z0-9_-]{8,}$/.test(BASE)) { console.error('PUBLIC_BASE_PATH must look like /abc123xyz (8+ letters/digits); public access disabled'); return; }
  if (PASSWORD.length < 12) console.warn('⚠ DASHBOARD_EDIT_PASSWORD is missing or shorter than 12 characters: public editing is disabled');

  const isPublic = (req) => LOOPBACK.has(req.socket.remoteAddress);
  const key = crypto.createHash('sha256').update(`mk-edit:${PASSWORD}`).digest();
  const sign = (exp) => crypto.createHmac('sha256', key).update(String(exp)).digest('base64url');
  const isEditor = (req) => {
    if (PASSWORD.length < 12) return false;
    const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=(\\d+)\\.([\\w-]+)`));
    if (!m || Number(m[1]) < Date.now()) return false;
    const a = Buffer.from(m[2]); const b = Buffer.from(sign(m[1]));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  // Absolute URLs → under BASE. Matches a quote or "(" then "/" then a known
  // folder or a file name with a web extension, so JS like split('/') is left alone.
  const dirs = ['api', ...fs.readdirSync(publicDir, { withFileTypes: true }).filter((d) => d.isDirectory() && /^[\w-]+$/.test(d.name)).map((d) => d.name)];
  const URL_RE = new RegExp(`(["'\`(])\\/(?=(?:${dirs.join('|')})\\/|[\\w.%-]+\\.(?:html|js|css|png|jpe?g|gif|svg|ico|webmanifest|json|webp|mp4|mov|pdf)(?:[?#"'\`)]|$))`, 'g');
  const rewrite = (s) => s.replace(URL_RE, `$1${BASE}/`).replace(/(href|action)=(["'])\/\2/g, `$1=$2${BASE}/$2`);
  // API JSON also carries website paths (page views, "/manuals/…" catalogue
  // links on tasaki.co.th), so only this dashboard's own asset URLs move there.
  const JSON_RE = /"\/(?=(?:api|uploads|assets|agent-assets|campaign-assets)\/)/g;
  const rewriteJson = (s) => s.replace(JSON_RE, `"${BASE}/`);

  // Login throttling: 5 wrong tries per IP → 15 min lock; 30 in an hour overall → 1 h lock.
  const fails = new Map(); let globalFails = []; let globalLockUntil = 0;
  const clientIp = (req) => String(req.headers['x-real-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0] || 'unknown').trim();

  const loginPage = (msg = '') => `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>เข้าสู่ระบบเพื่อแก้ไข</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f4f7fa;font-family:system-ui,sans-serif;color:#001222}
form{background:#fff;padding:28px 24px;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.08);width:min(360px,92vw)}
h1{font-size:20px;margin:0 0 6px}p{color:#4a6475;font-size:14px;margin:0 0 16px}input,button{width:100%;box-sizing:border-box;font:inherit;font-size:16px;padding:12px;border-radius:10px}
input{border:1px solid #c9d6e0;margin-bottom:12px}button{border:0;background:#0074A2;color:#fff;font-weight:700;cursor:pointer}.e{color:#c62828;font-size:14px;margin-bottom:10px}a{display:block;text-align:center;margin-top:14px;color:#0074A2;font-size:14px}</style></head>
<body><form method="post" action="${BASE}/__login"><h1>เข้าสู่ระบบเพื่อแก้ไข</h1><p>ดูอย่างเดียวไม่ต้องเข้าสู่ระบบ</p>${msg ? `<div class="e">${msg}</div>` : ''}
<input type="password" name="password" placeholder="รหัสผ่าน" autocomplete="current-password" autofocus required><button>เข้าสู่ระบบ</button><a href="${BASE}/">← กลับไปดู dashboard</a></form></body></html>`;

  app.use(async (req, res, next) => {
    if (!isPublic(req)) return next();
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Referrer-Policy', 'no-referrer'); // keep the secret path out of other sites' logs

    if (req.path === '/__login') {
      if (req.method === 'GET') return res.type('html').send(loginPage());
      if (req.method !== 'POST') return res.status(405).end();
      const ip = clientIp(req); const now = Date.now();
      const f = fails.get(ip) || { n: 0, until: 0 };
      globalFails = globalFails.filter((t) => now - t < 3600e3);
      if (f.until > now || globalLockUntil > now) return res.status(429).type('html').send(loginPage('ใส่รหัสผิดหลายครั้ง ลองใหม่ภายหลัง'));
      const body = await readForm(req);
      const given = crypto.createHash('sha256').update(String(body.password || '')).digest();
      const want = crypto.createHash('sha256').update(PASSWORD).digest();
      if (PASSWORD.length >= 12 && crypto.timingSafeEqual(given, want)) {
        fails.delete(ip);
        const exp = now + MAX_AGE_S * 1000;
        res.setHeader('Set-Cookie', `${COOKIE}=${exp}.${sign(exp)}; Path=${BASE}; Max-Age=${MAX_AGE_S}; HttpOnly; Secure; SameSite=Strict`);
        return res.redirect(303, `${BASE}/`);
      }
      f.n += 1; if (f.n >= 5) { f.until = now + 15 * 60e3; f.n = 0; } fails.set(ip, f);
      globalFails.push(now); if (globalFails.length >= 30) globalLockUntil = now + 3600e3;
      return res.status(401).type('html').send(loginPage('รหัสผ่านไม่ถูกต้อง'));
    }
    if (req.path === '/__logout') {
      res.setHeader('Set-Cookie', `${COOKIE}=; Path=${BASE}; Max-Age=0; HttpOnly; Secure; SameSite=Strict`);
      return res.redirect(303, `${BASE}/`);
    }
    if (req.path === '/__whoami') return res.json({ editor: isEditor(req), base: BASE });

    if (!['GET', 'HEAD'].includes(req.method) && !isEditor(req)) {
      return res.status(401).json({ error: 'โหมดดูอย่างเดียว: ต้องเข้าสู่ระบบก่อนแก้ไข', login: `${BASE}/__login` });
    }

    // Pages, scripts and styles: serve rewritten.
    const rel = req.path === '/' ? '/index.html' : req.path;
    if (req.method === 'GET' && TEXT_EXT.test(rel)) {
      const file = path.join(publicDir, path.normalize(rel).replace(/^([/\\])+/, ''));
      if (file.startsWith(publicDir + path.sep) && fs.existsSync(file)) {
        let text = rewrite(fs.readFileSync(file, 'utf8'));
        // <base> keeps relative links ("style.css") working at ".../path" with no
        // trailing slash (Next.js strips it).
        if (rel.endsWith('.html')) {
          text = text.replace(/<head([^>]*)>/i, `<head$1><base href="${BASE}/">`)
            .replace(/<\/body>/i, `<script src="${BASE}/public-mode.js?v=1"></script>\n</body>`);
        }
        res.setHeader('Cache-Control', 'no-cache');
        return res.type(path.extname(rel)).send(text);
      }
    }

    // API responses (JSON with image/video URLs): rewrite too.
    const send = res.send.bind(res);
    res.send = (body) => {
      const type = String(res.get('Content-Type') || '');
      if (typeof body === 'string') {
        if (/json/.test(type)) body = rewriteJson(body);
        else if (/html|javascript|css/.test(type)) body = rewrite(body);
      }
      return send(body);
    };
    next();
  });
  console.log(`Public view-only access on ${BASE} (editing ${PASSWORD.length >= 12 ? 'needs login' : 'disabled'})`);
}

function readForm(req) {
  if (req.body && Object.keys(req.body).length) return Promise.resolve(req.body);
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 4096) req.destroy(); });
    req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(data))));
    req.on('error', () => resolve({}));
  });
}
