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

// Polling keeps the Neon database endpoint continuously active, which is billed
// by compute time — a tab left open in a background browser tab would otherwise
// poll forever and never let the database go idle. registerPoll() skips fetches
// while the tab is hidden and catches up immediately when it becomes visible again.
const POLL_INTERVAL_MS = 30000;
const pollFns = [];
function registerPoll(fn) {
  pollFns.push(fn);
  setInterval(() => { if (!document.hidden) fn(); }, POLL_INTERVAL_MS);
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) pollFns.forEach((fn) => fn());
});

function loadProfile() {
  try { return JSON.parse(localStorage.getItem('dashboard_profile')) || {}; } catch { return {}; }
}

function renderAvatar(el, name, imageUrl) {
  el.innerHTML = '';
  if (imageUrl) {
    const img = document.createElement('img');
    img.src = imageUrl;
    img.alt = name || '';
    el.appendChild(img);
    el.style.background = 'none';
  } else if (name && name.trim()) {
    el.textContent = name.trim().charAt(0).toUpperCase();
    el.style.background = '';
  } else {
    el.innerHTML = '<svg width="55%" height="55%" viewBox="0 0 24 24" fill="currentColor"><path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"/></svg>';
    el.style.background = '';
  }
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

function fmtNum(n) { return Math.round(n).toLocaleString('th-TH'); }
function fmtPct(n) { return n.toFixed(1) + '%'; }
function fmtDate(d) { return new Date(d + 'T12:00:00').toLocaleDateString('th-TH', { month: 'short', day: 'numeric' }); }

function niceMax(value) {
  if (value <= 0) return 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
  const residual = value / magnitude;
  const step = residual > 5 ? 10 : residual > 2 ? 5 : residual > 1 ? 2 : 1;
  return step * magnitude;
}

// ─── Traffic source classification ─────────────────────────────────────
function classifySource(referrer) {
  if (!referrer) return 'เข้าตรง (Direct)';
  let host = '';
  try { host = new URL(referrer).hostname.toLowerCase(); } catch { host = referrer.toLowerCase(); }
  if (host.includes('tasaki.co.th') || host.includes('localhost')) return 'ภายในเว็บ (Internal)';
  if (host.includes('google')) return 'Google (ค้นหา)';
  if (host.includes('bing')) return 'Bing (ค้นหา)';
  if (host.includes('facebook') || host.includes('fb.com') || host === 'l.facebook.com') return 'Facebook';
  if (host.includes('instagram')) return 'Instagram';
  if (host.includes('line')) return 'LINE';
  if (host.includes('tiktok')) return 'TikTok';
  if (host.includes('youtube')) return 'YouTube';
  return host || 'อื่นๆ';
}

function aggregateSources(referrers) {
  const map = new Map();
  referrers.forEach((r) => {
    const source = classifySource(r.referrer);
    map.set(source, (map.get(source) || 0) + r.views);
  });
  return [...map.entries()]
    .map(([source, views]) => ({ source, views }))
    .sort((a, b) => b.views - a.views);
}

// ─── KPI tiles ──────────────────────────────────────────────────────────
function renderStatTiles(data) {
  const total = data.totals.views || 0;
  const notFound = (data.statusBreakdown.find((s) => s.status === 404) || {}).views || 0;
  const adViews = (data.utmCampaigns || [])
    .filter((r) => r.medium === 'paid')
    .reduce((sum, r) => sum + r.views, 0);

  const tiles = [
    { label: 'เข้าชมทั้งหมด', value: fmtNum(total) },
    { label: 'ผู้เข้าชม (sessions)', value: fmtNum(data.totals.sessions || 0) },
    { label: 'เข้าชมจากโฆษณา (Ads)', value: `${fmtNum(adViews)} (${fmtPct(total ? (adViews / total) * 100 : 0)})` },
    { label: 'หน้าไม่พบ (404)', value: fmtNum(notFound) },
  ];

  const grid = document.getElementById('siteStatGrid');
  grid.innerHTML = '';
  tiles.forEach((t) => {
    const tile = document.createElement('div');
    tile.className = 'ads-stat-tile';
    const label = document.createElement('p');
    label.className = 'ads-stat-label';
    label.textContent = t.label;
    const value = document.createElement('p');
    value.className = 'ads-stat-value';
    value.textContent = t.value;
    tile.appendChild(label);
    tile.appendChild(value);
    grid.appendChild(tile);
  });
}

function renderInsights(data) {
  const rows = document.getElementById('siteInsightRows');
  rows.innerHTML = '';
  const insights = [];

  const topPage = data.topPages[0];
  if (topPage) {
    insights.push({
      type: 'good', icon: '✅',
      text: `หน้าที่มีคนเข้าดูมากสุดคือ "${topPage.path}" (${fmtNum(topPage.views)} ครั้ง)`,
    });
  }

  const notFound = (data.statusBreakdown.find((s) => s.status === 404) || {}).views || 0;
  if (notFound > 0) {
    insights.push({
      type: 'warning', icon: '⚠️',
      text: `มีการเข้าหน้าที่ไม่พบ (404) ${fmtNum(notFound)} ครั้ง — น่าจะมีลิงก์เสียหรือ URL เก่าที่ยังมีคนคลิกเข้ามา`,
    });
  }

  const utmRows = data.utmCampaigns || [];
  const fbClicks = utmRows.filter((r) => r.source === 'facebook').reduce((sum, r) => sum + r.views, 0);
  if (fbClicks > 0) {
    insights.push({
      type: 'good', icon: '📣',
      text: `มีคนคลิกจากโฆษณา Facebook ที่ติด UTM เข้าเว็บแล้ว ${fmtNum(fbClicks)} ครั้ง`,
    });
  }
  const aiReferralSources = ['chatgpt.com', 'chat.openai.com', 'perplexity.ai', 'claude.ai', 'gemini.google.com', 'copilot.microsoft.com'];
  const aiReferralRows = utmRows.filter((r) => aiReferralSources.includes(r.source));
  const aiReferralViews = aiReferralRows.reduce((sum, r) => sum + r.views, 0);
  if (aiReferralViews > 0) {
    const names = [...new Set(aiReferralRows.map((r) => r.source))].join(', ');
    insights.push({
      type: 'good', icon: '🤖',
      text: `AI Search ส่งคนเข้าเว็บจริงแล้ว ${fmtNum(aiReferralViews)} ครั้ง (จาก ${names}) — สัญญาณว่างาน AI Search citability เริ่มเห็นผล`,
    });
  }

  const daily = data.daily;
  if (daily.length >= 2) {
    const last = daily[daily.length - 1];
    const prev = daily[daily.length - 2];
    const change = prev.views > 0 ? ((last.views - prev.views) / prev.views) * 100 : 0;
    const dir = change >= 0 ? 'เพิ่มขึ้น' : 'ลดลง';
    insights.push({
      type: 'neutral', icon: change >= 0 ? '📈' : '📉',
      text: `ยอดเข้าชมวันล่าสุด ${dir} ${Math.abs(change).toFixed(1)}% เทียบกับวันก่อนหน้า`,
    });
  }

  insights.forEach((ins) => {
    const row = document.createElement('div');
    row.className = `ads-insight-row is-${ins.type}`;
    const icon = document.createElement('span');
    icon.className = 'ads-insight-icon';
    icon.textContent = ins.icon;
    const text = document.createElement('span');
    text.textContent = ins.text;
    row.appendChild(icon);
    row.appendChild(text);
    rows.appendChild(row);
  });
}

// ─── Daily trend line chart ─────────────────────────────────────────────
function renderTrendChart(data) {
  const container = document.getElementById('siteTrendChart');
  container.innerHTML = '';
  const points = data.daily;
  if (!points.length) return;

  const W = 760, H = 220;
  const padL = 56, padR = 50, padT = 16, padB = 30;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const maxViews = niceMax(Math.max(...points.map((p) => p.views)) * 1.15);

  const x = (i) => padL + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const y = (v) => padT + plotH - (v / maxViews) * plotH;

  const svg = svgEl('svg', { class: 'ads-chart-svg', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'แนวโน้มการเข้าชมรายวัน' });

  const gridSteps = 4;
  for (let i = 0; i <= gridSteps; i++) {
    const v = (maxViews / gridSteps) * i;
    const gy = y(v);
    svg.appendChild(svgEl('line', { class: 'ads-grid-line', x1: padL, x2: W - padR, y1: gy, y2: gy }));
    const label = svgEl('text', { class: 'ads-axis-label', x: padL - 8, y: gy + 4, 'text-anchor': 'end' });
    label.textContent = fmtNum(v);
    svg.appendChild(label);
  }

  const labelEvery = Math.ceil(points.length / 10);
  points.forEach((p, i) => {
    if (i % labelEvery !== 0 && i !== points.length - 1) return;
    const label = svgEl('text', { class: 'ads-axis-label', x: x(i), y: H - 8, 'text-anchor': 'middle' });
    label.textContent = fmtDate(p.date);
    svg.appendChild(label);
  });

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(p.views)}`).join(' ');
  const areaPath = `${linePath} L ${x(points.length - 1)} ${y(0)} L ${x(0)} ${y(0)} Z`;
  svg.appendChild(svgEl('path', { class: 'ads-area-fill', d: areaPath }));
  svg.appendChild(svgEl('path', { class: 'ads-line-mark', d: linePath }));

  const lastIdx = points.length - 1;
  svg.appendChild(svgEl('circle', { class: 'ads-end-dot', cx: x(lastIdx), cy: y(points[lastIdx].views), r: 5 }));
  const endLabel = svgEl('text', {
    class: 'ads-end-label', x: x(lastIdx) + 8, y: y(points[lastIdx].views) - 8,
    'text-anchor': lastIdx === 0 ? 'middle' : 'end',
  });
  endLabel.textContent = fmtNum(points[lastIdx].views);
  svg.appendChild(endLabel);

  const crosshair = svgEl('line', { class: 'ads-crosshair', x1: 0, x2: 0, y1: padT, y2: H - padB });
  svg.appendChild(crosshair);

  const hitRect = svgEl('rect', { x: padL, y: padT, width: plotW, height: plotH, fill: 'transparent' });
  svg.appendChild(hitRect);

  container.appendChild(svg);

  const tooltip = document.createElement('div');
  tooltip.className = 'ads-chart-tooltip';
  container.appendChild(tooltip);

  function showAt(i) {
    const p = points[i];
    crosshair.setAttribute('x1', x(i));
    crosshair.setAttribute('x2', x(i));
    crosshair.style.opacity = '1';
    tooltip.innerHTML = '';
    const row = document.createElement('div');
    row.className = 'tt-row';
    const lbl = document.createElement('span');
    lbl.className = 'tt-label';
    lbl.textContent = fmtDate(p.date);
    const val = document.createElement('span');
    val.className = 'tt-value';
    val.textContent = `${fmtNum(p.views)} ครั้ง`;
    row.appendChild(lbl);
    row.appendChild(val);
    tooltip.appendChild(row);
    tooltip.classList.add('visible');
    const svgRect = svg.getBoundingClientRect();
    const scale = svgRect.width / W;
    tooltip.style.left = Math.min(x(i) * scale, svgRect.width - 110) + 'px';
    tooltip.style.top = (y(p.views) * scale - 50) + 'px';
  }
  function hide() {
    crosshair.style.opacity = '0';
    tooltip.classList.remove('visible');
  }

  hitRect.addEventListener('pointermove', (evt) => {
    const svgRect = svg.getBoundingClientRect();
    const relX = ((evt.clientX - svgRect.left) / svgRect.width) * W;
    let closest = 0, closestDist = Infinity;
    points.forEach((p, i) => {
      const dist = Math.abs(x(i) - relX);
      if (dist < closestDist) { closestDist = dist; closest = i; }
    });
    showAt(closest);
  });
  hitRect.addEventListener('pointerleave', hide);
}

// ─── Traffic sources bar chart ─────────────────────────────────────────
function renderSourceChart(data) {
  const container = document.getElementById('siteSourceChart');
  container.innerHTML = '';

  const sources = aggregateSources(data.referrers).slice(0, 8);
  if (!sources.length) return;
  const total = sources.reduce((s, x) => s + x.views, 0) || 1;

  const rowH = 34, barH = 18, labelW = 170;
  const W = 760, H = sources.length * rowH + 16;
  const plotW = W - labelW - 70;
  const maxViews = niceMax(Math.max(...sources.map((s) => s.views)) * 1.15);

  const svg = svgEl('svg', { class: 'ads-chart-svg', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'แหล่งที่มาของผู้เข้าชม' });

  sources.forEach((s, i) => {
    const cy = 16 + i * rowH;
    const barW = Math.max((s.views / maxViews) * plotW, 2);

    const nameLabel = svgEl('text', { class: 'ads-bar-name', x: 0, y: cy + barH / 2 + 4 });
    nameLabel.textContent = s.source;
    svg.appendChild(nameLabel);

    const bar = svgEl('rect', { class: 'ads-bar', x: labelW, y: cy, width: barW, height: barH, rx: 4 });
    svg.appendChild(bar);

    const valueLabel = svgEl('text', { class: 'ads-bar-label', x: labelW + barW + 8, y: cy + barH / 2 + 4 });
    valueLabel.textContent = `${fmtNum(s.views)} (${fmtPct((s.views / total) * 100)})`;
    svg.appendChild(valueLabel);
  });

  container.appendChild(svg);
}

// ─── Device breakdown ────────────────────────────────────────────────────
function renderDeviceGrid(data) {
  const grid = document.getElementById('siteDeviceGrid');
  grid.innerHTML = '';
  const total = data.devices.reduce((s, d) => s + d.views, 0) || 1;
  const labels = { desktop: '🖥️ เดสก์ท็อป', mobile: '📱 มือถือ' };

  data.devices.forEach((d) => {
    const tile = document.createElement('div');
    tile.className = 'ads-stat-tile';
    const label = document.createElement('p');
    label.className = 'ads-stat-label';
    label.textContent = labels[d.device] || d.device;
    const value = document.createElement('p');
    value.className = 'ads-stat-value';
    value.textContent = `${fmtNum(d.views)} (${fmtPct((d.views / total) * 100)})`;
    tile.appendChild(label);
    tile.appendChild(value);
    grid.appendChild(tile);
  });
}

// ─── Top pages table ─────────────────────────────────────────────────────
function renderTopPages(data) {
  const tbody = document.getElementById('siteTopPagesBody');
  tbody.innerHTML = '';
  const total = data.totals.views || 1;

  data.topPages.forEach((p, i) => {
    const tr = document.createElement('tr');
    [
      String(i + 1),
      p.path,
      fmtNum(p.views),
      fmtNum(p.sessions),
      fmtPct((p.views / total) * 100),
    ].forEach((val, idx) => {
      const td = document.createElement('td');
      td.textContent = val;
      if (idx >= 2) td.className = 'ads-num';
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
}

// ─── UTM campaigns table ────────────────────────────────────────────────
function renderUtmTable(data) {
  const tbody = document.getElementById('siteUtmBody');
  tbody.innerHTML = '';
  const rows = data.utmCampaigns || [];
  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 8;
    td.textContent = 'ยังไม่มีคลิกที่ติด UTM ในช่วงเวลานี้';
    td.style.textAlign = 'center';
    td.style.color = 'var(--text-muted, #888)';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }
  rows.forEach((r) => {
    const tr = document.createElement('tr');
    [
      r.source || '-',
      r.medium || '-',
      r.campaign || '-',
      r.content || '-',
      fmtNum(r.views),
      fmtNum(r.sessions),
      new Date(r.firstSeen).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' }),
      new Date(r.lastSeen).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' }),
    ].forEach((val, idx) => {
      const td = document.createElement('td');
      td.textContent = val;
      if (idx === 4 || idx === 5) td.className = 'ads-num';
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
}

// ─── Load + filter ────────────────────────────────────────────────────────
const siteEmpty = document.getElementById('siteEmpty');
const siteBody = document.getElementById('siteBody');
let currentDays = 30;

function renderAll(data) {
  if (!data.totals.views) {
    siteEmpty.hidden = false;
    siteBody.hidden = true;
    return;
  }
  siteEmpty.hidden = true;
  siteBody.hidden = false;
  renderStatTiles(data);
  renderInsights(data);
  renderTrendChart(data);
  renderSourceChart(data);
  renderUtmTable(data);
  renderDeviceGrid(data);
  renderTopPages(data);
}

async function fetchAndRender() {
  try {
    const res = await fetch(`/api/website-pageviews?days=${currentDays}`);
    const data = await res.json();
    renderAll(data);
  } catch (e) {
    console.error('Failed to load website page views', e);
  }
}

document.querySelectorAll('.cal-filter-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.cal-filter-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentDays = Number(btn.dataset.days);
    fetchAndRender();
  });
});

document.getElementById('siteRefreshBtn').addEventListener('click', fetchAndRender);

fetchAndRender();
setInterval(() => { if (!document.hidden) fetchAndRender(); }, 30000);

// ─── Tasaki Website Updates + Marketing System Updates panels ─────────────
const websiteChangelogList = document.getElementById('websiteChangelogList');
const websiteIssuesZone = document.getElementById('websiteIssuesZone');
const websiteIssuesCount = document.getElementById('websiteIssuesCount');
const websiteIssueAddInput = document.getElementById('websiteIssueAddInput');
const websiteIssueAddBtn = document.getElementById('websiteIssueAddBtn');
let websiteChangelogSignature = null;
let websiteIssuesSig = null;
let websiteIssues = {};
let websiteEntries = [];

async function fetchWebsiteChangelog() {
  const [changelogRes, issuesRes] = await Promise.all([
    fetch('/api/website-changelog'),
    fetch('/api/website-issues')
  ]);
  const data = await changelogRes.json();
  const issuesData = await issuesRes.json();
  const changelogSig = JSON.stringify(data.entries);
  const newIssuesSig = JSON.stringify(issuesData);
  if (changelogSig !== websiteChangelogSignature || newIssuesSig !== websiteIssuesSig) {
    websiteChangelogSignature = changelogSig;
    websiteIssuesSig = newIssuesSig;
    websiteIssues = issuesData;
    websiteEntries = data.entries || [];
    renderWebsiteIssuesZone();
    renderWebsiteChangelog(websiteEntries);
  }
}

function buildIssueComments(issue, entryKey) {
  const wrap = document.createElement('div');
  wrap.className = 'issue-comments-wrap';
  const comments = issue.comments || [];

  function renderComments() {
    wrap.innerHTML = '';

    comments.forEach((c) => {
      const myName = loadProfile().name;
      const isOwner = myName && c.authorName === myName;
      const cRow = document.createElement('div');
      cRow.className = 'issue-comment-row';

      const av = document.createElement('span');
      av.className = 'profile-avatar-xs';
      renderAvatar(av, c.authorName, c.authorImage);
      cRow.appendChild(av);

      const cBody = document.createElement('div');
      cBody.className = 'issue-comment-body';

      const cMeta = document.createElement('div');
      cMeta.className = 'issue-comment-meta';
      const cName = document.createElement('span');
      cName.className = 'entry-issue-author';
      cName.textContent = c.authorName || 'Unknown';
      cMeta.appendChild(cName);
      const cTime = document.createElement('span');
      cTime.className = 'entry-issue-time';
      cTime.textContent = c.createdAt ? new Date(c.createdAt).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' }) : '';
      cMeta.appendChild(cTime);

      if (isOwner) {
        const cActions = document.createElement('span');
        cActions.className = 'entry-issue-actions';
        const cEdit = document.createElement('button');
        cEdit.type = 'button';
        cEdit.className = 'entry-issue-action-btn';
        cEdit.textContent = 'แก้ไข';
        cEdit.addEventListener('click', (e) => {
          e.stopPropagation();
          const area = document.createElement('textarea');
          area.className = 'entry-issue-edit-area';
          area.value = c.text;
          const btnRow = document.createElement('div');
          btnRow.className = 'entry-issue-edit-btns';
          const saveBtn = document.createElement('button');
          saveBtn.type = 'button';
          saveBtn.className = 'entry-issue-edit-save';
          saveBtn.textContent = 'บันทึก';
          saveBtn.addEventListener('click', async (e2) => {
            e2.stopPropagation();
            const newText = area.value.trim();
            if (!newText) return;
            await fetch(`/api/website-issues/${entryKey}/${issue.id}/comments/${c.id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: newText })
            });
            c.text = newText;
            websiteIssuesSig = null;
            renderComments();
          });
          const cancelBtn = document.createElement('button');
          cancelBtn.type = 'button';
          cancelBtn.className = 'entry-issue-edit-cancel';
          cancelBtn.textContent = 'ยกเลิก';
          cancelBtn.addEventListener('click', (e2) => { e2.stopPropagation(); renderComments(); });
          btnRow.appendChild(saveBtn);
          btnRow.appendChild(cancelBtn);
          cTextEl.replaceWith(area);
          cBody.appendChild(btnRow);
          area.focus();
        });
        const cDel = document.createElement('button');
        cDel.type = 'button';
        cDel.className = 'entry-issue-action-btn entry-issue-action-delete';
        cDel.textContent = 'ลบ';
        cDel.addEventListener('click', async (e) => {
          e.stopPropagation();
          await fetch(`/api/website-issues/${entryKey}/${issue.id}/comments/${c.id}`, { method: 'DELETE' });
          comments.splice(comments.findIndex((x) => x.id === c.id), 1);
          websiteIssuesSig = null;
          renderComments();
        });
        cActions.appendChild(cEdit);
        cActions.appendChild(cDel);
        cMeta.appendChild(cActions);
      }

      const cTextEl = document.createElement('p');
      cTextEl.className = 'issue-comment-text';
      cTextEl.textContent = c.text;

      cBody.appendChild(cMeta);
      cBody.appendChild(cTextEl);

      if (c.link) {
        const cLink = document.createElement('a');
        cLink.className = 'issue-comment-link';
        cLink.href = c.link;
        cLink.target = '_blank';
        cLink.rel = 'noopener noreferrer';
        cLink.textContent = '🔗 ' + c.link.replace(/^https?:\/\//, '').split('/')[0];
        cLink.title = c.link;
        cLink.addEventListener('click', (e) => e.stopPropagation());
        cBody.appendChild(cLink);
      }

      cRow.appendChild(cBody);
      wrap.appendChild(cRow);
    });

    // add comment form
    const addRow = document.createElement('div');
    addRow.className = 'issue-comment-add-row';
    const av2 = document.createElement('span');
    av2.className = 'profile-avatar-xs';
    const myProfile = loadProfile();
    renderAvatar(av2, myProfile.name, myProfile.imageUrl);
    addRow.appendChild(av2);

    const inputCol = document.createElement('div');
    inputCol.className = 'issue-comment-input-col';

    const inputRow = document.createElement('div');
    inputRow.className = 'issue-comment-input-row';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'issue-comment-input';
    input.placeholder = 'เขียนความคิดเห็น...';
    input.maxLength = 500;

    const linkToggleBtn = document.createElement('button');
    linkToggleBtn.type = 'button';
    linkToggleBtn.className = 'issue-comment-link-btn';
    linkToggleBtn.title = 'แนบลิงก์';
    linkToggleBtn.textContent = '🔗';

    const sendBtn = document.createElement('button');
    sendBtn.type = 'button';
    sendBtn.className = 'issue-comment-send-btn';
    sendBtn.textContent = 'ส่ง';

    inputRow.appendChild(input);
    inputRow.appendChild(linkToggleBtn);
    inputRow.appendChild(sendBtn);
    inputCol.appendChild(inputRow);

    // link input (hidden by default)
    const linkRow = document.createElement('div');
    linkRow.className = 'issue-comment-link-row';
    linkRow.hidden = true;
    const linkInput = document.createElement('input');
    linkInput.type = 'url';
    linkInput.className = 'issue-comment-link-input';
    linkInput.placeholder = 'https://...';
    linkRow.appendChild(linkInput);
    inputCol.appendChild(linkRow);

    linkToggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      linkRow.hidden = !linkRow.hidden;
      linkToggleBtn.classList.toggle('active', !linkRow.hidden);
      if (!linkRow.hidden) linkInput.focus();
    });

    async function submitComment() {
      const text = input.value.trim();
      if (!text) return;
      const link = linkInput.value.trim() || null;
      const profile = loadProfile();
      const res = await fetch(`/api/website-issues/${entryKey}/${issue.id}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, link, authorName: profile.name || 'Anonymous', authorImage: profile.imageUrl || null })
      });
      const newComment = await res.json();
      comments.push(newComment);
      websiteIssuesSig = null;
      input.value = '';
      linkInput.value = '';
      linkRow.hidden = true;
      linkToggleBtn.classList.remove('active');
      renderComments();
    }

    sendBtn.addEventListener('click', (e) => { e.stopPropagation(); submitComment(); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); submitComment(); } });
    input.addEventListener('click', (e) => e.stopPropagation());
    linkInput.addEventListener('click', (e) => e.stopPropagation());

    addRow.appendChild(inputCol);
    wrap.appendChild(addRow);
  }

  renderComments();
  return wrap;
}

function renderWebsiteIssuesZone() {
  websiteIssuesZone.innerHTML = '';
  const allIssues = [];
  Object.entries(websiteIssues).forEach(([entryKey, list]) => {
    (list || []).forEach((issue) => {
      if (!Array.isArray(issue.comments)) issue.comments = [];
      if (issue.solved) return;
      allIssues.push({ issue, entryKey });
    });
  });

  websiteIssuesCount.textContent = allIssues.length ? `(${allIssues.length})` : '';

  if (!allIssues.length) {
    websiteIssuesZone.innerHTML = '<p class="empty-state" style="font-size:11px">ยังไม่มีปัญหา</p>';
    return;
  }

  allIssues.forEach(({ issue, entryKey }) => {
    const myName = loadProfile().name;
    const isOwner = myName && issue.authorName === myName;

    const row = document.createElement('div');
    row.className = 'website-issue-row';

    // ── issue header ──
    const issueHeader = document.createElement('div');
    issueHeader.className = 'website-issue-header-row';

    // click-to-edit text (owner only)
    const textEl = document.createElement('p');
    textEl.className = 'website-issue-text-main' + (isOwner ? ' is-editable' : '') + (issue.solved ? ' is-solved' : '');
    textEl.textContent = issue.text;
    if (isOwner) {
      textEl.title = 'คลิกเพื่อแก้ไข';
      textEl.addEventListener('click', (e) => {
        e.stopPropagation();
        const area = document.createElement('textarea');
        area.className = 'entry-issue-edit-area';
        area.value = issue.text;
        const btnRow = document.createElement('div');
        btnRow.className = 'entry-issue-edit-btns';
        const saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'entry-issue-edit-save';
        saveBtn.textContent = 'บันทึก';
        saveBtn.addEventListener('click', async (e2) => {
          e2.stopPropagation();
          const newText = area.value.trim();
          if (!newText) return;
          await fetch(`/api/website-issues/${entryKey}/${issue.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: newText })
          });
          issue.text = newText;
          websiteIssuesSig = null;
          renderWebsiteIssuesZone();
        });
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'entry-issue-edit-cancel';
        cancelBtn.textContent = 'ยกเลิก';
        cancelBtn.addEventListener('click', (e2) => { e2.stopPropagation(); renderWebsiteIssuesZone(); });
        btnRow.appendChild(saveBtn);
        btnRow.appendChild(cancelBtn);
        const wrap = document.createElement('div');
        wrap.className = 'issue-edit-wrap';
        wrap.appendChild(area);
        wrap.appendChild(btnRow);
        textEl.replaceWith(wrap);
        area.focus();
        area.setSelectionRange(area.value.length, area.value.length);
      });
    }
    issueHeader.appendChild(textEl);

    // ── ⋯ menu button ──
    const menuWrap = document.createElement('div');
    menuWrap.className = 'issue-menu-wrap';

    const menuBtn = document.createElement('button');
    menuBtn.type = 'button';
    menuBtn.className = 'issue-menu-btn';
    menuBtn.textContent = '⋯';

    const dropdown = document.createElement('div');
    dropdown.className = 'issue-menu-dropdown';
    dropdown.hidden = true;

    const commentsWrap = buildIssueComments(issue, entryKey);
    commentsWrap.hidden = true;

    const commentCount = (issue.comments || []).length;
    const commentsOpt = document.createElement('button');
    commentsOpt.type = 'button';
    commentsOpt.className = 'issue-menu-opt';
    commentsOpt.textContent = `💬 ความคิดเห็น${commentCount ? ` (${commentCount})` : ''}`;
    commentsOpt.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdown.hidden = true;
      commentsWrap.hidden = !commentsWrap.hidden;
    });
    dropdown.appendChild(commentsOpt);

    if (isOwner) {
      const deleteOpt = document.createElement('button');
      deleteOpt.type = 'button';
      deleteOpt.className = 'issue-menu-opt issue-menu-opt-delete';
      deleteOpt.textContent = '🗑 ลบปัญหา';
      deleteOpt.addEventListener('click', async (e) => {
        e.stopPropagation();
        dropdown.hidden = true;
        await fetch(`/api/website-issues/${entryKey}/${issue.id}`, { method: 'DELETE' });
        if (websiteIssues[entryKey]) {
          websiteIssues[entryKey] = websiteIssues[entryKey].filter((i) => i.id !== issue.id);
        }
        websiteIssuesSig = null;
        renderWebsiteIssuesZone();
      });
      dropdown.appendChild(deleteOpt);
    }

    const solvedOpt = document.createElement('button');
    solvedOpt.type = 'button';
    solvedOpt.className = 'issue-menu-opt issue-menu-opt-solved';
    solvedOpt.textContent = issue.solved ? '↩ ยังไม่แก้' : '✅ แก้แล้ว';
    solvedOpt.addEventListener('click', async (e) => {
      e.stopPropagation();
      dropdown.hidden = true;
      const newSolved = !issue.solved;
      await fetch(`/api/website-issues/${entryKey}/${issue.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ solved: newSolved })
      });
      issue.solved = newSolved;
      websiteIssuesSig = null;
      renderWebsiteIssuesZone();
    });
    dropdown.appendChild(solvedOpt);

    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      dropdown.hidden = !dropdown.hidden;
    });
    document.addEventListener('click', () => { dropdown.hidden = true; }, { once: false });

    menuWrap.appendChild(menuBtn);
    menuWrap.appendChild(dropdown);
    issueHeader.appendChild(menuWrap);

    row.appendChild(issueHeader);
    row.appendChild(commentsWrap);
    websiteIssuesZone.appendChild(row);
  });
}

async function submitWebsiteIssue() {
  const text = websiteIssueAddInput.value.trim();
  if (!text) return;
  const profile = loadProfile();
  const authorName = profile.name || 'Anonymous';
  const authorImage = profile.imageUrl || null;
  const res = await fetch('/api/website-issues/general', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, authorName, authorImage })
  });
  const newIssue = await res.json();
  if (!websiteIssues.general) websiteIssues.general = [];
  websiteIssues.general.push(newIssue);
  websiteIssuesSig = null;
  websiteIssueAddInput.value = '';
  renderWebsiteIssuesZone();
}

websiteIssueAddBtn.addEventListener('click', submitWebsiteIssue);
websiteIssueAddInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); submitWebsiteIssue(); }
});

function renderChangelogEntries(container, entries) {
  container.innerHTML = '';
  if (!entries.length) {
    container.innerHTML = '<p class="empty-state">No updates logged yet.</p>';
    return;
  }
  const cutoff = Date.now() - 8 * 60 * 60 * 1000;

  function entryTimestamp(e) {
    return new Date(e.datetime || e.date).getTime();
  }

  function formatEntryDate(e) {
    const d = new Date(e.datetime || e.date);
    return d.toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' });
  }

  [...entries].sort((a, b) => entryTimestamp(b) - entryTimestamp(a)).forEach((entry) => {
    const isNew = entryTimestamp(entry) >= cutoff;
    const item = document.createElement('div');
    item.className = 'changelog-entry' + (isNew ? ' is-new' : '');
    const topRow = document.createElement('div');
    topRow.className = 'changelog-top-row';
    const date = document.createElement('p');
    date.className = 'changelog-date';
    date.textContent = formatEntryDate(entry);
    topRow.appendChild(date);
    if (isNew) {
      const badge = document.createElement('span');
      badge.className = 'changelog-new-badge';
      badge.textContent = 'NEW';
      topRow.appendChild(badge);
    }
    item.appendChild(topRow);
    const feature = document.createElement('p');
    feature.className = 'changelog-feature';
    feature.textContent = entry.feature;
    feature.addEventListener('click', () => feature.classList.toggle('expanded'));
    item.appendChild(feature);
    container.appendChild(item);
  });
}

function renderWebsiteChangelog(entries) {
  renderChangelogEntries(websiteChangelogList, entries);
}

fetchWebsiteChangelog();
registerPoll(fetchWebsiteChangelog);

function spinRefreshBtn(btn) {
  btn.classList.add('spinning');
  setTimeout(() => btn.classList.remove('spinning'), 500);
}

const websiteChangelogRefreshBtn = document.getElementById('websiteChangelogRefreshBtn');
websiteChangelogRefreshBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  spinRefreshBtn(websiteChangelogRefreshBtn);
  websiteChangelogSignature = null;
  fetchWebsiteChangelog();
});

const marketingChangelogList = document.getElementById('marketingChangelogList');
let marketingChangelogSignature = null;

async function fetchMarketingChangelog() {
  const res = await fetch('/api/marketing-changelog');
  const data = await res.json();
  const sig = JSON.stringify(data.entries);
  if (sig !== marketingChangelogSignature) {
    marketingChangelogSignature = sig;
    renderChangelogEntries(marketingChangelogList, data.entries);
  }
}

fetchMarketingChangelog();
registerPoll(fetchMarketingChangelog);

const marketingChangelogRefreshBtn = document.getElementById('marketingChangelogRefreshBtn');
marketingChangelogRefreshBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  spinRefreshBtn(marketingChangelogRefreshBtn);
  marketingChangelogSignature = null;
  fetchMarketingChangelog();
});

document.querySelectorAll('.collapsible-panel').forEach((panel) => {
  const storageKey = `panel-collapsed-${panel.id}`;
  const toggleBtn = panel.querySelector('.panel-toggle-btn');

  function setCollapsed(collapsed) {
    panel.classList.toggle('collapsed', collapsed);
    toggleBtn.textContent = collapsed ? '›' : '‹';
    toggleBtn.title = collapsed ? 'Expand' : 'Collapse';
    localStorage.setItem(storageKey, collapsed ? '1' : '0');
  }

  const stored = localStorage.getItem(storageKey);
  setCollapsed(stored === null ? true : stored === '1');

  toggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setCollapsed(!panel.classList.contains('collapsed'));
  });

  panel.addEventListener('click', () => {
    if (panel.classList.contains('collapsed')) setCollapsed(false);
  });
});

