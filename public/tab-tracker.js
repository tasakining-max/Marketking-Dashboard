// Records "this profile had this tab open just now" — powers a private
// last-viewed-per-tab panel (see index.html). Silent no-op if no profile is
// set on this device yet.
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
  };

  // Visiting once with ?admin=1 remembers, on this device only, that the
  // last-viewed panel on index.html should render — the request that added
  // this feature explicitly asked it stay off everywhere else.
  if (new URLSearchParams(location.search).get('admin') === '1') {
    localStorage.setItem('show_tab_tracker', '1');
  }

  let profile;
  try { profile = JSON.parse(localStorage.getItem('dashboard_profile')); } catch { /* ignore */ }
  const name = profile && profile.name;
  if (!name) return;

  const page = PAGE_LABELS[location.pathname] || location.pathname;
  fetch('/api/tab-views', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileName: name, page }),
  }).catch(() => {});
})();
