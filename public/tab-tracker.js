// Tells the server "this profile has this page open". Only sends when the
// device has a profile. Reading it back is private (see lib/tabTracker.js).
(function () {
  const PAGE_LABELS = {
    '/index.html': '🎥 VDO', '/': '🎥 VDO',
    '/auto-post.html': '🤖 Auto Post',
    '/graphic-design.html': '🎨 Graphic Design',
    '/report.html': '📅 Reports',
    '/ads.html': '📈 Ads',
    '/insights.html': '📹 Insights',
    '/website.html': '🌐 เว็บไซต์',
    '/competitors.html': '🕵️ ส่องคู่แข่ง',
    '/agents.html': '🧑‍💼 ทีม AI',
  };

  let profile;
  try { profile = JSON.parse(localStorage.getItem('dashboard_profile')); } catch { /* ignore */ }
  // No profile picked on this device: still recorded, as "ไม่ระบุชื่อ" plus a short
  // random device code so one unknown device stays one line.
  let name = profile && profile.name;
  if (!name) {
    let code = '';
    try {
      code = localStorage.getItem('tracker_device') || Math.random().toString(36).slice(2, 6);
      localStorage.setItem('tracker_device', code);
    } catch { code = 'xxxx'; }
    name = `ไม่ระบุชื่อ #${code}`;
  }

  const page = PAGE_LABELS[location.pathname] || location.pathname;
  const send = (kind) => fetch('/api/tab-views', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileName: name, page, kind }),
  }).catch(() => {});

  send('view');
  setInterval(() => { if (!document.hidden) send('beat'); }, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) send('beat'); });
})();

// Private "who viewed this page" badge. It only exists on a device that holds
// the key (open any page once with #key=... in the address); everyone else gets
// a 404 from the server and never sees anything.
(function () {
  const m = /[#&]key=([^&]+)/.exec(location.hash);
  let key = '';
  try {
    if (m) { localStorage.setItem('tracker_key', decodeURIComponent(m[1])); history.replaceState(null, '', location.pathname + location.search); }
    key = localStorage.getItem('tracker_key') || '';
  } catch { /* no storage */ }
  if (!key) return;

  const PAGE = (window.__trackerPageLabel) || null; // set below from the same labels
  const labels = {
    '/index.html': '🎥 VDO', '/': '🎥 VDO', '/auto-post.html': '🤖 Auto Post', '/graphic-design.html': '🎨 Graphic Design',
    '/report.html': '📅 Reports', '/ads.html': '📈 Ads', '/insights.html': '📹 Insights', '/website.html': '🌐 เว็บไซต์',
    '/competitors.html': '🕵️ ส่องคู่แข่ง', '/agents.html': '🧑‍💼 ทีม AI',
  };
  const page = PAGE || labels[location.pathname] || location.pathname;

  const css = document.createElement('style');
  css.textContent = `
    .vw-badge { position: fixed; left: 14px; bottom: 14px; z-index: 900; font: 13px/1.4 -apple-system, "Segoe UI", sans-serif; }
    .vw-btn { border: 1px solid var(--border, #ccc); background: var(--card-bg, #fff); color: var(--text, #222); border-radius: 999px; padding: 6px 12px; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.15); }
    .vw-btn b { color: #16a34a; }
    .vw-panel { position: absolute; left: 0; bottom: 40px; width: 300px; max-height: 60vh; overflow: auto; background: var(--card-bg, #fff); color: var(--text, #222); border: 1px solid var(--border, #ccc); border-radius: 10px; padding: 10px 12px; box-shadow: 0 6px 24px rgba(0,0,0,.25); }
    .vw-panel h4 { margin: 8px 0 4px; font-size: 12px; color: var(--muted, #666); }
    .vw-panel h4:first-child { margin-top: 0; }
    .vw-row { display: flex; justify-content: space-between; gap: 10px; padding: 3px 0; border-top: 1px solid var(--border, #eee); }
    .vw-row span:last-child { color: var(--muted, #666); white-space: nowrap; }
    .vw-live { color: #16a34a; font-weight: 600; }
    @media print { .vw-badge { display: none; } }`;
  document.head.append(css);

  const box = document.createElement('div');
  box.className = 'vw-badge';
  const btn = document.createElement('button');
  btn.type = 'button'; btn.className = 'vw-btn'; btn.textContent = '👀';
  const panel = document.createElement('div');
  panel.className = 'vw-panel'; panel.hidden = true;
  box.append(panel, btn);
  btn.addEventListener('click', () => { panel.hidden = !panel.hidden; });

  const when = (iso) => {
    const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'เมื่อสักครู่';
    if (s < 3600) return `${Math.round(s / 60)} นาทีที่แล้ว`;
    if (s < 86400) return `${Math.round(s / 3600)} ชม.ที่แล้ว`;
    return new Date(iso).toLocaleString('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' });
  };
  const row = (a, b, cls) => { const r = document.createElement('div'); r.className = 'vw-row'; const x = document.createElement('span'); x.textContent = a; if (cls) x.className = cls; const y = document.createElement('span'); y.textContent = b; r.append(x, y); return r; };
  const head = (t) => { const h = document.createElement('h4'); h.textContent = t; return h; };

  async function load() {
    try {
      const res = await fetch('/api/tab-activity', { headers: { 'x-tracker-key': key } });
      if (!res.ok) { box.remove(); return; }
      const d = await res.json();
      if (!box.isConnected) document.body.append(box);
      const here = d.now.filter((r) => r.page === page);
      const last = d.last.filter((r) => r.page === page).sort((a, b) => new Date(b.viewedAt) - new Date(a.viewedAt));
      const hist = d.history.filter((r) => r.page === page).slice(0, 12);
      btn.replaceChildren(document.createTextNode('👀 '), Object.assign(document.createElement('b'), { textContent: here.length ? `${here.length} อยู่ตอนนี้` : `${new Set(last.map((r) => r.profileName)).size} คนเคยเข้า` }));
      panel.replaceChildren(
        head(`หน้า ${page} · อยู่ตอนนี้`),
        ...(here.length ? here.map((r) => row(r.profileName, when(r.viewedAt), 'vw-live')) : [row('ไม่มีใครอยู่', '')]),
        head('ใครเข้าล่าสุด'),
        ...(last.length ? last.map((r) => row(r.profileName, when(r.viewedAt))) : [row('ยังไม่มีข้อมูล', '')]),
        head('ประวัติการเปิดหน้านี้'),
        ...(hist.length ? hist.map((r) => row(r.profileName, when(r.at))) : [row('ยังไม่มีประวัติ', '')]));
    } catch { /* keep what is shown */ }
  }
  load();
  setInterval(() => { if (!document.hidden) load(); }, 20000);
})();
