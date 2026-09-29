// ─── UTM campaigns table + per-visitor journey ─────────────────────────────
// Shared by website.html (all UTM traffic) and ads.html (paid ads only).
// Each page passes its own rows and a getRange() returning [since, until]
// Dates, so the journey drill-down stays in sync with that page's filter.
const UTM_PATH_LABELS = {
  '/': 'หน้าแรก',
  '/products': 'สินค้า',
  '/articles': 'บทความ',
  '/compare': 'เปรียบเทียบรุ่น',
  '/btu-guide': 'คู่มือเลือก BTU',
  '/error-code': 'รหัสข้อผิดพลาด',
  '/repair-parts': 'แจ้งซ่อม/อะไหล่',
  '/warranty': 'ลงทะเบียนรับประกัน',
  '/dealers': 'ตัวแทนจำหน่าย',
  '/contact': 'ติดต่อ',
  '/troubleshooting': 'แก้ปัญหาเบื้องต้น',
};
function utmPathLabel(path) { return UTM_PATH_LABELS[path] || path; }
function utmViewLabel(v) { return v.label || utmPathLabel(v.path); }
function utmFmtNum(n) { return Math.round(n).toLocaleString('th-TH'); }
function utmFmtDuration(seconds) {
  if (seconds < 60) return `${Math.round(seconds)} วิ`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return s > 0 ? `${m} นาที ${s} วิ` : `${m} นาที`;
}
function utmFmtDateTime(d) {
  return new Date(d).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' });
}

// Scroll depth only exists for pageviews recorded after tasaki-web started
// tracking it (2026-09-29 16:17) — older views come back as 0 and get no note
// rather than a misleading "เลื่อน 0%".
function utmScrollNote(v) {
  if (!v.maxScrollPct) return '';
  const parts = [`เลื่อน ${v.maxScrollPct}%`];
  if (v.dealerCtaClicked) parts.push('กดปุ่มหาตัวแทน');
  else if (v.dealerCtaSeen) parts.push('เห็นปุ่มหาตัวแทน');
  return ` [${parts.join(', ')}]`;
}

async function loadUtmSessionJourney(row, [since, until]) {
  const params = new URLSearchParams({
    source: row.source || '', medium: row.medium || '', campaign: row.campaign || '', content: row.content || '',
    since: since.toISOString(), until: until.toISOString(),
  });
  const res = await fetch(`/api/website-utm-sessions?${params.toString()}`);
  return res.json();
}

// "Which pages did this campaign's visitors open" at a glance, before the
// per-visitor lines — with 30+ single-page visitors the journey list alone is
// too long to read.
function renderUtmPageSummary(sessions) {
  const counts = new Map();
  sessions.forEach((s) => {
    new Set(s.views.map(utmViewLabel)).forEach((label) => counts.set(label, (counts.get(label) || 0) + 1));
  });
  const line = document.createElement('div');
  line.className = 'utm-journey-line utm-journey-summary';
  const label = document.createElement('span');
  label.className = 'utm-journey-label';
  label.textContent = `หน้าที่เข้าชม (จาก ${utmFmtNum(sessions.length)} คน): `;
  line.appendChild(label);
  const text = document.createElement('span');
  text.textContent = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([page, n]) => `${page} ${utmFmtNum(n)} คน`)
    .join(' · ');
  line.appendChild(text);

  const seen = sessions.filter((s) => s.views.some((v) => v.dealerCtaSeen)).length;
  const clicked = sessions.filter((s) => s.views.some((v) => v.dealerCtaClicked)).length;
  const tracked = sessions.filter((s) => s.views.some((v) => v.maxScrollPct)).length;
  const frag = document.createDocumentFragment();
  frag.appendChild(line);
  if (tracked) {
    const ctaLine = document.createElement('div');
    ctaLine.className = 'utm-journey-line utm-journey-summary';
    ctaLine.textContent = `ปุ่มหาตัวแทน (จาก ${utmFmtNum(tracked)} คนที่วัดระยะเลื่อนได้): เห็น ${utmFmtNum(seen)} คน · กด ${utmFmtNum(clicked)} คน`;
    frag.appendChild(ctaLine);
  }
  return frag;
}

// withScroll adds scroll-depth / dealer-button columns (Ads page). Those are
// counted only over visitors whose scroll was measured, so "–" means none were.
function utmScrollCells(r) {
  if (!r.scrollTracked) return ['–', '–', '–'];
  const of = ` / ${utmFmtNum(r.scrollTracked)}`;
  const each = (r.scrollList || []).map((p) => `${p}%`).join(' · ');
  return [each, `${utmFmtNum(r.ctaSeen)}${of}`, `${utmFmtNum(r.ctaClicked)}${of}`];
}

// One visitor's furthest scroll across their pages + what happened with the
// dealer button, shown up front on their journey line.
function utmVisitorScrollBadge(views) {
  const pct = Math.max(0, ...views.map((v) => v.maxScrollPct || 0));
  if (!pct) return null;
  const badge = document.createElement('span');
  badge.className = 'utm-scroll-badge';
  const bar = document.createElement('span');
  bar.className = 'utm-scroll-bar';
  const fill = document.createElement('span');
  fill.style.width = `${pct}%`;
  bar.appendChild(fill);
  badge.appendChild(bar);
  let cta = 'ไม่ถึงปุ่มหาตัวแทน';
  if (views.some((v) => v.dealerCtaClicked)) cta = 'กดปุ่มหาตัวแทน';
  else if (views.some((v) => v.dealerCtaSeen)) cta = 'เห็นปุ่มหาตัวแทน';
  badge.appendChild(document.createTextNode(` เลื่อน ${pct}% · ${cta} `));
  return badge;
}

function renderUtmTable(tbody, rows, getRange, emptyText, { withScroll = false } = {}) {
  const colCount = withScroll ? 11 : 8;
  tbody.innerHTML = '';
  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = colCount;
    td.textContent = emptyText;
    td.style.textAlign = 'center';
    td.style.color = 'var(--text-muted, #888)';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }
  rows.forEach((r) => {
    const tr = document.createElement('tr');
    tr.className = 'utm-row-clickable';
    tr.title = 'คลิกเพื่อดูเส้นทางการเข้าชม';
    [
      r.source || '-',
      r.medium || '-',
      r.campaign || '-',
      r.content || '-',
      utmFmtNum(r.sessions),
      utmFmtNum(r.views),
      utmFmtDateTime(r.firstSeen),
      utmFmtDateTime(r.lastSeen),
      ...(withScroll ? utmScrollCells(r) : []),
    ].forEach((val, idx) => {
      const td = document.createElement('td');
      td.textContent = val;
      if (idx === 4 || idx === 5 || idx >= 8) td.className = 'ads-num';
      tr.appendChild(td);
    });

    const detailTr = document.createElement('tr');
    detailTr.hidden = true;
    const detailTd = document.createElement('td');
    detailTd.colSpan = colCount;
    detailTd.className = 'utm-journey-cell';
    detailTr.appendChild(detailTd);

    let loaded = false;
    tr.addEventListener('click', async () => {
      const opening = detailTr.hidden;
      detailTr.hidden = !opening;
      if (opening && !loaded) {
        detailTd.textContent = 'กำลังโหลด...';
        try {
          const { sessions } = await loadUtmSessionJourney(r, getRange());
          loaded = true;
          detailTd.innerHTML = '';
          if (!sessions.length) {
            detailTd.textContent = 'ไม่พบข้อมูลเส้นทางในช่วงเวลานี้';
          } else {
            detailTd.appendChild(renderUtmPageSummary(sessions));
            sessions.forEach((s, i) => {
              const line = document.createElement('div');
              line.className = 'utm-journey-line';
              // A single-pageview session has no second timestamp to measure
              // against — showing "0 วิ" would falsely imply they left
              // instantly, when really we just can't tell how long they stayed.
              const durationText = s.views.length > 1
                ? utmFmtDuration((new Date(s.views[s.views.length - 1].createdAt) - new Date(s.views[0].createdAt)) / 1000)
                : 'ดูหน้าเดียว ไม่ทราบระยะเวลา';
              const label = document.createElement('span');
              label.className = 'utm-journey-label';
              const who = sessions.length > 1 ? `ผู้เข้าชมคนที่ ${i + 1}` : 'อยู่บนเว็บ';
              label.textContent = `${who} (${durationText}): `;
              line.appendChild(label);
              const badge = utmVisitorScrollBadge(s.views);
              if (badge) line.appendChild(badge);
              const path = document.createElement('span');
              path.textContent = s.views.map((v, j) => {
                const name = `${utmViewLabel(v)}${utmScrollNote(v)}`;
                if (j === s.views.length - 1) return name;
                const stepSec = (new Date(s.views[j + 1].createdAt) - new Date(v.createdAt)) / 1000;
                return `${name} (${utmFmtDuration(stepSec)})`;
              }).join(' → ');
              line.appendChild(path);
              detailTd.appendChild(line);
            });
          }
        } catch (e) {
          detailTd.textContent = 'โหลดเส้นทางไม่สำเร็จ';
        }
      }
    });

    tbody.appendChild(tr);
    tbody.appendChild(detailTr);
  });
}
