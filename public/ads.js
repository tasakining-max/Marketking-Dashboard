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
    { label: 'คลิกรวม', value: fmtNum(totalClicks) },
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
        ['คลิก', fmtNum(e.clicks)],
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

// ─── Data table (accessible fallback for both charts) ──────────────────
function renderTable(entries) {
  const tbody = document.getElementById('adInsightsTableBody');
  tbody.innerHTML = '';
  const sorted = [...entries].sort((a, b) => new Date(b.date) - new Date(a.date));
  sorted.forEach((e) => {
    const tr = document.createElement('tr');

    const dateTd = document.createElement('td');
    dateTd.textContent = fmtDate(e.date);
    tr.appendChild(dateTd);

    const campaignTd = document.createElement('td');
    campaignTd.textContent = e.campaignName;
    tr.appendChild(campaignTd);

    const creativeTd = document.createElement('td');
    const creativeWrap = document.createElement('div');
    creativeWrap.className = 'ads-creative-cell';
    if (e.creativeImageUrl) {
      const img = document.createElement('img');
      img.className = 'ads-creative-thumb';
      img.src = e.creativeImageUrl;
      img.alt = e.creativeName || '';
      creativeWrap.appendChild(img);
    }
    const creativeName = document.createElement('span');
    creativeName.className = 'ads-creative-name';
    creativeName.textContent = e.creativeName || '—';
    creativeWrap.appendChild(creativeName);
    creativeTd.appendChild(creativeWrap);
    tr.appendChild(creativeTd);

    const audienceTd = document.createElement('td');
    audienceTd.className = 'ads-audience';
    audienceTd.textContent = e.targetAudience || '—';
    tr.appendChild(audienceTd);

    [
      fmtNum(e.spend),
      fmtNum(e.reach),
      fmtNum(e.clicks),
      fmtPct(e.ctr),
      fmtNum(e.cpc),
    ].forEach((val) => {
      const td = document.createElement('td');
      td.className = 'ads-num';
      td.textContent = val;
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
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
  for (const mode of ['today', 'thisWeek', 'lastWeek', 'thisMonth', 'lastMonth']) {
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
  renderSpendChart(filtered);
  renderCtrChart(filtered);
  renderTable(filtered);
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
async function fetchAdInsights() {
  const res = await fetch('/api/ad-insights');
  const data = await res.json();
  const sig = JSON.stringify(data.entries);
  if (sig !== adInsightsSignature) {
    adInsightsSignature = sig;
    renderAdInsights(data.entries || []);
  }
}

fetchAdInsights();
setInterval(() => { if (!document.hidden) fetchAdInsights(); }, 30000);

document.getElementById('adInsightsRefreshBtn').addEventListener('click', () => {
  adInsightsSignature = null;
  fetchAdInsights();
});

document.querySelectorAll('.cal-filter-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const mode = btn.dataset.range;
    calAnchorDate = null;
    if (mode === 'all') {
      filterDates = new Set();
    } else {
      filterDates = new Set(datesInPreset(mode, [...dataDatesSet]));
      const firstDate = [...filterDates].sort()[0];
      if (firstDate) {
        const view = new Date(firstDate + 'T12:00:00');
        calViewYear = view.getFullYear();
        calViewMonth = view.getMonth();
      }
    }
    syncFilterBtns();
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
