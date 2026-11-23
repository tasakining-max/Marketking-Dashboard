// Loaded only on the public (tasaki.co.th) view. Shows view-only / editing
// state and turns a refused change into a clear message instead of a silent fail.
(function () {
  const base = location.pathname.split('/').slice(0, 2).join('/');
  const bar = document.createElement('div');
  bar.style.cssText = 'position:fixed;right:12px;bottom:calc(76px + env(safe-area-inset-bottom));z-index:9998;'
    + 'background:#001222;color:#fff;font:600 13px/1.3 system-ui,sans-serif;padding:8px 12px;border-radius:999px;'
    + 'box-shadow:0 4px 16px rgba(0,0,0,.25);display:flex;gap:8px;align-items:center';
  const link = (href, text) => '<a href="' + base + href + '" style="color:#8FE3FF;text-decoration:underline">' + text + '</a>';
  fetch(base + '/__whoami', { cache: 'no-store' }).then((r) => r.json()).then((w) => {
    bar.innerHTML = w.editor ? '✏️ แก้ไขได้' : '👀 ดูอย่างเดียว (บัญชีนี้แก้ไขไม่ได้)';
    document.body.appendChild(bar);
  }).catch(() => {});

  const origFetch = window.fetch.bind(window);
  let warned = 0;
  window.fetch = async function (input, init) {
    const res = await origFetch(input, init);
    const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    if (res.status === 401 && method !== 'GET' && Date.now() - warned > 5000) {
      warned = Date.now();
      window.alert('บัญชีนี้ดูได้อย่างเดียว แก้ไขไม่ได้');
    }
    return res;
  };
})();
