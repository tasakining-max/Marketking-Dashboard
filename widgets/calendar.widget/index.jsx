// Übersicht desktop widget: this month's Report-page calendar (shoot / plan /
// published cards) from the local dashboard. Holidays and working Saturdays
// are read from public/report.js so there is one list to maintain.
// Install: symlink this folder into ~/Library/Application Support/Übersicht/widgets/
import { run, css } from 'uebersicht';

const BASE = 'http://localhost:5050';
const SEP = '@@@SPLIT@@@';

export const command = `curl -s ${BASE}/api/cards; echo '${SEP}'; curl -s ${BASE}/report.js`;
// Local curl, so poll often: a date changed on the dashboard shows within ~30 s.
export const refreshFrequency = 30 * 1000;

// ‹ › month buttons: the month offset from today lives in widget state.
export const initialState = { output: '', error: null, offset: 0 };
export const updateState = (event, prev) => {
  if (event.type === 'UB/COMMAND_RAN') return { ...prev, output: event.output, error: event.error };
  if (event.type === 'MONTH') return { ...prev, offset: event.offset };
  return prev;
};

const THAI_MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
const DAY_NAMES = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];

export const className = `
  /* Centred on the 1920x1080 screen; whole px only — a fractional
     translate(-50%) made the text blurry. zoom scales top/left too. */
  zoom: 1.5;
  top: 140px;
  left: 389px;
  width: 470px;
  font-family: -apple-system, 'Sukhumvit Set', sans-serif;
  color: #fff;
  background: rgba(150, 170, 190, 0.22);
  backdrop-filter: blur(30px) saturate(1.4);
  -webkit-backdrop-filter: blur(30px) saturate(1.4);
  border: 1px solid rgba(255, 255, 255, 0.22);
  border-radius: 22px;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.25);
  padding: 16px 16px 12px;
  user-select: none;
  -webkit-user-select: none;
`;

// The block between `const NAME = {` / `new Set([` and its closing bracket.
function block(src, name) {
  const i = src.indexOf(name);
  if (i < 0) return '';
  const j = src.indexOf(name.includes('Set') ? ']);' : '};', i);
  return src.slice(i, j);
}

function parse(output) {
  const [cardsJson, reportJs = ''] = output.split(SEP);
  const holidays = {};
  for (const m of block(reportJs, 'HOLIDAYS_2026 = {').matchAll(/'(\d{4}-\d{2}-\d{2})':\s*'([^']*)'/g)) holidays[m[1]] = m[2];
  const workSat = new Set([...block(reportJs, 'WORKING_SATURDAYS_2026 = new Set').matchAll(/'(\d{4}-\d{2}-\d{2})'/g)].map((m) => m[1]));
  return { cards: JSON.parse(cardsJson).cards || [], holidays, workSat };
}

const openUrl = (url) => run(`open '${url}'`);

const s = {
  head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  title: { fontSize: 15, fontWeight: 700, cursor: 'pointer' },
  nav: { width: 22, height: 22, lineHeight: '20px', textAlign: 'center', borderRadius: 11, background: 'rgba(255,255,255,0.14)', fontSize: 15, fontWeight: 700, cursor: 'pointer' },
  legend: { fontSize: 10.5, color: 'rgba(255,255,255,0.7)' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 3 },
  dayName: { fontSize: 10.5, fontWeight: 700, textAlign: 'center', color: 'rgba(255,255,255,0.6)', paddingBottom: 2 },
  cell: { minWidth: 0, minHeight: 58, borderRadius: 9, padding: '3px 4px', background: 'rgba(255, 255, 255, 0.06)' },
  num: { fontSize: 11.5, fontWeight: 700, display: 'inline-block', minWidth: 18, height: 18, lineHeight: '18px', textAlign: 'center', borderRadius: 9 },
  hol: { fontSize: 8.5, color: '#ffb3b3', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  chip: { display: 'block', fontSize: 9, lineHeight: '12px', marginTop: 2, padding: '1px 3px', borderRadius: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', cursor: 'pointer' },
};
const COLUMN_LABEL = { idea: '💡 ไอเดีย', clip: '✂️ กำลังทำคลิป', published: '✅ ลงแล้ว' };
const PLATFORM_LABEL = { facebook: 'FB', instagram: 'IG', tiktok: 'TikTok', youtube: 'YT' };
const thaiDate = (ts) => {
  const d = new Date(ts);
  return `${d.getDate()} ${THAI_MONTHS[d.getMonth()].slice(0, 3)}. ${String(d.getFullYear() + 543).slice(2)}`;
};

// Hover a card → its detail box. Plain CSS :hover; dispatching state from
// onMouseEnter never reached the widget.
const hoverCell = css`position: relative; &:hover { z-index: 20; }`;
const hoverChip = css`position: relative; display: block; & > .detail { display: none; } &:hover > .detail { display: block; }`;

const pop = {
  box: { position: 'absolute', top: 0, zIndex: 10, width: 230, padding: 10, borderRadius: 12, background: 'rgba(20, 32, 46, 0.92)', border: '1px solid rgba(255,255,255,0.2)', boxShadow: '0 8px 24px rgba(0,0,0,0.35)', fontSize: 10.5, lineHeight: '15px', pointerEvents: 'none' },
  img: { width: '100%', height: 110, objectFit: 'cover', borderRadius: 8, marginBottom: 6, display: 'block' },
  title: { fontSize: 12, fontWeight: 700, marginBottom: 4, whiteSpace: 'normal' },
  row: { color: 'rgba(255,255,255,0.8)' },
  desc: { marginTop: 5, color: 'rgba(255,255,255,0.65)', display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden' },
};

function Detail({ c, flip }) {
  const todos = c.todos || [];
  const done = todos.filter((t) => t.status === 'done').length;
  const v = c.videoStats;
  return (
    <div className="detail" style={{ ...pop.box, ...(flip ? { right: 'calc(100% + 6px)' } : { left: 'calc(100% + 6px)' }) }}>
      {c.imageUrl && <img src={`${BASE}${c.imageUrl}`} style={pop.img} />}
      <div style={pop.title}>{c.title}</div>
      <div style={pop.row}>{COLUMN_LABEL[c.column] || c.column}</div>
      {c.shootDate && <div style={pop.row}>🎬 ถ่าย {thaiDate(c.shootDate)}{c.shootNote ? ` · ${c.shootNote}` : ''}</div>}
      {c.plannedPublishDate && <div style={pop.row}>📅 แผนลง {thaiDate(c.plannedPublishDate)}</div>}
      {c.column === 'published' && <div style={pop.row}>✅ ลงเมื่อ {thaiDate(c.publishedAt || c.updatedAt)}</div>}
      {(c.platforms || []).length > 0 && <div style={pop.row}>📱 {c.platforms.map((p) => PLATFORM_LABEL[p] || p).join(' · ')}</div>}
      {todos.length > 0 && <div style={pop.row}>☑️ งานย่อย {done}/{todos.length}</div>}
      {v && <div style={pop.row}>👁 {v.views.toLocaleString()} · ❤️ {v.likes} · 💬 {v.comments} · ↗ {v.shares}</div>}
      {(c.description || c.caption) && <div style={pop.desc}>{c.description || c.caption}</div>}
    </div>
  );
}

const CHIP = {
  shoot: { background: 'rgba(255, 200, 120, 0.28)', color: '#fff' },
  plan: { background: 'rgba(143, 227, 255, 0.25)', color: '#fff' },
  pub: { background: 'rgba(0, 116, 162, 0.75)', color: '#fff' },
};

export const render = ({ output, error, offset = 0 }, dispatch) => {
  if (error || !output) return <div style={s.legend}>เปิดแดชบอร์ดไม่ได้ (localhost:5050)</div>;
  let data;
  try { data = parse(output); } catch (e) { return <div style={s.legend}>อ่านข้อมูลการ์ดไม่ได้</div>; }
  const { cards, holidays, workSat } = data;

  const today = new Date();
  const shown = new Date(today.getFullYear(), today.getMonth() + offset, 1);
  const y = shown.getFullYear();
  const mo = shown.getMonth();
  const isThisMonth = offset === 0;
  const start = new Date(y, mo, 1);
  const end = new Date(y, mo + 1, 1);
  const byDay = {};
  const add = (ts, kind, c) => {
    if (!ts) return;
    const d = new Date(ts);
    if (d < start || d >= end) return;
    (byDay[d.getDate()] = byDay[d.getDate()] || []).push({ kind, c });
  };
  cards.forEach((c) => {
    if (c.status === 'rejected') return;
    add(c.shootDate, 'shoot', c);
    add(c.plannedPublishDate, 'plan', c);
    if (c.column === 'published') add(c.publishedAt || c.updatedAt, 'pub', c);
  });

  const cells = [];
  for (let i = 0; i < start.getDay(); i++) cells.push(<div key={`b${i}`} />);
  const days = new Date(y, mo + 1, 0).getDate();
  for (let d = 1; d <= days; d++) {
    const key = `${y}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const wd = new Date(y, mo, d).getDay();
    const isWorkSat = wd === 6 && workSat.has(key);
    const off = holidays[key] || ((wd === 0 || wd === 6) && !isWorkSat);
    const isToday = isThisMonth && d === today.getDate();
    const style = { ...s.cell };
    if (off) style.background = 'rgba(255, 120, 120, 0.10)';
    if (new Date(y, mo, d + 1) <= new Date(today.getFullYear(), today.getMonth(), today.getDate())) style.opacity = 0.55;
    const items = (byDay[d] || []).sort((a, b) => ['shoot', 'plan', 'pub'].indexOf(a.kind) - ['shoot', 'plan', 'pub'].indexOf(b.kind));
    cells.push(
      <div key={d} className={hoverCell} style={style}>
        <div style={{ ...s.num, ...(isToday ? { background: 'rgba(255,255,255,0.85)', color: '#001222' } : { color: off ? '#ff9d9d' : '#fff' }) }}>{d}</div>
        {holidays[key] && <div style={s.hol}>{holidays[key]}</div>}
        {isWorkSat && <div style={{ ...s.hol, color: '#8FE3FF' }}>เสาร์ทำงาน</div>}
        {items.map(({ kind, c }) => (
          <span key={kind + c.id} className={hoverChip} onClick={() => openUrl(`${BASE}/index.html?card=${c.id}`)}>
            <span style={{ ...s.chip, ...CHIP[kind] }}>{kind === 'shoot' ? '🎬 ' : kind === 'plan' ? '📅 ' : ''}{c.title}</span>
            <Detail c={c} flip={wd >= 4} />
          </span>
        ))}
      </div>,
    );
  }

  return (
    <div>
      <div style={s.head}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={s.nav} onClick={() => dispatch({ type: 'MONTH', offset: offset - 1 })}>‹</span>
          <span style={s.title} onClick={() => openUrl(`${BASE}/report.html`)}>📆 {THAI_MONTHS[mo]} {y + 543}</span>
          <span style={s.nav} onClick={() => dispatch({ type: 'MONTH', offset: offset + 1 })}>›</span>
          {!isThisMonth && <span style={{ ...s.nav, width: 'auto', padding: '0 7px', fontSize: 10 }} onClick={() => dispatch({ type: 'MONTH', offset: 0 })}>เดือนนี้</span>}
        </span>
        <span style={s.legend}><b style={{ color: '#ff9d9d' }}>■</b> วันหยุด · 🎬 ถ่าย · 📅 แผนลง · <b style={{ color: '#4fb6e0' }}>■</b> ลงแล้ว</span>
      </div>
      <div style={s.grid}>
        {DAY_NAMES.map((n) => <div key={n} style={s.dayName}>{n}</div>)}
        {cells}
      </div>
    </div>
  );
};
