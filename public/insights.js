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

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

function fmtNum(n) { return Math.round(n).toLocaleString('th-TH'); }
function fmtDate(d) { return new Date(d).toLocaleDateString('th-TH', { year: 'numeric', month: 'short', day: 'numeric' }); }
function fmtLength(sec) { return sec ? `${Math.round(sec)}s` : '—'; }
function firstLine(text, max) {
  const line = (text || '').split('\n')[0].trim();
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

function niceMax(value) {
  if (value <= 0) return 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
  const residual = value / magnitude;
  const step = residual > 5 ? 10 : residual > 2 ? 5 : residual > 1 ? 2 : 1;
  return step * magnitude;
}

// ─── Before/after comparison (หนิง started 2026-06-24) ────────────────
const START_DATE = new Date('2026-06-24T00:00:00');

function splitBeforeAfter(videos) {
  const before = videos.filter((v) => new Date(v.createdTime) < START_DATE);
  const after = videos.filter((v) => new Date(v.createdTime) >= START_DATE);
  return { before, after };
}

function periodMonths(videos, isBefore) {
  if (!videos.length) return 0;
  const dates = videos.map((v) => new Date(v.createdTime));
  if (isBefore) {
    const earliest = new Date(Math.min(...dates));
    return (START_DATE - earliest) / (1000 * 60 * 60 * 24 * 30);
  }
  return (new Date() - START_DATE) / (1000 * 60 * 60 * 24 * 30);
}

function renderComparison(videos) {
  const { before, after } = splitBeforeAfter(videos);
  document.getElementById('beforeRangeLabel').textContent = before.length
    ? `${fmtDate(Math.min(...before.map((v) => new Date(v.createdTime))))} – 23 มิ.ย. 2569`
    : '';
  document.getElementById('afterRangeLabel').textContent = `24 มิ.ย. 2569 – ${fmtDate(new Date())}`;

  const sum = (arr, key) => arr.reduce((s, v) => s + v[key], 0);
  const beforeMonths = periodMonths(before, true) || 1;
  const afterMonths = periodMonths(after, false) || 1;

  const rows = [
    { label: 'จำนวนคลิปที่โพสต์', before: before.length, after: after.length, fmt: fmtNum },
    { label: 'ยอดวิวรวม', before: sum(before, 'views'), after: sum(after, 'views'), fmt: fmtNum },
    { label: 'เฉลี่ยวิว/คลิป', before: before.length ? sum(before, 'views') / before.length : 0, after: after.length ? sum(after, 'views') / after.length : 0, fmt: fmtNum },
    { label: 'ไลก์รวม', before: sum(before, 'likes'), after: sum(after, 'likes'), fmt: fmtNum },
    { label: 'คอมเมนต์รวม', before: sum(before, 'comments'), after: sum(after, 'comments'), fmt: fmtNum },
    { label: 'แชร์รวม', before: sum(before, 'shares'), after: sum(after, 'shares'), fmt: fmtNum },
    { label: 'คลิปโพสต์/เดือน (เฉลี่ย)', before: before.length / beforeMonths, after: after.length / afterMonths, fmt: (n) => n.toFixed(1) },
  ];

  const tbody = document.getElementById('comparisonTableBody');
  tbody.innerHTML = '';
  rows.forEach((r) => {
    const tr = document.createElement('tr');

    const labelTd = document.createElement('td');
    labelTd.textContent = r.label;
    tr.appendChild(labelTd);

    const beforeTd = document.createElement('td');
    beforeTd.className = 'ads-num';
    beforeTd.textContent = r.fmt(r.before);
    tr.appendChild(beforeTd);

    const afterTd = document.createElement('td');
    afterTd.className = 'ads-num';
    afterTd.textContent = r.fmt(r.after);
    tr.appendChild(afterTd);

    const deltaTd = document.createElement('td');
    if (r.before > 0) {
      const pct = ((r.after - r.before) / r.before) * 100;
      const badge = document.createElement('span');
      badge.className = `ads-status-badge ${pct >= 0 ? 'is-success' : 'is-failed'}`;
      badge.textContent = `${pct >= 0 ? '▲' : '▼'} ${Math.abs(pct).toFixed(0)}%`;
      deltaTd.appendChild(badge);
    } else if (r.after > 0) {
      const badge = document.createElement('span');
      badge.className = 'ads-status-badge is-success';
      badge.textContent = '▲ ใหม่';
      deltaTd.appendChild(badge);
    } else {
      deltaTd.textContent = '—';
    }
    tr.appendChild(deltaTd);

    tbody.appendChild(tr);
  });
}

// ─── KPI tiles ──────────────────────────────────────────────────────────
function renderStatTiles(videos) {
  const totalViews = videos.reduce((s, v) => s + v.views, 0);
  const totalLikes = videos.reduce((s, v) => s + v.likes, 0);
  const totalComments = videos.reduce((s, v) => s + v.comments, 0);
  const totalShares = videos.reduce((s, v) => s + v.shares, 0);
  const avgViews = videos.length ? totalViews / videos.length : 0;

  const tiles = [
    { label: 'ยอดวิวรวม', value: fmtNum(totalViews) },
    { label: 'ไลก์รวม', value: fmtNum(totalLikes) },
    { label: 'คอมเมนต์รวม', value: fmtNum(totalComments) },
    { label: 'แชร์รวม', value: fmtNum(totalShares) },
    { label: 'จำนวนคลิป', value: fmtNum(videos.length) },
    { label: 'เฉลี่ยวิว/คลิป', value: fmtNum(avgViews) },
  ];

  const grid = document.getElementById('videoStatGrid');
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

// ─── Insights (rule-based) ──────────────────────────────────────────────
function renderInsights(videos) {
  const rows = document.getElementById('videoInsightRows');
  rows.innerHTML = '';
  if (videos.length < 3) return;
  const insights = [];

  const byViewsDesc = [...videos].sort((a, b) => b.views - a.views);
  const best = byViewsDesc[0];
  insights.push({
    type: 'good', icon: '✅',
    text: `"${firstLine(best.description, 50)}" ยอดวิวสูงสุด (${fmtNum(best.views)} วิว, ยาว ${fmtLength(best.length)}) — ลองดูว่ามีอะไรที่ทำให้โดนใจคนดูเป็นพิเศษ`,
  });

  const top5 = byViewsDesc.slice(0, 5);
  const bottom5 = byViewsDesc.slice(-5);
  const avgLenTop = top5.reduce((s, v) => s + v.length, 0) / top5.length;
  const avgLenBottom = bottom5.reduce((s, v) => s + v.length, 0) / bottom5.length;
  if (avgLenTop < avgLenBottom * 0.8) {
    insights.push({
      type: 'neutral', icon: '📏',
      text: `คลิปยอดวิวสูงสุด 5 อันดับ ยาวเฉลี่ย ${avgLenTop.toFixed(0)}s สั้นกว่ากลุ่มยอดวิวต่ำสุด (${avgLenBottom.toFixed(0)}s) — คลิปสั้นดูจะทำผลงานดีกว่า`,
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

// ─── Top videos bar chart ───────────────────────────────────────────────
function renderTopVideosChart(videos) {
  const container = document.getElementById('topVideosChart');
  container.innerHTML = '';

  const items = [...videos].sort((a, b) => b.views - a.views).slice(0, 10);
  if (!items.length) return;
  const bestId = items[0].videoId;
  const worstId = items[items.length - 1].videoId;

  const rowH = 40, barH = 20, thumbSize = 30, thumbGap = 8, labelW = 250;
  const W = 780, H = items.length * rowH + 16;
  const plotW = W - labelW - 70;
  const maxViews = niceMax(Math.max(...items.map((v) => v.views)) * 1.15);

  const svg = svgEl('svg', { class: 'ads-chart-svg', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': '10 คลิปยอดวิวสูงสุด' });
  const defs = svgEl('defs', {});
  svg.appendChild(defs);

  items.forEach((v, i) => {
    const cy = 16 + i * rowH;
    const barW = Math.max((v.views / maxViews) * plotW, 2);
    const isBest = v.videoId === bestId;
    const isWorst = v.videoId === worstId && items.length > 1;
    const thumbY = cy + barH / 2 - thumbSize / 2;
    const imgUrl = videoIdToCardImage.get(v.videoId);

    if (imgUrl) {
      const clipId = `top-video-thumb-clip-${i}`;
      const clipPath = svgEl('clipPath', { id: clipId });
      clipPath.appendChild(svgEl('rect', { x: 0, y: thumbY, width: thumbSize, height: thumbSize, rx: 5 }));
      defs.appendChild(clipPath);
      const thumb = svgEl('image', {
        x: 0, y: thumbY, width: thumbSize, height: thumbSize,
        href: imgUrl, preserveAspectRatio: 'xMidYMid slice', 'clip-path': `url(#${clipId})`,
      });
      svg.appendChild(thumb);
      const border = svgEl('rect', { class: 'ads-bar-thumb-border', x: 0, y: thumbY, width: thumbSize, height: thumbSize, rx: 5 });
      svg.appendChild(border);
    } else {
      const placeholder = svgEl('rect', { class: 'ads-bar-thumb-placeholder', x: 0, y: thumbY, width: thumbSize, height: thumbSize, rx: 5 });
      svg.appendChild(placeholder);
      const placeholderIcon = svgEl('text', { class: 'ads-bar-thumb-icon', x: thumbSize / 2, y: thumbY + thumbSize / 2 + 4, 'text-anchor': 'middle' });
      placeholderIcon.textContent = '🎬';
      svg.appendChild(placeholderIcon);
    }

    const nameLabel = svgEl('text', { class: 'ads-bar-name', x: thumbSize + thumbGap, y: cy + barH / 2 + 4 });
    nameLabel.textContent = (isBest ? '✅ ' : isWorst ? '⚠️ ' : '') + firstLine(v.description, 24);
    const title = svgEl('title', {});
    title.textContent = v.description;
    nameLabel.appendChild(title);
    svg.appendChild(nameLabel);

    // Only videos currently boosted by an ad have adViews > 0 (matched via
    // the ad's creative.video_id — see scripts/sync-video-ad-views.mjs);
    // everything else renders as a single fully-organic segment.
    const paidViews = Math.min(v.adViews || 0, v.views);
    const organicViews = v.views - paidViews;
    const organicBarW = Math.max((organicViews / maxViews) * plotW, organicViews > 0 ? 2 : 0);
    const paidBarW = Math.max((paidViews / maxViews) * plotW, paidViews > 0 ? 2 : 0);

    const organicBar = svgEl('rect', {
      class: 'ads-bar',
      'data-idx': i, x: labelW, y: cy, width: organicBarW, height: barH, rx: 4, tabindex: 0,
    });
    svg.appendChild(organicBar);
    if (paidViews > 0) {
      const paidBar = svgEl('rect', {
        class: 'ads-bar-paid',
        'data-idx': i, x: labelW + organicBarW, y: cy, width: paidBarW, height: barH,
        rx: organicViews > 0 ? 0 : 4,
      });
      svg.appendChild(paidBar);
    }

    const valueLabel = svgEl('text', { class: 'ads-bar-label', x: labelW + barW + 8, y: cy + barH / 2 + 4 });
    valueLabel.textContent = fmtNum(v.views);
    svg.appendChild(valueLabel);
  });

  container.appendChild(svg);

  if (items.some((v) => v.adViews > 0)) {
    const legend = document.createElement('div');
    legend.className = 'ads-chart-legend';
    legend.innerHTML = `
      <span class="ads-chart-legend-item"><span class="ads-chart-legend-swatch" style="background:var(--accent)"></span>ออร์แกนิก</span>
      <span class="ads-chart-legend-item"><span class="ads-chart-legend-swatch" style="background:var(--status-warning)"></span>จากโฆษณา</span>
    `;
    container.prepend(legend);
  }

  const tooltip = document.createElement('div');
  tooltip.className = 'ads-chart-tooltip ads-chart-tooltip-rich';
  container.appendChild(tooltip);

  const bars = svg.querySelectorAll('.ads-bar, .ads-bar-paid');
  bars.forEach((bar) => {
    const v = items[Number(bar.dataset.idx)];
    const paidViews = Math.min(v.adViews || 0, v.views);
    const organicViews = v.views - paidViews;
    function show() {
      tooltip.innerHTML = '';
      const nameRow = document.createElement('div');
      nameRow.className = 'tt-value';
      nameRow.textContent = firstLine(v.description, 60);
      tooltip.appendChild(nameRow);
      [
        ['วันที่', fmtDate(v.createdTime)],
        ['ความยาว', fmtLength(v.length)],
        ['วิวรวม', fmtNum(v.views)],
        ...(paidViews > 0 ? [['- ออร์แกนิก', fmtNum(organicViews)], ['- จากโฆษณา', fmtNum(paidViews)]] : []),
        ['Post views', fmtNum(v.postViews)],
        ['ไลก์', fmtNum(v.likes)],
        ['คอมเมนต์', fmtNum(v.comments)],
        ['แชร์', fmtNum(v.shares)],
      ].forEach(([label, value]) => {
        const row = document.createElement('div');
        row.className = 'tt-row';
        const l = document.createElement('span');
        l.className = 'tt-label';
        l.textContent = label;
        const val = document.createElement('span');
        val.className = 'tt-value';
        val.textContent = value;
        row.appendChild(l);
        row.appendChild(val);
        tooltip.appendChild(row);
      });
      tooltip.classList.add('visible');
      const rect = container.getBoundingClientRect();
      const barRect = bar.getBoundingClientRect();
      tooltip.style.left = Math.min(barRect.left - rect.left, rect.width - 200) + 'px';
      tooltip.style.top = (barRect.top - rect.top - 8) + 'px';
    }
    function hide() { tooltip.classList.remove('visible'); }
    bar.addEventListener('pointermove', show);
    bar.addEventListener('focus', show);
    bar.addEventListener('pointerleave', hide);
    bar.addEventListener('blur', hide);
  });
}

// ─── Table ──────────────────────────────────────────────────────────────
function renderTable(videos) {
  const tbody = document.getElementById('videoTableBody');
  tbody.innerHTML = '';
  const sorted = [...videos].sort((a, b) => new Date(b.createdTime) - new Date(a.createdTime));
  sorted.forEach((v) => {
    const tr = document.createElement('tr');

    const dateTd = document.createElement('td');
    dateTd.textContent = fmtDate(v.createdTime);
    tr.appendChild(dateTd);

    const descTd = document.createElement('td');
    descTd.textContent = firstLine(v.description, 50);
    descTd.title = v.description;
    tr.appendChild(descTd);

    const lenTd = document.createElement('td');
    lenTd.className = 'ads-num';
    lenTd.textContent = fmtLength(v.length);
    tr.appendChild(lenTd);

    [v.views, v.postViews, v.likes, v.comments, v.shares].forEach((val) => {
      const td = document.createElement('td');
      td.className = 'ads-num';
      td.textContent = fmtNum(val);
      tr.appendChild(td);
    });

    const linkTd = document.createElement('td');
    if (v.permalinkUrl) {
      const a = document.createElement('a');
      a.href = v.permalinkUrl.startsWith('http') ? v.permalinkUrl : `https://facebook.com${v.permalinkUrl}`;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.className = 'insights-link-icon';
      a.title = 'เปิดดูโพสต์';
      a.textContent = '🔗';
      linkTd.appendChild(a);
    } else {
      linkTd.textContent = '—';
    }
    tr.appendChild(linkTd);

    const cardTd = document.createElement('td');
    const cardId = videoIdToCardId.get(v.videoId);
    if (cardId) {
      const a = document.createElement('a');
      a.href = `/index.html?card=${cardId}`;
      a.className = 'insights-link-icon';
      a.title = 'เปิดการ์ด';
      a.textContent = '🗂️';
      cardTd.appendChild(a);
    } else {
      cardTd.textContent = '—';
    }
    tr.appendChild(cardTd);

    tbody.appendChild(tr);
  });
}

// ─── Wiring ─────────────────────────────────────────────────────────────
const insightsEmpty = document.getElementById('insightsEmpty');
const insightsBody = document.getElementById('insightsBody');
let insightsSignature = null;

function render(videos) {
  if (!videos.length) {
    insightsEmpty.hidden = false;
    insightsBody.hidden = true;
    return;
  }
  insightsEmpty.hidden = true;
  insightsBody.hidden = false;
  renderComparison(videos);
  const { after } = splitBeforeAfter(videos);
  renderStatTiles(after);
  renderInsights(after);
  renderTopVideosChart(after);
  renderTable(after);
}

let videoIdToCardId = new Map();
let videoIdToCardImage = new Map();

async function fetchInsights() {
  const [videoRes, cardsRes] = await Promise.all([
    fetch('/api/page-video-insights'),
    fetch('/api/cards'),
  ]);
  const data = await videoRes.json();
  const cardsData = await cardsRes.json();
  videoIdToCardId = new Map(
    (cardsData.cards || []).filter((c) => c.linkedVideoId).map((c) => [c.linkedVideoId, c.id])
  );
  videoIdToCardImage = new Map(
    (cardsData.cards || []).filter((c) => c.linkedVideoId && c.imageUrl).map((c) => [c.linkedVideoId, c.imageUrl])
  );
  const sig = JSON.stringify(data.entries) + JSON.stringify([...videoIdToCardId]) + JSON.stringify([...videoIdToCardImage]);
  if (sig !== insightsSignature) {
    insightsSignature = sig;
    render(data.entries || []);
  }
  renderLastSynced(data.lastSyncedAt);
}

function renderLastSynced(iso) {
  const el = document.getElementById('insightsLastSynced');
  if (!iso) { el.hidden = true; return; }
  const d = new Date(iso);
  el.textContent = `🕐 อัปเดตล่าสุด: ${d.toLocaleString('th-TH', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
  el.hidden = false;
}

fetchInsights();
setInterval(() => { if (!document.hidden) fetchInsights(); }, 30000);

document.getElementById('insightsRefreshBtn').addEventListener('click', () => {
  insightsSignature = null;
  fetchInsights();
});
