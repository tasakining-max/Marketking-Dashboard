// Public, view-only access through the Tasaki website.
//
// tasaki-web (next.config.ts) forwards https://www.tasaki.co.th<PUBLIC_BASE_PATH>/*
// to this dashboard on the same server, so those requests arrive from
// localhost. For them:
//   • looking needs any active tasaki.co.th website login (not the catalog bot);
//   • any change (POST/PUT/PATCH/DELETE) needs the person to be logged in to
//     the Tasaki website (its session_token cookie, checked against
//     tasaki-web's /api/auth/me) with an email listed in DASHBOARD_EDITOR_EMAILS;
//   • absolute links ("/api/…", "/ads.html") in pages, scripts and JSON are
//     rewritten to sit under PUBLIC_BASE_PATH.
// LAN/VPN requests (not from localhost) and the Mac copy (no PUBLIC_BASE_PATH)
// are untouched.
import fs from 'fs';
import path from 'path';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const TEXT_EXT = /\.(html|js|css)$/;
const WEB_SESSION_COOKIE = 'session_token';

export function setupPublicAccess(app, publicDir) {
  const BASE = (process.env.PUBLIC_BASE_PATH || '').replace(/\/+$/, '');
  const EDITORS = (process.env.DASHBOARD_EDITOR_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const WEB = process.env.TASAKI_WEB_INTERNAL_URL || 'http://127.0.0.1:3000';
  if (!BASE) return;
  if (!/^\/[A-Za-z0-9_-]{8,}$/.test(BASE)) { console.error('PUBLIC_BASE_PATH must look like /abc123xyz (8+ letters/digits); public access disabled'); return; }
  if (!EDITORS.length) console.warn('⚠ DASHBOARD_EDITOR_EMAILS is empty: public editing is disabled');

  const isPublic = (req) => LOOPBACK.has(req.socket.remoteAddress);
  // Who is logged in to the website (cached 60 s per session).
  const cache = new Map();
  const webUser = async (req) => {
    const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${WEB_SESSION_COOKIE}=([^;]+)`));
    if (!m) return null;
    const tok = m[1]; const hit = cache.get(tok);
    if (hit && Date.now() - hit.at < 60e3) return hit.user;
    let user = null;
    try {
      const r = await fetch(`${WEB}/api/auth/me`, { headers: { cookie: `${WEB_SESSION_COOKIE}=${tok}` }, signal: AbortSignal.timeout(5000) });
      if (r.ok) user = await r.json();
    } catch { /* website down → treat as not logged in */ }
    if (cache.size > 500) cache.clear();
    cache.set(tok, { user, at: Date.now() });
    return user;
  };
  // Viewing needs any active website account except the catalog bot.
  const isViewer = async (req) => { const u = await webUser(req); return Boolean(u && u.email && u.role !== 'CATALOG_BOT'); };
  const isEditor = async (req) => {
    const u = await webUser(req);
    return Boolean(u && u.email && EDITORS.includes(String(u.email).toLowerCase()));
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

  const loginPage = (loggedInAs) => `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>เข้าสู่ระบบ Marketing Dashboard</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f4f7fa;font-family:system-ui,sans-serif;color:#001222}
.c{background:#fff;padding:28px 24px;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.08);width:min(380px,92vw)}
h1{font-size:20px;margin:0 0 10px}p{color:#4a6475;font-size:15px;line-height:1.5;margin:0 0 16px}
.b{display:block;text-align:center;text-decoration:none;font-size:16px;padding:12px;border-radius:10px;background:#0074A2;color:#fff;font-weight:700}a.l{display:block;text-align:center;margin-top:14px;color:#0074A2;font-size:14px}.e{color:#c62828;font-size:14px;margin-bottom:12px}</style></head>
<body><div class="c"><h1>เข้าสู่ระบบ Marketing Dashboard</h1>
${loggedInAs ? `<div class="e">ตอนนี้เข้าเว็บด้วย ${String(loggedInAs).replace(/[<>&"]/g, '')} ซึ่งดูได้อย่างเดียว แก้ไขไม่ได้</div>` : ''}
<p>ต้องเข้าสู่ระบบเว็บ tasaki.co.th ก่อนดู ใช้อีเมลและรหัสผ่านเดียวกับที่เข้าเว็บ<br>เข้าสู่ระบบที่หน้าเว็บ แล้วกลับมาที่ลิงก์ dashboard นี้ (เครื่องเดิม เบราว์เซอร์เดิม)</p>
<a class="b" href="/" target="_blank" rel="noopener">ไปเข้าสู่ระบบที่เว็บ Tasaki</a><a class="l" href="${BASE}/">เข้าสู่ระบบแล้ว → เปิด dashboard</a></div></body></html>`;

  app.use(async (req, res, next) => {
    if (!isPublic(req)) return next();
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Referrer-Policy', 'no-referrer'); // don't leak dashboard URLs to other sites

    if (req.path === '/__login') {
      if (await isEditor(req)) return res.redirect(303, `${BASE}/`);
      const u = await webUser(req);
      res.setHeader('Cache-Control', 'no-store');
      return res.type('html').send(loginPage(u && u.role !== 'CATALOG_BOT' && u.email));
    }
    if (req.path === '/__whoami') return res.json({ viewer: await isViewer(req), editor: await isEditor(req), base: BASE });

    if (!(await isViewer(req))) {
      res.setHeader('Cache-Control', 'no-store');
      const isPage = req.method === 'GET' && (req.path === '/' || req.path.endsWith('.html'));
      if (isPage) return res.redirect(303, `${BASE}/__login`);
      return res.status(401).json({ error: 'ต้องเข้าสู่ระบบเว็บ tasaki.co.th ก่อน', login: `${BASE}/__login` });
    }

    if (!['GET', 'HEAD'].includes(req.method) && !(await isEditor(req))) {
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
  console.log(`Public view-only access on ${BASE} (editing: website login as ${EDITORS.join(', ') || 'nobody'})`);
}

