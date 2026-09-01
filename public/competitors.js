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

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatLogDate(iso) {
  const d = new Date(iso);
  return d.toLocaleString('th-TH', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtNum(n) { return Math.round(Number(n) || 0).toLocaleString('th-TH'); }

// ─── 1. Meta Ads ──────────────────────────────────────────────────────────
async function loadMetaAds() {
  try {
    const res = await fetch('/api/competitor-metrics?section=meta_ads');
    const { entries } = await res.json();
    const body = document.getElementById('metaAdsBody');
    const sorted = [...entries].sort((a, b) => (Number(b.value) || 0) - (Number(a.value) || 0));
    body.innerHTML = sorted.map((e) => `
      <tr>
        <td>${escapeHtml(e.brand)}</td>
        <td class="ads-num">${fmtNum(e.value)} ตัว</td>
        <td>${e.verified
          ? '<span class="ads-status-badge is-success">✓ ยืนยันแล้ว</span>'
          : '<span class="ads-status-badge is-pending">⚠️ ยังไม่ยืนยัน</span>'}</td>
        <td>${formatLogDate(e.checkedAt)}</td>
        <td><button type="button" class="ads-action-log-delete" data-id="${e.id}" data-kind="meta_ads" title="ลบ">✕</button></td>
      </tr>
    `).join('');
    wireDeleteButtons();
  } catch (e) { console.error('Failed to load meta ads metrics:', e.message); }
}

document.getElementById('metaAdsAddForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const brand = document.getElementById('metaAdsBrandInput').value.trim();
  const value = document.getElementById('metaAdsValueInput').value;
  const verified = document.getElementById('metaAdsVerifiedInput').checked;
  if (!brand || value === '') return;
  await fetch('/api/competitor-metrics', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ section: 'meta_ads', brand, value, verified }),
  });
  document.getElementById('metaAdsBrandInput').value = '';
  document.getElementById('metaAdsValueInput').value = '';
  document.getElementById('metaAdsVerifiedInput').checked = false;
  loadMetaAds();
});

document.getElementById('metaAdsRefreshBtn').addEventListener('click', loadMetaAds);

// ─── 2. Website — AI Search ─────────────────────────────────────────────
const AI_SEARCH_LABELS = {
  open: { text: '✅ เปิด', cls: 'is-success' },
  blocked: { text: '⛔ ปิด', cls: 'is-failed' },
  unknown: { text: '❓ ไม่ทราบ', cls: 'is-pending' },
};

function scoreBadgeClass(score) {
  if (score == null) return 'is-manual';
  if (score >= 90) return 'is-success';
  if (score >= 50) return 'is-pending';
  return 'is-failed';
}

async function loadAiSearch() {
  try {
    const res = await fetch('/api/competitor-metrics?section=ai_search');
    const { entries } = await res.json();
    const body = document.getElementById('aiSearchBody');
    const sorted = [...entries].sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
    body.innerHTML = sorted.map((e) => {
      const label = AI_SEARCH_LABELS[e.value] || AI_SEARCH_LABELS.unknown;
      const scoreText = e.score != null ? `${e.score}/100` : '—';
      return `
      <tr>
        <td>${escapeHtml(e.brand)}</td>
        <td><span class="ads-status-badge ${scoreBadgeClass(e.score)}">${scoreText}</span></td>
        <td><span class="ads-status-badge ${label.cls}">${label.text}</span></td>
        <td style="white-space:normal; max-width:320px; color:var(--muted); font-size:12px;">${escapeHtml(e.note || '—')}</td>
        <td>${formatLogDate(e.checkedAt)}</td>
        <td><button type="button" class="ads-action-log-delete" data-id="${e.id}" data-kind="ai_search" title="ลบ">✕</button></td>
      </tr>
    `;
    }).join('');
    wireDeleteButtons();
  } catch (e) { console.error('Failed to load AI search metrics:', e.message); }
}

const AI_SEARCH_DEFAULT_SCORE = { open: 100, blocked: 0, unknown: null };

document.getElementById('aiSearchAddForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const brand = document.getElementById('aiSearchBrandInput').value.trim();
  const value = document.getElementById('aiSearchValueInput').value;
  const note = document.getElementById('aiSearchNoteInput').value.trim();
  const scoreOverrideRaw = document.getElementById('aiSearchScoreInput').value;
  const score = scoreOverrideRaw !== '' ? Number(scoreOverrideRaw) : AI_SEARCH_DEFAULT_SCORE[value];
  if (!brand) return;
  await fetch('/api/competitor-metrics', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ section: 'ai_search', brand, value, score, note, verified: true }),
  });
  document.getElementById('aiSearchBrandInput').value = '';
  document.getElementById('aiSearchNoteInput').value = '';
  document.getElementById('aiSearchScoreInput').value = '';
  loadAiSearch();
});

// ─── Shared delete wiring ────────────────────────────────────────────────
function wireDeleteButtons() {
  document.querySelectorAll('.ads-action-log-delete[data-kind]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await fetch(`/api/competitor-metrics/${btn.dataset.id}`, { method: 'DELETE' });
      if (btn.dataset.kind === 'meta_ads') loadMetaAds();
      else loadAiSearch();
    });
  });
}

// ─── 3. Website — Google Ads / SEO notes ────────────────────────────────
async function loadSeoNotes() {
  try {
    const res = await fetch('/api/competitor-seo-notes');
    const { entries } = await res.json();
    const list = document.getElementById('seoNotesList');
    const empty = document.getElementById('seoNotesEmpty');
    if (!entries.length) {
      list.innerHTML = '';
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    list.innerHTML = entries.map((e) => `
      <li class="ads-action-log-item">
        <div class="ads-action-log-text">${escapeHtml(e.text).replace(/\n/g, '<br>')}</div>
        <div class="ads-action-log-meta">
          <span>${formatLogDate(e.createdAt)}</span>
          <button type="button" class="ads-action-log-delete" data-id="${e.id}" title="ลบ">✕</button>
        </div>
      </li>
    `).join('');
    list.querySelectorAll('.ads-action-log-delete').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await fetch(`/api/competitor-seo-notes/${btn.dataset.id}`, { method: 'DELETE' });
        loadSeoNotes();
      });
    });
  } catch (e) { console.error('Failed to load SEO notes:', e.message); }
}

// ─── 3. SEO keyword checklist ───────────────────────────────────────────
async function loadSeoKeywords() {
  try {
    const res = await fetch('/api/seo-keywords');
    const { entries } = await res.json();
    const tbody = document.getElementById('seoKeywordBody');
    const progress = document.getElementById('seoKeywordProgress');
    const hitCount = entries.filter((e) => e.organic || e.ads).length;
    progress.textContent = `ติดแล้ว ${hitCount}/${entries.length} คำ`;

    tbody.innerHTML = entries.map((e) => `
      <tr data-id="${e.id}">
        <td>${escapeHtml(e.keyword)}</td>
        <td>${escapeHtml(e.category || '-')}</td>
        <td class="ads-num"><input type="checkbox" class="kw-organic" ${e.organic ? 'checked' : ''} /></td>
        <td class="ads-num"><input type="checkbox" class="kw-ads" ${e.ads ? 'checked' : ''} /></td>
        <td>${e.checkedAt ? formatLogDate(e.checkedAt) : '-'}</td>
        <td><input type="text" class="kw-note" value="${escapeHtml(e.note || '')}" placeholder="โน้ต..." style="width:100%; border:none; background:transparent; font-size:12px;" /></td>
        <td><button type="button" class="ads-action-log-delete kw-delete" title="ลบ">✕</button></td>
      </tr>
    `).join('');

    tbody.querySelectorAll('tr').forEach((tr) => {
      const id = tr.dataset.id;
      tr.querySelector('.kw-organic').addEventListener('change', async (ev) => {
        await fetch(`/api/seo-keywords/${id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ organic: ev.target.checked }),
        });
        loadSeoKeywords();
      });
      tr.querySelector('.kw-ads').addEventListener('change', async (ev) => {
        await fetch(`/api/seo-keywords/${id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ads: ev.target.checked }),
        });
        loadSeoKeywords();
      });
      tr.querySelector('.kw-note').addEventListener('change', async (ev) => {
        await fetch(`/api/seo-keywords/${id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ note: ev.target.value }),
        });
      });
      tr.querySelector('.kw-delete').addEventListener('click', async () => {
        await fetch(`/api/seo-keywords/${id}`, { method: 'DELETE' });
        loadSeoKeywords();
      });
    });
  } catch (e) { console.error('Failed to load SEO keywords:', e.message); }
}

document.getElementById('seoKeywordAddForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const kwInput = document.getElementById('seoKeywordInput');
  const catInput = document.getElementById('seoKeywordCategoryInput');
  const keyword = kwInput.value.trim();
  if (!keyword) return;
  await fetch('/api/seo-keywords', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyword, category: catInput.value.trim() }),
  });
  kwInput.value = '';
  catInput.value = '';
  loadSeoKeywords();
});

document.getElementById('seoKeywordRefreshBtn').addEventListener('click', loadSeoKeywords);
loadSeoKeywords();

document.getElementById('seoNoteForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('seoNoteInput');
  const text = input.value.trim();
  if (!text) return;
  await fetch('/api/competitor-seo-notes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  input.value = '';
  loadSeoNotes();
});

loadMetaAds();
loadAiSearch();
loadSeoNotes();
