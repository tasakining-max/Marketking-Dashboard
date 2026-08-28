const themeToggleBtn = document.getElementById('themeToggleBtn');

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  themeToggleBtn.textContent = theme === 'dark' ? '☀️' : '🌙';
  localStorage.setItem('theme', theme);
}

applyTheme(document.documentElement.getAttribute('data-theme') || 'light');

themeToggleBtn.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  applyTheme(current === 'dark' ? 'light' : 'dark');
});

// ─── Auto-post report ───────────────────────────────────────────────────
const PLATFORM_LABELS = { facebook: 'Facebook', instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube' };
const PLATFORM_ICONS = {
  facebook: '/assets/facebook.png',
  instagram: '/assets/instagram.jpeg',
  tiktok: '/assets/tiktok.jpg',
  youtube: '/assets/youtube.png',
};
const STATUS_LABELS = { success: '✓ สำเร็จ', failed: '✕ ล้มเหลว', pending: '… กำลังโพสต์', dry_run: '🧪 Dry-run (ยังไม่โพสต์จริง)', manual: '📝 โพสเอง' };

function renderAutoPostLog(entries) {
  const empty = document.getElementById('autoPostEmpty');
  const content = document.getElementById('autoPostContent');
  const tbody = document.getElementById('autoPostTableBody');
  if (!entries.length) {
    empty.hidden = false;
    content.hidden = true;
    return;
  }
  empty.hidden = true;
  content.hidden = false;
  tbody.innerHTML = '';

  entries.forEach((e) => {
    const tr = document.createElement('tr');

    const dateTd = document.createElement('td');
    dateTd.textContent = new Date(e.postedAt).toLocaleString('th-TH', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    tr.appendChild(dateTd);

    const titleTd = document.createElement('td');
    titleTd.textContent = e.cardTitle;
    tr.appendChild(titleTd);

    const platformTd = document.createElement('td');
    const platformWrap = document.createElement('div');
    platformWrap.className = 'ads-platform-cell';
    if (PLATFORM_ICONS[e.platform]) {
      const img = document.createElement('img');
      img.src = PLATFORM_ICONS[e.platform];
      img.alt = '';
      img.width = 16;
      img.height = 16;
      platformWrap.appendChild(img);
    }
    const platformLabel = document.createElement('span');
    platformLabel.textContent = PLATFORM_LABELS[e.platform] || e.platform;
    platformWrap.appendChild(platformLabel);
    platformTd.appendChild(platformWrap);
    tr.appendChild(platformTd);

    const placementTd = document.createElement('td');
    placementTd.textContent = e.placement || 'Feed';
    tr.appendChild(placementTd);

    const statusTd = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = `ads-status-badge is-${e.status}`;
    badge.textContent = STATUS_LABELS[e.status] || e.status;
    statusTd.appendChild(badge);
    tr.appendChild(statusTd);

    const detailTd = document.createElement('td');
    if ((e.status === 'failed' || e.status === 'manual') && e.errorMessage) {
      const err = document.createElement('span');
      err.className = e.status === 'manual' ? 'ads-note-text' : 'ads-error-text';
      err.textContent = e.errorMessage;
      detailTd.appendChild(err);
    } else if (e.postUrl) {
      const link = document.createElement('a');
      link.href = e.postUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'ดูโพสต์ →';
      detailTd.appendChild(link);
    } else {
      detailTd.textContent = '—';
    }
    tr.appendChild(detailTd);

    tbody.appendChild(tr);
  });
}

let autoPostSignature = null;
async function fetchAutoPostLog() {
  const res = await fetch('/api/auto-post-log');
  const data = await res.json();
  const sig = JSON.stringify(data.entries);
  if (sig !== autoPostSignature) {
    autoPostSignature = sig;
    renderAutoPostLog(data.entries || []);
  }
}

fetchAutoPostLog();
setInterval(() => { if (!document.hidden) fetchAutoPostLog(); }, 30000);

document.getElementById('autoPostRefreshBtn').addEventListener('click', () => {
  autoPostSignature = null;
  fetchAutoPostLog();
});
