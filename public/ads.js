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

function fmtBaht(n) { return '฿' + Math.round(n).toLocaleString('th-TH'); }
function fmtNum(n) { return Math.round(n).toLocaleString('th-TH'); }
function fmtPct(n) { return n.toFixed(2) + '%'; }
function fmtDate(d) { return new Date(d).toLocaleDateString('th-TH', { month: 'short', day: 'numeric' }); }

function niceMax(value) {
  if (value <= 0) return 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
  const residual = value / magnitude;
  const step = residual > 5 ? 10 : residual > 2 ? 5 : residual > 1 ? 2 : 1;
  return step * magnitude;
}

// ─── KPI tiles ──────────────────────────────────────────────────────────
function renderStatTiles(entries) {
  const totalSpend = entries.reduce((s, e) => s + e.spend, 0);
  const totalReach = entries.reduce((s, e) => s + e.reach, 0);
  const totalClicks = entries.reduce((s, e) => s + e.clicks, 0);
  const totalImpressions = entries.reduce((s, e) => s + e.impressions, 0);
  const avgCtr = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;
  const avgCpc = totalClicks > 0 ? totalSpend / totalClicks : 0;

  const tiles = [
    { label: 'งบใช้จ่ายรวม', value: fmtBaht(totalSpend) },
    { label: 'เข้าถึงรวม', value: fmtNum(totalReach) },
    { label: 'คลิกเข้าเว็บรวม', value: fmtNum(totalClicks) },
    { label: 'CTR เฉลี่ย', value: fmtPct(avgCtr) },
    { label: 'CPC เฉลี่ย', value: fmtBaht(avgCpc) },
  ];

  const grid = document.getElementById('adStatGrid');
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

// Campaigns run for multiple days each (see the 3-campaign structure:
// Awareness / กระตุ้นยอดขาย / ความน่าเชื่อถือ), so every chart/insight that
// compares "campaigns" first rolls up all of a campaign's daily rows into
// one totals-based CTR/CPC — never compares single days across campaigns.
function aggregateByCampaign(entries) {
  const map = new Map();
  entries.forEach((e) => {
    const agg = map.get(e.campaignName) || {
      campaignName: e.campaignName, spend: 0, reach: 0, impressions: 0, clicks: 0,
      creativeNames: new Set(), sampleAudience: e.targetAudience, sampleCreativeImageUrl: e.creativeImageUrl,
    };
    agg.spend += e.spend;
    agg.reach += e.reach;
    agg.impressions += e.impressions;
    agg.clicks += e.clicks;
    if (e.creativeName) agg.creativeNames.add(e.creativeName);
    map.set(e.campaignName, agg);
  });
  return [...map.values()].map((a) => ({
    ...a,
    id: a.campaignName,
    ctr: a.impressions > 0 ? (a.clicks / a.impressions) * 100 : 0,
    cpc: a.clicks > 0 ? a.spend / a.clicks : 0,
    creativeNames: [...a.creativeNames],
  }));
}

// ─── Date tree (วันที่ → แคมเปญ → กลุ่มเป้าหมาย → ครีเอทีฟ) ─────────────────
function metricsFrom(spend, reach, impressions, clicks) {
  return {
    spend, reach, impressions, clicks,
    ctr: impressions > 0 ? (clicks / impressions) * 100 : 0,
    cpc: clicks > 0 ? spend / clicks : 0,
  };
}

function sumMetrics(items) {
  const totals = items.reduce((acc, x) => ({
    spend: acc.spend + x.spend, reach: acc.reach + x.reach,
    impressions: acc.impressions + x.impressions, clicks: acc.clicks + x.clicks,
  }), { spend: 0, reach: 0, impressions: 0, clicks: 0 });
  return metricsFrom(totals.spend, totals.reach, totals.impressions, totals.clicks);
}

function buildDateTree(entries) {
  const dates = new Map();
  entries.forEach((e) => {
    const dKey = dateKey(e.date);
    const dateBucket = dates.get(dKey) || { date: e.date, campaigns: new Map() };
    dates.set(dKey, dateBucket);

    const campaign = dateBucket.campaigns.get(e.campaignName) || { name: e.campaignName, adsets: new Map() };
    dateBucket.campaigns.set(e.campaignName, campaign);

    const audienceKey = e.targetAudience || 'ไม่ระบุกลุ่มเป้าหมาย';
    const adset = campaign.adsets.get(audienceKey) || { name: audienceKey, creatives: new Map() };
    campaign.adsets.set(audienceKey, adset);

    const creativeKey = e.creativeName || 'ไม่ระบุครีเอทีฟ';
    const creative = adset.creatives.get(creativeKey) || {
      name: creativeKey, imageUrl: e.creativeImageUrl || null,
      spend: 0, reach: 0, impressions: 0, clicks: 0,
    };
    creative.spend += e.spend;
    creative.reach += e.reach;
    creative.impressions += e.impressions;
    creative.clicks += e.clicks;
    if (!creative.imageUrl && e.creativeImageUrl) creative.imageUrl = e.creativeImageUrl;
    adset.creatives.set(creativeKey, creative);
  });

  return [...dates.values()].map((dateBucket) => {
    const campaigns = [...dateBucket.campaigns.values()].map((campaign) => {
      const adsets = [...campaign.adsets.values()].map((adset) => {
        const creatives = [...adset.creatives.values()]
          .map((c) => ({ ...c, ...metricsFrom(c.spend, c.reach, c.impressions, c.clicks) }))
          .sort((a, b) => b.spend - a.spend);
        return { name: adset.name, creatives, ...sumMetrics(creatives) };
      }).sort((a, b) => b.spend - a.spend);
      return { name: campaign.name, adsets, ...sumMetrics(adsets) };
    }).sort((a, b) => b.spend - a.spend);
    return { date: dateBucket.date, campaigns, ...sumMetrics(campaigns) };
  }).sort((a, b) => new Date(b.date) - new Date(a.date));
}

function renderCampaignTree(entries) {
  const tbody = document.getElementById('adCampaignTreeBody');
  tbody.innerHTML = '';
  const tree = buildDateTree(entries);

  function makeRow({ level, label, thumb, metrics, toggle, childRows, collapsed = false }) {
    const tr = document.createElement('tr');
    tr.className = `ads-tree-row ads-tree-level-${level}`;

    const nameTd = document.createElement('td');
    nameTd.className = 'ads-tree-name-cell';
    nameTd.style.paddingLeft = `${10 + level * 22}px`;

    if (toggle) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ads-tree-toggle';
      btn.textContent = collapsed ? '▸' : '▾';
      if (collapsed) tr.classList.add('is-collapsed');
      btn.setAttribute('aria-label', 'ย่อ/ขยาย');
      btn.addEventListener('click', () => {
        const collapsed = tr.classList.toggle('is-collapsed');
        btn.textContent = collapsed ? '▸' : '▾';
        childRows.forEach((r) => { r.hidden = collapsed; });
      });
      nameTd.appendChild(btn);
    } else {
      const spacer = document.createElement('span');
      spacer.className = 'ads-tree-toggle-spacer';
      nameTd.appendChild(spacer);
    }

    if (thumb) {
      const img = document.createElement('img');
      img.className = 'ads-tree-thumb';
      img.src = thumb;
      img.alt = label;
      nameTd.appendChild(img);
    }

    const nameSpan = document.createElement('span');
    nameSpan.className = 'ads-tree-name';
    nameSpan.textContent = label;
    nameTd.appendChild(nameSpan);
    tr.appendChild(nameTd);

    [fmtNum(metrics.spend), fmtNum(metrics.reach), fmtNum(metrics.clicks), fmtPct(metrics.ctr), fmtNum(metrics.cpc)].forEach((val) => {
      const td = document.createElement('td');
      td.className = 'ads-num';
      td.textContent = val;
      tr.appendChild(td);
    });

    return tr;
  }

  // Only the newest day opens by default (down to each creative); older days
  // start collapsed so the latest results are what you see first.
  tree.forEach((dateBucket, dateIndex) => {
    const dateChildRows = [];
    const dateCollapsed = dateIndex > 0;
    tbody.appendChild(makeRow({
      level: 0, label: `📅 ${fmtDate(dateBucket.date)}`, metrics: dateBucket, toggle: true, childRows: dateChildRows,
      collapsed: dateCollapsed,
    }));

    dateBucket.campaigns.forEach((campaign) => {
      const campaignChildRows = [];
      const campaignRow = makeRow({
        level: 1, label: `📁 ${campaign.name}`, metrics: campaign, toggle: true, childRows: campaignChildRows,
      });
      tbody.appendChild(campaignRow);
      dateChildRows.push(campaignRow);

      campaign.adsets.forEach((adset) => {
        const adsetChildRows = [];
        const adsetRow = makeRow({
          level: 2, label: `👥 ${adset.name}`, metrics: adset, toggle: true, childRows: adsetChildRows,
        });
        tbody.appendChild(adsetRow);
        campaignChildRows.push(adsetRow);
        dateChildRows.push(adsetRow);

        adset.creatives.forEach((creative) => {
          const creativeRow = makeRow({
            level: 3, label: creative.name, thumb: creative.imageUrl, metrics: creative,
          });
          tbody.appendChild(creativeRow);
          adsetChildRows.push(creativeRow);
          campaignChildRows.push(creativeRow);
          dateChildRows.push(creativeRow);
        });
      });
    });
    dateChildRows.forEach((r) => { r.hidden = dateCollapsed; });
  });
}

// ─── Insights (rule-based, computed from the actual numbers) ──────────────
function renderInsights(entries) {
  const rows = document.getElementById('adInsightRows');
  rows.innerHTML = '';
  const insights = [];
  const campaigns = aggregateByCampaign(entries);

  const byCtrDesc = [...campaigns].sort((a, b) => b.ctr - a.ctr);
  const bestCtr = byCtrDesc[0];
  insights.push({
    type: 'good', icon: '✅',
    text: `แคมเปญ "${bestCtr.campaignName}" มี CTR สูงสุด (${fmtPct(bestCtr.ctr)}) — น่าจะเป็นครีเอทีฟที่โดนใจกลุ่มเป้าหมาย ลองพิจารณาเพิ่มงบให้แคมเปญนี้`,
  });

  const byCpcDesc = [...campaigns].sort((a, b) => b.cpc - a.cpc);
  const worstCpc = byCpcDesc[0];
  if (campaigns.length > 1) {
    insights.push({
      type: 'warning', icon: '⚠️',
      text: `แคมเปญ "${worstCpc.campaignName}" มี CPC สูงสุด (${fmtBaht(worstCpc.cpc)} ต่อคลิก) — ลองทบทวน targeting หรือครีเอทีฟของแคมเปญนี้`,
    });
  }

  const byDate = new Map();
  entries.forEach((e) => {
    const key = dateKey(e.date);
    byDate.set(key, (byDate.get(key) || 0) + e.spend);
  });
  const dailyTotals = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  if (dailyTotals.length >= 2) {
    const [, lastSpend] = dailyTotals[dailyTotals.length - 1];
    const [, prevSpend] = dailyTotals[dailyTotals.length - 2];
    const change = prevSpend > 0 ? ((lastSpend - prevSpend) / prevSpend) * 100 : 0;
    const dir = change >= 0 ? 'เพิ่มขึ้น' : 'ลดลง';
    insights.push({
      type: 'neutral', icon: change >= 0 ? '📈' : '📉',
      text: `งบใช้จ่ายวันล่าสุด ${dir} ${Math.abs(change).toFixed(1)}% เทียบกับวันก่อนหน้า`,
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

// ─── Spend trend line chart ────────────────────────────────────────────
function renderSpendChart(entries) {
  const container = document.getElementById('adSpendChart');
  container.innerHTML = '';

  const byDate = new Map();
  entries.forEach((e) => {
    const key = new Date(e.date).toISOString().slice(0, 10);
    byDate.set(key, (byDate.get(key) || 0) + e.spend);
  });
  const points = [...byDate.entries()]
    .map(([date, spend]) => ({ date, spend }))
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  if (!points.length) return;

  const W = 760, H = 220;
  const padL = 56, padR = 50, padT = 16, padB = 30;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const maxSpend = niceMax(Math.max(...points.map((p) => p.spend)) * 1.15);

  const x = (i) => padL + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const y = (v) => padT + plotH - (v / maxSpend) * plotH;

  const svg = svgEl('svg', { class: 'ads-chart-svg', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'แนวโน้มงบใช้จ่ายรายวัน' });

  const gridSteps = 4;
  for (let i = 0; i <= gridSteps; i++) {
    const v = (maxSpend / gridSteps) * i;
    const gy = y(v);
    svg.appendChild(svgEl('line', { class: 'ads-grid-line', x1: padL, x2: W - padR, y1: gy, y2: gy }));
    const label = svgEl('text', { class: 'ads-axis-label', x: padL - 8, y: gy + 4, 'text-anchor': 'end' });
    label.textContent = fmtBaht(v);
    svg.appendChild(label);
  }

  points.forEach((p, i) => {
    const label = svgEl('text', { class: 'ads-axis-label', x: x(i), y: H - 8, 'text-anchor': 'middle' });
    label.textContent = fmtDate(p.date);
    svg.appendChild(label);
  });

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(p.spend)}`).join(' ');
  const areaPath = `${linePath} L ${x(points.length - 1)} ${y(0)} L ${x(0)} ${y(0)} Z`;
  svg.appendChild(svgEl('path', { class: 'ads-area-fill', d: areaPath }));
  svg.appendChild(svgEl('path', { class: 'ads-line-mark', d: linePath }));

  const lastIdx = points.length - 1;
  svg.appendChild(svgEl('circle', { class: 'ads-end-dot', cx: x(lastIdx), cy: y(points[lastIdx].spend), r: 5 }));
  const endLabel = svgEl('text', {
    class: 'ads-end-label', x: x(lastIdx) + 8, y: y(points[lastIdx].spend) - 8,
    'text-anchor': lastIdx === 0 ? 'middle' : 'end',
  });
  endLabel.textContent = fmtBaht(points[lastIdx].spend);
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
    val.textContent = fmtBaht(p.spend);
    row.appendChild(lbl);
    row.appendChild(val);
    tooltip.appendChild(row);
    tooltip.classList.add('visible');
    const svgRect = svg.getBoundingClientRect();
    const scale = svgRect.width / W;
    tooltip.style.left = Math.min(x(i) * scale, svgRect.width - 110) + 'px';
    tooltip.style.top = (y(p.spend) * scale - 50) + 'px';
  }
  function hide() {
    crosshair.style.opacity = '0';
    tooltip.classList.remove('visible');
  }

  hitRect.addEventListener('pointermove', (evt) => {
    const rect = svg.getBoundingClientRect();
    const px = ((evt.clientX - rect.left) / rect.width) * W;
    let nearest = 0, nearestDist = Infinity;
    points.forEach((_, i) => {
      const d = Math.abs(x(i) - px);
      if (d < nearestDist) { nearestDist = d; nearest = i; }
    });
    showAt(nearest);
  });
  hitRect.addEventListener('pointerleave', hide);
}

// ─── Marketing funnel (เห็น → จดจำ → สนใจ → พิจารณา → ลงมือ) ──────────────
// Meta numbers come live from /api/ad-funnel (reach must be de-duplicated
// over the whole range by Meta, so it can't be summed from daily rows); the
// site stages come from tasaki-web's own tracker.
const SITE_REDESIGN_DATE = '2026-10-02'; // mobile product page + dealer button update
const SCROLL_TRACKING_START = '2026-09-29';
let adFunnelCampaignChoice = null;
let adFunnelRequestId = 0;

function addDays(key, n) {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const FUNNEL_ICONS = {
  awareness: '<svg viewBox="0 0 24 24"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  interest: '<svg viewBox="0 0 24 24"><path d="M9 9l5 12 1.8-5.2L21 14z"/><path d="M7.2 2.2L8 5M2.2 7.2L5 8M14 4.1l-2.1 1.4M4.1 14l1.4-2.1"/></svg>',
  consideration: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/><path d="M8 11h6M11 8v6"/></svg>',
  purchase: '<svg viewBox="0 0 24 24"><circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M2 3h3l2.7 12.4a2 2 0 0 0 2 1.6h7.7a2 2 0 0 0 2-1.6L21 7H6"/></svg>',
  contact: '<svg viewBox="0 0 24 24"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/></svg>',
  retention: '<svg viewBox="0 0 24 24"><path d="M17 2l4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>',
};

let adFunnelResizeObserver = null;
let adFunnelThemeObserver = null;
let adFunnelRedraw = null;

// Hologram funnel drawn as ONE continuous glass shape on a single canvas:
// a straight cone that curves smoothly into a neck, cut into stage layers by
// elliptical rims. Inside each layer `count` glowing dots (1 dot = 1 person)
// fill the front surface, seeded so they don't jump around on redraw.
// Returns each layer's centre y + right edge so labels/stats can line up.
function funnelRand(seed) {
  let a = seed * 2654435761;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function drawHoloFunnel(canvas, stages, { stacked }) {
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if (!W || !H) return null;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);
  // Same hologram in both themes: on the dark stage the glass glows light
  // blue; on the light stage it's a deeper blue glass with blue dots
  // (additive "lighter" blending would wash out on white).
  const light = document.documentElement.getAttribute('data-theme') !== 'dark';
  const C = light ? {
    edge: '40, 110, 220', streak: '255, 255, 255', mid: '60, 130, 230', fill: '70, 140, 235',
    dotCore: (tw) => `rgba(${20 + tw * 30}, ${110 + tw * 40}, ${220 + tw * 30}, ${0.45 + tw * 0.5})`, dotGlow: 'rgba(60, 150, 255, 0.6)',
    outline: 'rgba(40, 110, 220, 0.9)', rimBack: 'rgba(40, 110, 220, 0.3)', rimFront: 'rgba(30, 95, 210, 0.95)', rimTop: 'rgba(90, 160, 240, 0.12)',
    glow: 'rgba(60, 150, 255, 0.5)', lineA: 'rgba(40, 110, 220, 0.85)', lineB: 'rgba(40, 110, 220, 0.12)', pin: 'rgba(30, 95, 210, 1)',
    blend: 'source-over', bodyAlpha: 0.75,
  } : {
    edge: '120, 200, 255', streak: '170, 225, 255', mid: '80, 160, 255', fill: '90, 170, 255',
    dotCore: (tw) => `rgba(${190 + tw * 50}, ${235 + tw * 20}, 255, ${0.35 + tw * 0.6})`, dotGlow: 'rgba(110, 215, 255, 0.95)',
    outline: 'rgba(190, 235, 255, 0.85)', rimBack: 'rgba(190, 235, 255, 0.35)', rimFront: 'rgba(235, 250, 255, 0.95)', rimTop: 'rgba(170, 225, 255, 0.12)',
    glow: 'rgba(120, 210, 255, 0.9)', lineA: 'rgba(170, 230, 255, 0.9)', lineB: 'rgba(170, 230, 255, 0.15)', pin: 'rgba(220, 245, 255, 1)',
    blend: 'lighter', bodyAlpha: 1,
  };

  const funnelW = stacked ? W * 0.96 : W * 0.78;
  const cx = stacked ? W / 2 : funnelW / 2 + 8;
  const TILT = 0.15; // rim ry ÷ rx
  const R0 = funnelW / 2 - 4, R1 = R0 * 0.3;
  const y0 = R0 * TILT + 6;
  const y1 = H - R1 * TILT - 10; // flat bottom, no spout

  // Straight cone y0→y1.
  const slope = (R1 - R0) / (y1 - y0);
  const rAt = (y) => R0 + slope * (Math.min(Math.max(y, y0), y1) - y0);
  const frontY = (yc, dx) => { const r = rAt(yc); return yc + r * TILT * Math.sqrt(Math.max(0, 1 - (dx / r) ** 2)); };

  // Layer boundaries: all stages on the cone, the top one a bit taller.
  const weights = stages.map((_, i) => (i === 0 ? 1.3 : i === stages.length - 1 ? 0.9 : 1));
  const wSum = weights.reduce((x, v) => x + v, 0);
  const cuts = [y0];
  weights.forEach((wt) => cuts.push(cuts[cuts.length - 1] + ((y1 - y0) * wt) / wSum));

  const silhouette = new Path2D();
  silhouette.moveTo(cx - R0, y0);
  silhouette.lineTo(cx - R1, y1);
  silhouette.ellipse(cx, y1, R1, R1 * TILT, 0, Math.PI, 0, true);
  silhouette.lineTo(cx + R0, y0);
  silhouette.closePath();

  // Glass body: one horizontal gradient per scanline, scaled to that
  // scanline's radius so the bright edges follow the silhouette.
  for (let y = Math.floor(y0); y <= y1 + R1 * TILT; y++) {
    const r = rAt(y);
    const fade = (1 - 0.35 * ((y - y0) / (y1 - y0))) * C.bodyAlpha;
    const g = ctx.createLinearGradient(cx - r, 0, cx + r, 0);
    g.addColorStop(0, `rgba(${C.edge}, ${0.5 * fade})`);
    g.addColorStop(0.12, `rgba(${C.fill}, ${0.2 * fade})`);
    g.addColorStop(0.28, `rgba(${C.streak}, ${0.26 * fade})`); // specular streak
    g.addColorStop(0.5, `rgba(${C.mid}, ${0.14 * fade})`);
    g.addColorStop(0.88, `rgba(${C.fill}, ${0.2 * fade})`);
    g.addColorStop(1, `rgba(${C.edge}, ${0.48 * fade})`);
    ctx.save();
    ctx.clip(silhouette);
    ctx.fillStyle = g;
    ctx.fillRect(cx - r - 1, y, r * 2 + 2, 1.2);
    ctx.restore();
  }

  // Dots.
  const layout = [];
  stages.forEach((st, i) => {
    const ya = cuts[i], yb = cuts[i + 1];
    layout.push({ y: (ya + yb) / 2 + rAt((ya + yb) / 2) * TILT * 0.6, edge: cx + rAt((ya + yb) / 2) });
    if (!st.value) return;
    const rand = funnelRand(i + 1);
    const rTop = rAt(ya);
    ctx.save();
    ctx.clip(silhouette);
    ctx.globalCompositeOperation = C.blend;
    ctx.shadowColor = C.dotGlow;
    ctx.shadowBlur = 3;
    for (let n = 0, guard = 0; n < st.value && guard < st.value * 30; guard++) {
      const dx = (rand() * 2 - 1) * rTop;
      const y = ya + rand() * (yb - ya + rTop * TILT);
      if (Math.abs(dx) > rAt(y) - 2) continue;
      if (y < frontY(ya, dx) + 1 || y > frontY(yb, dx) - 1) continue;
      const tw = rand();
      ctx.fillStyle = C.dotCore(tw);
      ctx.beginPath();
      ctx.arc(cx + dx, y, 0.45 + tw * 0.45, 0, Math.PI * 2);
      ctx.fill();
      n++;
    }
    ctx.restore();
  });

  // Outline + rims (back half dim, front half bright → reads as 3D glass).
  ctx.save();
  ctx.shadowColor = C.glow;
  ctx.shadowBlur = 8;
  ctx.lineWidth = 1.3;
  ctx.strokeStyle = C.outline;
  ctx.stroke(silhouette);
  cuts.forEach((y, i) => {
    const r = rAt(y), ry = r * TILT;
    ctx.beginPath();
    ctx.ellipse(cx, y, r, ry, 0, Math.PI, 0);
    ctx.lineWidth = 1;
    ctx.strokeStyle = C.rimBack;
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(cx, y, r, ry, 0, 0, Math.PI);
    ctx.lineWidth = i === 0 ? 2 : 1.4;
    ctx.strokeStyle = C.rimFront;
    ctx.stroke();
    if (i === 0) {
      ctx.beginPath();
      ctx.ellipse(cx, y, r, ry, 0, 0, Math.PI * 2);
      ctx.fillStyle = C.rimTop;
      ctx.fill();
    }
  });
  ctx.restore();

  // Glowing leader lines from each layer's edge to its stats.
  if (!stacked) {
    ctx.save();
    ctx.shadowColor = C.glow;
    ctx.shadowBlur = 4;
    layout.forEach(({ y, edge }) => {
      const xEnd = funnelW + 14;
      const g = ctx.createLinearGradient(edge, 0, xEnd, 0);
      g.addColorStop(0, C.lineA);
      g.addColorStop(1, C.lineB);
      ctx.strokeStyle = g;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(edge + 4, y);
      ctx.lineTo(xEnd, y);
      ctx.stroke();
      ctx.fillStyle = C.pin;
      ctx.beginPath();
      ctx.arc(edge + 4, y, 2.2, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.restore();
  }
  return { layout, cx, statsLeft: funnelW + 20 };
}

async function renderAdFunnel(entries) {
  const funnelEl = document.getElementById('adFunnel');
  const dailyEl = document.getElementById('adFunnelDaily');
  const select = document.getElementById('adFunnelCampaign');

  const campaigns = aggregateByCampaign(entries).sort((a, b) => b.spend - a.spend).map((c) => c.campaignName);
  if (!campaigns.length) return;
  if (!campaigns.includes(adFunnelCampaignChoice)) adFunnelCampaignChoice = campaigns[0];
  select.innerHTML = '';
  campaigns.forEach((name) => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  });
  select.value = adFunnelCampaignChoice;
  select.hidden = campaigns.length < 2;
  select.onchange = () => { adFunnelCampaignChoice = select.value; renderAdFunnel(entries); };

  const days = entries.filter((e) => e.campaignName === adFunnelCampaignChoice).map((e) => dateKey(e.date)).sort();
  const since = days[0];
  const until = days[days.length - 1];

  const requestId = ++adFunnelRequestId;
  funnelEl.innerHTML = '<p class="key-messages-hint">กำลังโหลด…</p>';
  dailyEl.innerHTML = '';
  let data;
  try {
    const params = new URLSearchParams({ campaign: adFunnelCampaignChoice, since, until });
    const res = await fetch(`/api/ad-funnel?${params.toString()}`);
    data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
  } catch (e) {
    if (requestId === adFunnelRequestId) funnelEl.innerHTML = `<p class="key-messages-hint">โหลดกรวยไม่สำเร็จ: ${escapeHtml(e.message)}</p>`;
    return;
  }
  if (requestId !== adFunnelRequestId) return; // a newer filter change already re-rendered

  const { meta, site } = data;
  const partlyUnmeasured = since < SCROLL_TRACKING_START && site.measured < site.visitors;
  const pct = (n, base) => {
    if (!base) return '';
    const p = (n / base) * 100;
    return `${p.toFixed(p < 10 ? 1 : 0)}%`;
  };
  // Seen-button % is over the visitors whose scroll was actually measured.
  const considerBase = partlyUnmeasured ? site.measured : site.visitors;
  const stages = [
    {
      key: 'awareness', en: 'Awareness', th: 'เห็นโฆษณา',
      value: meta.reach, unit: 'คน',
      lines: [
        `แสดง ${fmtNum(meta.impressions)} ครั้ง · เฉลี่ยคนละ ${meta.frequency.toFixed(1)} ครั้ง`,
        `จดจำ / มีส่วนร่วม ${fmtNum(meta.engagement)} ครั้ง (ไลก์ ${fmtNum(meta.reactions)} · เซฟ ${fmtNum(meta.saves)} · คอมเมนต์ ${fmtNum(meta.comments)})`,
      ],
    },
    {
      key: 'interest', en: 'Interest', th: 'สนใจ คลิกเข้าเว็บ',
      value: site.visitors, unit: 'คน', conv: `${pct(site.visitors, meta.reach)} ของคนที่เห็น`,
      lines: [
        `คลิกลิงก์ ${fmtNum(meta.linkClicks)} ครั้ง · คลิกละ ${fmtBaht(meta.linkClicks ? meta.spend / meta.linkClicks : 0)}`,
        `ดูหน้าอื่นต่อ ${fmtNum(site.multiPage)} คน`,
      ],
    },
    {
      key: 'consideration', en: 'Consideration', th: 'พิจารณา เห็นปุ่มหาตัวแทน',
      value: site.ctaSeen, unit: 'คน', conv: `${pct(site.ctaSeen, considerBase)} ของคนที่เข้าเว็บ`,
      lines: [
        `อ่านเกินครึ่งหน้า ${fmtNum(site.read50)} คน`,
        ...(partlyUnmeasured ? [`วัดได้ตั้งแต่ 29 ก.ย. (${fmtNum(site.measured)} จาก ${fmtNum(site.visitors)} คน)`] : []),
      ],
    },
    {
      key: 'purchase', en: 'Purchase', th: 'ลงมือ กดสั่งซื้อ / ติดต่อ',
      value: site.acted, unit: 'คน', conv: `${pct(site.acted, site.visitors)} ของคนที่เข้าเว็บ`,
      lines: [
        `กดปุ่มหาตัวแทน ${fmtNum(site.ctaClicked)} คน · กดติดต่อเรา ${site.contacted === null ? '–' : fmtNum(site.contacted)} คน (ทำทั้งสองอย่างนับเป็น 1 คน)`,
        `฿${fmtNum(site.acted ? meta.spend / site.acted : 0)} ต่อคน`,
        `Facebook นับเป็น Lead ได้ ${fmtNum(meta.leads)}`,
        'ยอดขายจริงเกิดที่ร้านตัวแทน ยังวัดไม่ได้',
      ],
    },
    {
      key: 'contact', en: 'Contact', th: 'ติดต่อเรา / ร้านตัวแทน',
      value: site.contacted, unit: 'คน',
      conv: site.contacted === null ? '' : `${pct(site.contacted, site.acted)} ของคนที่ลงมือ`,
      lines: site.contacted === null
        ? ['ยังไม่เริ่มเก็บข้อมูล (รอ deploy ระบบนับการโทร/นำทาง)']
        : [
          `฿${fmtNum(site.contacted ? meta.spend / site.contacted : 0)} ต่อคน · กดหลายปุ่มนับเป็น 1 คน`,
          `ร้านตัวแทน: โทร ${fmtNum(site.contactBreakdown.phone)} · นำทาง ${fmtNum(site.contactBreakdown.directions)} คน`,
          `ปุ่มลอย: LINE ${fmtNum(site.contactBreakdown.floatingLine)} · โทร ${fmtNum(site.contactBreakdown.floatingPhone)} · Facebook ${fmtNum(site.contactBreakdown.floatingFacebook)} คน`,
          site.contactTrackingSince
            ? (since < site.contactTrackingSince ? `เริ่มนับตั้งแต่ ${fmtDate(site.contactTrackingSince)} ช่วงก่อนหน้านั้นไม่มีข้อมูล (ไม่ใช่ 0)` : `เริ่มนับตั้งแต่ ${fmtDate(site.contactTrackingSince)}`)
            : 'ระบบพร้อมนับแล้ว ยังไม่มีคนกดติดต่อ',
        ],
    },
    {
      key: 'retention', en: 'Retention', th: 'ซื้อซ้ำ / บอกต่อ',
      value: null, unit: '',
      lines: ['ยังไม่มีข้อมูล ต้องเชื่อมกับการลงทะเบียนรับประกันหรือข้อมูลจากตัวแทน'],
    },
  ];

  funnelEl.innerHTML = '';
  const canvas = document.createElement('canvas');
  canvas.className = 'ads-funnel-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  funnelEl.appendChild(canvas);
  const items = stages.map((s) => {
    const label = document.createElement('div');
    label.className = 'ads-funnel-label';
    label.innerHTML = `<span class="ads-funnel-icon">${FUNNEL_ICONS[s.key]}</span><span><strong>${s.en}</strong><small>${escapeHtml(s.th)}</small></span>`;

    const stats = document.createElement('div');
    stats.className = `ads-funnel-stats is-${s.key}`;
    stats.innerHTML = `<p class="ads-funnel-stats-name">${s.en} · ${escapeHtml(s.th)}</p>`
      + (s.value === null
        ? '<p class="ads-funnel-number is-empty"><strong>—</strong></p>'
        : `<p class="ads-funnel-number"><strong>${fmtNum(s.value)}</strong> ${s.unit}${s.conv ? `<span class="ads-funnel-conv">${escapeHtml(s.conv)}</span>` : ''}</p>`)
      + s.lines.map((l) => `<p class="ads-funnel-detail">${escapeHtml(l)}</p>`).join('');
    funnelEl.append(label, stats);
    return { label, stats };
  });
  const legend = document.createElement('p');
  legend.className = 'ads-funnel-legend';
  legend.innerHTML = '<span class="ads-funnel-legend-dot"></span> 1 จุด = 1 คน';
  funnelEl.appendChild(legend);

  const drawAll = () => {
    // On narrow screens the funnel takes the full width and stats stack below.
    const stacked = funnelEl.clientWidth < 620;
    funnelEl.classList.toggle('is-stacked', stacked);
    const geo = drawHoloFunnel(canvas, stages, { stacked });
    if (!geo) return;
    items.forEach(({ label, stats }, i) => {
      const { y } = geo.layout[i];
      label.style.left = `${geo.cx}px`;
      label.style.top = `${y + canvas.offsetTop}px`;
      stats.style.left = stacked ? '' : `${geo.statsLeft}px`;
      stats.style.top = stacked ? '' : `${y + canvas.offsetTop}px`;
    });
  };
  drawAll();
  if (adFunnelResizeObserver) adFunnelResizeObserver.disconnect();
  let lastWidth = 0;
  adFunnelResizeObserver = new ResizeObserver(() => {
    if (funnelEl.clientWidth === lastWidth) return;
    lastWidth = funnelEl.clientWidth;
    drawAll();
  });
  adFunnelResizeObserver.observe(funnelEl);
  if (!adFunnelThemeObserver) {
    adFunnelThemeObserver = new MutationObserver(() => adFunnelRedraw && adFunnelRedraw());
    adFunnelThemeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }
  adFunnelRedraw = drawAll;

  // Fill no-spend days so the x-axis is continuous.
  const byDate = new Map(data.daily.map((d) => [d.date, d]));
  const series = [];
  for (let d = since; d <= until; d = addDays(d, 1)) {
    series.push(byDate.get(d) || { date: d, reach: 0, engagement: 0, linkClicks: 0, visitors: 0, ctaClicked: 0, acted: 0, contacted: 0 });
  }
  dailyEl.innerHTML = '';
  [
    { key: 'reach', label: 'เห็นโฆษณา (คน)' },
    { key: 'engagement', label: 'มีส่วนร่วม (ครั้ง)' },
    { key: 'linkClicks', label: 'คลิกเข้าเว็บ (ครั้ง)' },
    { key: 'visitors', label: 'เข้าถึงเว็บ (คน)' },
    { key: 'acted', label: 'ลงมือ กดสั่งซื้อ/ติดต่อ (คน)' },
    ...(site.contacted === null ? [] : [{ key: 'contacted', label: 'ติดต่อเรา/ร้านตัวแทน (คน)' }]),
  ].forEach((m) => dailyEl.appendChild(renderFunnelMiniChart(series, m.key, m.label)));
}

function renderFunnelMiniChart(points, key, title) {
  const card = document.createElement('div');
  card.className = 'ads-funnel-mini';
  const h = document.createElement('p');
  h.className = 'ads-funnel-mini-title';
  const total = points.reduce((s, p) => s + p[key], 0);
  h.innerHTML = `${escapeHtml(title)} <span>รวม ${fmtNum(total)}</span>`;
  card.appendChild(h);

  const W = 300, H = 130;
  const padL = 34, padR = 10, padT = 10, padB = 22;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const maxV = niceMax(Math.max(...points.map((p) => p[key]), 1));
  const x = (i) => padL + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const y = (v) => padT + plotH - (v / maxV) * plotH;

  const svg = svgEl('svg', { class: 'ads-chart-svg', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': title });
  [0, maxV / 2, maxV].forEach((v) => {
    svg.appendChild(svgEl('line', { class: 'ads-grid-line', x1: padL, x2: W - padR, y1: y(v), y2: y(v) }));
    const lbl = svgEl('text', { class: 'ads-axis-label', x: padL - 6, y: y(v) + 4, 'text-anchor': 'end' });
    lbl.textContent = v.toLocaleString('th-TH', { maximumFractionDigits: 1 });
    svg.appendChild(lbl);
  });
  const edgeIdx = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])];
  edgeIdx.forEach((i) => {
    const lbl = svgEl('text', { class: 'ads-axis-label', x: x(i), y: H - 6, 'text-anchor': i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle' });
    lbl.textContent = fmtDate(points[i].date);
    svg.appendChild(lbl);
  });

  const markIdx = points.findIndex((p) => p.date === SITE_REDESIGN_DATE);
  if (markIdx >= 0) {
    svg.appendChild(svgEl('line', { class: 'ads-funnel-marker', x1: x(markIdx), x2: x(markIdx), y1: padT, y2: padT + plotH }));
  }

  svg.appendChild(svgEl('path', { class: 'ads-line-mark', d: points.map((p, i) => `${i ? 'L' : 'M'} ${x(i)} ${y(p[key])}`).join(' ') }));
  points.forEach((p, i) => svg.appendChild(svgEl('circle', { class: 'ads-end-dot', cx: x(i), cy: y(p[key]), r: 3.5 })));

  const crosshair = svgEl('line', { class: 'ads-crosshair', x1: 0, x2: 0, y1: padT, y2: padT + plotH });
  svg.appendChild(crosshair);
  const hit = svgEl('rect', { x: padL - 8, y: 0, width: plotW + 16, height: H, fill: 'transparent' });
  svg.appendChild(hit);
  card.appendChild(svg);

  const tooltip = document.createElement('div');
  tooltip.className = 'ads-chart-tooltip';
  card.appendChild(tooltip);

  hit.addEventListener('pointermove', (evt) => {
    const rect = svg.getBoundingClientRect();
    const px = ((evt.clientX - rect.left) / rect.width) * W;
    let i = 0;
    points.forEach((_, j) => { if (Math.abs(x(j) - px) < Math.abs(x(i) - px)) i = j; });
    crosshair.setAttribute('x1', x(i));
    crosshair.setAttribute('x2', x(i));
    crosshair.style.opacity = '1';
    tooltip.innerHTML = `<div class="tt-row"><span class="tt-label">${fmtDate(points[i].date)}</span><span class="tt-value">${fmtNum(points[i][key])}</span></div>`;
    tooltip.classList.add('visible');
    const scale = rect.width / W;
    tooltip.style.left = Math.min(x(i) * scale, rect.width - 100) + 'px';
    tooltip.style.top = (svg.offsetTop + y(points[i][key]) * scale - 44) + 'px';
  });
  hit.addEventListener('pointerleave', () => {
    crosshair.style.opacity = '0';
    tooltip.classList.remove('visible');
  });
  return card;
}

// ─── CTR by campaign bar chart ─────────────────────────────────────────
function renderCtrChart(entries) {
  const container = document.getElementById('adCtrChart');
  container.innerHTML = '';

  const items = aggregateByCampaign(entries).sort((a, b) => b.ctr - a.ctr);
  const bestId = items[0].id;
  const worstId = items[items.length - 1].id;

  const rowH = 36, barH = 20, labelW = 190;
  const W = 760, H = items.length * rowH + 16;
  const plotW = W - labelW - 70;
  const maxCtr = niceMax(Math.max(...items.map((e) => e.ctr)) * 1.15);

  const svg = svgEl('svg', { class: 'ads-chart-svg', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'CTR แยกตามแคมเปญ' });

  items.forEach((e, i) => {
    const cy = 16 + i * rowH;
    const barW = Math.max((e.ctr / maxCtr) * plotW, 2);
    const isBest = e.id === bestId;
    const isWorst = e.id === worstId && items.length > 1;

    const nameLabel = svgEl('text', { class: 'ads-bar-name', x: 0, y: cy + barH / 2 + 4 });
    const name = e.campaignName.length > 26 ? e.campaignName.slice(0, 25) + '…' : e.campaignName;
    nameLabel.textContent = (isBest ? '✅ ' : isWorst ? '⚠️ ' : '') + name;
    const nameTitle = svgEl('title', {});
    nameTitle.textContent = e.campaignName;
    nameLabel.appendChild(nameTitle);
    svg.appendChild(nameLabel);

    const bar = svgEl('rect', {
      class: `ads-bar${isBest ? ' is-good' : isWorst ? ' is-warning' : ''}`,
      x: labelW, y: cy, width: barW, height: barH, rx: 4, tabindex: 0,
    });
    svg.appendChild(bar);

    const valueLabel = svgEl('text', { class: 'ads-bar-label', x: labelW + barW + 8, y: cy + barH / 2 + 4 });
    valueLabel.textContent = fmtPct(e.ctr);
    svg.appendChild(valueLabel);
  });

  container.appendChild(svg);

  const tooltip = document.createElement('div');
  tooltip.className = 'ads-chart-tooltip ads-chart-tooltip-rich';
  container.appendChild(tooltip);

  const bars = svg.querySelectorAll('.ads-bar');
  bars.forEach((bar, i) => {
    const e = items[i];
    function show(evt) {
      tooltip.innerHTML = '';
      const nameRow = document.createElement('div');
      nameRow.className = 'tt-value';
      nameRow.textContent = e.campaignName;
      tooltip.appendChild(nameRow);

      if (e.sampleCreativeImageUrl || e.creativeNames.length) {
        const creativeRow = document.createElement('div');
        creativeRow.className = 'ads-creative-cell';
        creativeRow.style.margin = '6px 0';
        if (e.sampleCreativeImageUrl) {
          const img = document.createElement('img');
          img.className = 'ads-creative-thumb';
          img.src = e.sampleCreativeImageUrl;
          img.alt = '';
          creativeRow.appendChild(img);
        }
        const nm = document.createElement('span');
        nm.className = 'tt-label';
        nm.textContent = e.creativeNames.join(', ') || '—';
        creativeRow.appendChild(nm);
        tooltip.appendChild(creativeRow);
      }
      if (e.sampleAudience) {
        const audRow = document.createElement('div');
        audRow.className = 'tt-label';
        audRow.style.marginBottom = '6px';
        audRow.textContent = `🎯 ${e.sampleAudience}`;
        tooltip.appendChild(audRow);
      }

      [
        ['งบใช้', fmtBaht(e.spend)],
        ['เข้าถึง', fmtNum(e.reach)],
        ['คลิกเข้าเว็บ', fmtNum(e.clicks)],
        ['CTR', fmtPct(e.ctr)],
        ['CPC', fmtBaht(e.cpc)],
      ].forEach(([label, value]) => {
        const row = document.createElement('div');
        row.className = 'tt-row';
        const l = document.createElement('span');
        l.className = 'tt-label';
        l.textContent = label;
        const v = document.createElement('span');
        v.className = 'tt-value';
        v.textContent = value;
        row.appendChild(l);
        row.appendChild(v);
        tooltip.appendChild(row);
      });
      tooltip.classList.add('visible');
      const rect = container.getBoundingClientRect();
      const barRect = bar.getBoundingClientRect();
      tooltip.style.left = Math.min(barRect.left - rect.left, rect.width - 160) + 'px';
      tooltip.style.top = (barRect.top - rect.top - 8) + 'px';
    }
    function hide() { tooltip.classList.remove('visible'); }
    bar.addEventListener('pointermove', show);
    bar.addEventListener('focus', show);
    bar.addEventListener('pointerleave', hide);
    bar.addEventListener('blur', hide);
  });
}

// ─── Date filters ───────────────────────────────────────────────────────
function dateKey(d) { return new Date(d).toISOString().slice(0, 10); }
function startOfWeek(d) { const dt = new Date(d); const day = (dt.getDay() + 6) % 7; dt.setDate(dt.getDate() - day); dt.setHours(0, 0, 0, 0); return dt; }
function endOfWeek(d) { const s = startOfWeek(d); const e = new Date(s); e.setDate(s.getDate() + 6); e.setHours(23, 59, 59, 999); return e; }
function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function endOfMonth(d) { return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999); }

function computePresetRange(mode) {
  const now = new Date();
  if (mode === 'today') {
    const s = new Date(now); s.setHours(0, 0, 0, 0);
    const e = new Date(now); e.setHours(23, 59, 59, 999);
    return [s, e];
  }
  if (mode === 'yesterday') {
    const s = new Date(now); s.setDate(s.getDate() - 1); s.setHours(0, 0, 0, 0);
    const e = new Date(s); e.setHours(23, 59, 59, 999);
    return [s, e];
  }
  if (mode === 'thisWeek') return [startOfWeek(now), endOfWeek(now)];
  if (mode === 'lastWeek') {
    const s = startOfWeek(now); s.setDate(s.getDate() - 7);
    const e = new Date(s); e.setDate(s.getDate() + 6); e.setHours(23, 59, 59, 999);
    return [s, e];
  }
  if (mode === 'thisMonth') return [startOfMonth(now), endOfMonth(now)];
  if (mode === 'lastMonth') {
    const s = startOfMonth(new Date(now.getFullYear(), now.getMonth() - 1, 1));
    return [s, endOfMonth(s)];
  }
  return [null, null];
}

// One calendar grid does everything: plain click toggles a single day,
// shift-click grabs a contiguous range from the last plain-clicked day —
// both just add to the same filterDates set. Preset buttons are a shortcut
// that pre-selects the matching days on that same calendar.
let filterDates = new Set();
let dataDatesSet = new Set();
let calAnchorDate = null;
let calViewYear = null;
let calViewMonth = null;

function filterEntries(all) {
  if (!filterDates.size) return all;
  return all.filter((e) => filterDates.has(dateKey(e.date)));
}

function datesInPreset(mode, availableDates) {
  const [s, e] = computePresetRange(mode);
  return availableDates.filter((d) => {
    const t = new Date(d + 'T12:00:00').getTime();
    return t >= s.getTime() && t <= e.getTime();
  });
}

function activePresetForDates(availableDates) {
  if (!filterDates.size) return 'all';
  for (const mode of ['today', 'yesterday', 'thisWeek', 'lastWeek', 'thisMonth', 'lastMonth']) {
    const expected = new Set(datesInPreset(mode, availableDates));
    if (expected.size && expected.size === filterDates.size && [...expected].every((d) => filterDates.has(d))) {
      return mode;
    }
  }
  return null;
}

function syncFilterBtns() {
  const active = activePresetForDates([...dataDatesSet]);
  document.querySelectorAll('.cal-filter-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.range === active);
  });
}

// ─── Calendar date picker ───────────────────────────────────────────────
function updateCalBadge() {
  const badge = document.getElementById('adCalToggleBadge');
  badge.hidden = filterDates.size === 0;
  badge.textContent = filterDates.size;
}

function renderDatePicker() {
  updateCalBadge();
  const label = document.getElementById('adCalMonthLabel');
  const grid = document.getElementById('adCalGrid');
  const display = new Date(calViewYear, calViewMonth, 1);
  label.textContent = display.toLocaleDateString('th-TH', { month: 'long', year: 'numeric' });

  grid.innerHTML = '';
  const dayNames = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];
  dayNames.forEach((n) => {
    const hdr = document.createElement('div');
    hdr.className = 'ads-cal-day-header';
    hdr.textContent = n;
    grid.appendChild(hdr);
  });

  const firstWeekday = display.getDay();
  const daysInMonth = new Date(calViewYear, calViewMonth + 1, 0).getDate();
  const todayKeyStr = dateKey(new Date());

  for (let i = 0; i < firstWeekday; i++) {
    const blank = document.createElement('div');
    blank.className = 'ads-cal-cell ads-cal-blank';
    grid.appendChild(blank);
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const key = `${calViewYear}-${String(calViewMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const cell = document.createElement('div');
    cell.className = 'ads-cal-cell';
    cell.dataset.date = key;
    if (key === todayKeyStr) cell.classList.add('ads-cal-today');
    if (!dataDatesSet.has(key)) cell.classList.add('ads-cal-no-data');
    if (filterDates.has(key)) cell.classList.add('ads-cal-selected');
    cell.tabIndex = 0;

    const num = document.createElement('span');
    num.textContent = d;
    cell.appendChild(num);
    if (dataDatesSet.has(key)) cell.appendChild(document.createElement('span')).className = 'ads-cal-dot';

    cell.addEventListener('click', (evt) => {
      if (evt.shiftKey && calAnchorDate) {
        const [lo, hi] = [calAnchorDate, key].sort();
        const cur = new Date(lo + 'T00:00:00');
        const end = new Date(hi + 'T00:00:00');
        while (cur <= end) { filterDates.add(dateKey(cur)); cur.setDate(cur.getDate() + 1); }
      } else {
        if (filterDates.has(key)) filterDates.delete(key); else filterDates.add(key);
        calAnchorDate = key;
      }
      syncFilterBtns();
      renderDatePicker();
      applyFiltersAndRender();
    });
    grid.appendChild(cell);
  }
}

document.getElementById('adCalPrevBtn').addEventListener('click', () => {
  calViewMonth -= 1;
  if (calViewMonth < 0) { calViewMonth = 11; calViewYear -= 1; }
  renderDatePicker();
});
document.getElementById('adCalNextBtn').addEventListener('click', () => {
  calViewMonth += 1;
  if (calViewMonth > 11) { calViewMonth = 0; calViewYear += 1; }
  renderDatePicker();
});

// ─── Wiring ─────────────────────────────────────────────────────────────
const adInsightsEmpty = document.getElementById('adInsightsEmpty');
const adInsightsBody = document.getElementById('adInsightsBody');
const adFilteredEmpty = document.getElementById('adFilteredEmpty');
const adInsightsContent = document.getElementById('adInsightsContent');
let rawEntries = [];

function applyFiltersAndRender() {
  const filtered = filterEntries(rawEntries);
  if (!filtered.length) {
    adFilteredEmpty.hidden = false;
    adInsightsContent.hidden = true;
    return;
  }
  adFilteredEmpty.hidden = true;
  adInsightsContent.hidden = false;
  renderStatTiles(filtered);
  renderInsights(filtered);
  renderAdFunnel(filtered);
  renderSpendChart(filtered);
  renderCtrChart(filtered);
  renderCampaignTree(filtered);
  renderAdUtmVisits();
}

// Site-side visits from paid-ad links, over the same days as the date filter
// (or from the first ad day onward when no filter is set).
function adUtmRange() {
  const days = filterDates.size ? [...filterDates] : rawEntries.map((e) => dateKey(e.date));
  const sorted = days.sort();
  const since = new Date(`${sorted[0]}T00:00:00`);
  const until = filterDates.size ? new Date(`${sorted[sorted.length - 1]}T23:59:59.999`) : new Date();
  return [since, until];
}

let adUtmRequestId = 0;
async function renderAdUtmVisits() {
  const tbody = document.getElementById('adUtmBody');
  const requestId = ++adUtmRequestId;
  const range = adUtmRange();
  try {
    const params = new URLSearchParams({ since: range[0].toISOString(), until: range[1].toISOString() });
    const res = await fetch(`/api/ad-utm-visits?${params.toString()}`);
    const data = await res.json();
    if (requestId !== adUtmRequestId) return; // a newer filter change already re-rendered
    renderUtmTable(tbody, data.utmCampaigns || [], () => range, 'ยังไม่มีผู้เข้าชมจากโฆษณาในช่วงเวลานี้', { withScroll: true });
  } catch (e) {
    if (requestId === adUtmRequestId) tbody.innerHTML = '<tr><td colspan="11">โหลดข้อมูลผู้เข้าชมไม่สำเร็จ</td></tr>';
  }
}

let calInitialized = false;
function renderAdInsights(entries) {
  rawEntries = entries;
  if (!entries.length) {
    adInsightsEmpty.hidden = false;
    adInsightsBody.hidden = true;
    return;
  }
  adInsightsEmpty.hidden = true;
  adInsightsBody.hidden = false;
  dataDatesSet = new Set(entries.map((e) => dateKey(e.date)));
  if (!calInitialized) {
    const mostRecent = [...dataDatesSet].sort().pop();
    const view = mostRecent ? new Date(mostRecent + 'T12:00:00') : new Date();
    calViewYear = view.getFullYear();
    calViewMonth = view.getMonth();
    calInitialized = true;
  }
  renderDatePicker();
  applyFiltersAndRender();
}

let adInsightsSignature = null;
function renderAdLastSynced(iso) {
  const el = document.getElementById('adInsightsLastSynced');
  if (!iso) { el.hidden = true; return; }
  const d = new Date(iso);
  el.textContent = `🕐 อัปเดตล่าสุด: ${d.toLocaleString('th-TH', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
  el.hidden = false;
}

async function fetchAdInsights() {
  const res = await fetch('/api/ad-insights');
  const data = await res.json();
  const sig = JSON.stringify(data.entries);
  if (sig !== adInsightsSignature) {
    adInsightsSignature = sig;
    renderAdInsights(data.entries || []);
  }
  renderAdLastSynced(data.lastSyncedAt);
}

// ─── Daily budget box (live from Meta, not affected by the date filter) ───
async function renderAdBudgets(fresh) {
  const box = document.getElementById('adBudgetBox');
  try {
    const res = await fetch(`/api/ad-budgets${fresh ? '?fresh=1' : ''}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    const rows = data.campaigns.map((c) => {
      const amount = c.daily > 0 ? `${fmtBaht(c.daily)}/วัน` : c.lifetime > 0 ? `${fmtBaht(c.lifetime)} ทั้งแคมเปญ` : '–';
      const status = c.running ? '' : c.pendingReview ? '<span class="ads-budget-tag">รอ Facebook ตรวจ</span>' : '<span class="ads-budget-tag">ยังไม่วิ่ง</span>';
      return `<li><span class="ads-budget-name">${escapeHtml(c.name)} ${status}</span><span class="ads-budget-amount">${amount}</span></li>`;
    }).join('');
    box.innerHTML = `
      <div class="ads-budget-head">
        <p class="ads-stat-label">งบที่ตั้งไว้ตอนนี้ (ทุกแคมเปญที่เปิดอยู่)</p>
        <p class="ads-budget-total">${fmtBaht(data.totalDaily)}<span>/วัน</span></p>
        <p class="ads-budget-month">ประมาณ ${fmtBaht(data.totalDaily * 30)} ต่อเดือน</p>
      </div>
      ${rows ? `<ul class="ads-budget-list">${rows}</ul>` : '<p class="key-messages-hint">ไม่มีแคมเปญที่เปิดอยู่</p>'}`;
    box.hidden = false;
  } catch (e) {
    box.innerHTML = `<p class="key-messages-hint">โหลดงบไม่สำเร็จ: ${escapeHtml(e.message)}</p>`;
    box.hidden = false;
  }
}

fetchAdInsights();
renderAdBudgets();
setInterval(() => { if (!document.hidden) { fetchAdInsights(); renderAdBudgets(); } }, 30000);

document.getElementById('adInsightsRefreshBtn').addEventListener('click', () => {
  adInsightsSignature = null;
  fetchAdInsights();
  renderAdBudgets(true);
});

document.querySelectorAll('.cal-filter-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const mode = btn.dataset.range;
    calAnchorDate = null;
    if (mode === 'all') {
      filterDates = new Set();
    } else {
      const matched = datesInPreset(mode, [...dataDatesSet]);
      // No synced data falls inside this preset yet (e.g. "วันนี้" before the
      // daily sync has run) — an empty Set here would otherwise be read by
      // filterEntries() as "no filter", silently showing all-time data
      // instead of correctly showing "nothing for today". A sentinel date
      // that can never match a real entry keeps the filter genuinely active.
      filterDates = matched.length ? new Set(matched) : new Set(['__none__']);
      const firstDate = matched.sort()[0];
      if (firstDate) {
        const view = new Date(firstDate + 'T12:00:00');
        calViewYear = view.getFullYear();
        calViewMonth = view.getMonth();
      }
    }
    document.querySelectorAll('.cal-filter-btn').forEach((b) => b.classList.toggle('active', b === btn));
    renderDatePicker();
    applyFiltersAndRender();
  });
});

document.getElementById('adDateClearBtn').addEventListener('click', () => {
  filterDates = new Set();
  calAnchorDate = null;
  syncFilterBtns();
  renderDatePicker();
  applyFiltersAndRender();
});

const adCalToggleBtn = document.getElementById('adCalToggleBtn');
const adDatepickerPopover = document.getElementById('adDatepickerPopover');
function openCalPopover() {
  adDatepickerPopover.hidden = false;
  adCalToggleBtn.setAttribute('aria-expanded', 'true');
}
function closeCalPopover() {
  adDatepickerPopover.hidden = true;
  adCalToggleBtn.setAttribute('aria-expanded', 'false');
}
adCalToggleBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (adDatepickerPopover.hidden) openCalPopover(); else closeCalPopover();
});
document.addEventListener('click', (e) => {
  if (!adDatepickerPopover.hidden && !adDatepickerPopover.contains(e.target) && e.target !== adCalToggleBtn) {
    closeCalPopover();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !adDatepickerPopover.hidden) closeCalPopover();
});

// ─── Ad Action Log ──────────────────────────────────────────────────────────
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatLogDate(iso) {
  const d = new Date(iso);
  return d.toLocaleString('th-TH', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

async function loadAdActionLog() {
  try {
    const res = await fetch('/api/ad-action-log');
    const { entries } = await res.json();
    const list = document.getElementById('adActionLogList');
    const empty = document.getElementById('adActionLogEmpty');
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
        await fetch(`/api/ad-action-log/${btn.dataset.id}`, { method: 'DELETE' });
        loadAdActionLog();
      });
    });
  } catch (e) { console.error('Failed to load ad action log:', e.message); }
}

document.getElementById('adActionLogForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('adActionLogInput');
  const text = input.value.trim();
  if (!text) return;
  await fetch('/api/ad-action-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  input.value = '';
  loadAdActionLog();
});

loadAdActionLog();
