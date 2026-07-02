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

const PLATFORM_LABELS = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  youtube: 'YouTube'
};
const PLATFORM_ICONS = {
  facebook: '/assets/facebook.png',
  instagram: '/assets/instagram.jpeg',
  tiktok: '/assets/tiktok.jpg',
  youtube: '/assets/youtube.png'
};
const PLATFORMS = Object.keys(PLATFORM_LABELS);

function createPlatformIcon(p) {
  const circle = document.createElement('span');
  circle.className = 'platform-icon-circle';
  const icon = document.createElement('img');
  icon.className = 'platform-icon';
  icon.src = PLATFORM_ICONS[p];
  icon.alt = '';
  circle.appendChild(icon);
  return circle;
}

function createPlatformBadge(p) {
  const badge = document.createElement('span');
  badge.className = `tag-badge platform-${p}`;
  badge.appendChild(createPlatformIcon(p));
  badge.appendChild(document.createTextNode(PLATFORM_LABELS[p]));
  return badge;
}
const THAI_MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
const THAI_MONTHS_SHORT = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

let weekOffset = 0;
let monthOffset = 0;
let calOffset = 0;
let allCards = [];

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function getWeekStart(offset) {
  const today = startOfDay(new Date());
  const dayOfWeek = (today.getDay() + 6) % 7; // 0 = Monday
  const monday = new Date(today);
  monday.setDate(today.getDate() - dayOfWeek + offset * 7);
  return monday;
}

function getMonthStart(offset) {
  const today = new Date();
  return new Date(today.getFullYear(), today.getMonth() + offset, 1);
}

function formatThaiShort(date) {
  return `${date.getDate()} ${THAI_MONTHS_SHORT[date.getMonth()]} ${date.getFullYear() + 543}`;
}

function publishedInRange(card, start, end) {
  if (card.column !== 'published' || card.status === 'rejected') return false;
  const ts = card.publishedAt || card.updatedAt;
  if (!ts) return false;
  const d = new Date(ts);
  return d >= start && d < end;
}

function platformCounts(cards) {
  const counts = {};
  PLATFORMS.forEach((p) => { counts[p] = 0; });
  cards.forEach((c) => {
    (c.platforms || []).forEach((p) => {
      if (counts[p] !== undefined) counts[p] += 1;
    });
  });
  return counts;
}

function renderPlatformGrid(container, counts) {
  container.innerHTML = '';
  PLATFORMS.forEach((p) => {
    const card = document.createElement('div');
    card.className = `report-platform-card platform-${p}`;
    const label = document.createElement('p');
    label.className = 'report-platform-label';
    label.appendChild(createPlatformIcon(p));
    label.appendChild(document.createTextNode(PLATFORM_LABELS[p]));
    const count = document.createElement('p');
    count.className = 'report-platform-count';
    count.textContent = counts[p];
    card.appendChild(label);
    card.appendChild(count);
    container.appendChild(card);
  });
}

function renderPublishedList(container, cards) {
  container.innerHTML = '';
  if (!cards.length) {
    container.innerHTML = '<p class="empty-state">ยังไม่มีคอนเทนต์เผยแพร่ในช่วงนี้</p>';
    return;
  }
  cards
    .sort((a, b) => new Date(b.publishedAt || b.updatedAt) - new Date(a.publishedAt || a.updatedAt))
    .forEach((c) => {
      const item = document.createElement('div');
      item.className = 'changelog-entry';
      const title = document.createElement('p');
      title.className = 'changelog-feature';
      title.textContent = c.title;
      item.appendChild(title);
      if ((c.platforms || []).length) {
        const row = document.createElement('div');
        row.className = 'tag-row';
        c.platforms.filter((p) => PLATFORM_LABELS[p]).forEach((p) => row.appendChild(createPlatformIcon(p)));
        item.appendChild(row);
      }
      const date = document.createElement('p');
      date.className = 'changelog-date';
      date.textContent = formatThaiShort(new Date(c.publishedAt || c.updatedAt));
      item.appendChild(date);
      container.appendChild(item);
    });
}

function renderGoal(fillEl, labelEl, done, target) {
  const pct = Math.min(100, Math.round((done / target) * 100));
  fillEl.style.width = `${pct}%`;
  fillEl.classList.toggle('complete', done >= target);
  labelEl.textContent = `${done}/${target}`;
}

const weekRangeLabel = document.getElementById('weekRangeLabel');
const weekGoalFill = document.getElementById('weekGoalFill');
const weekGoalLabel = document.getElementById('weekGoalLabel');
const weekPlatformGrid = document.getElementById('weekPlatformGrid');
const weekPublishedList = document.getElementById('weekPublishedList');

const monthRangeLabel = document.getElementById('monthRangeLabel');
const monthGoalFill = document.getElementById('monthGoalFill');
const monthGoalLabel = document.getElementById('monthGoalLabel');
const monthPlatformGrid = document.getElementById('monthPlatformGrid');
const monthPublishedList = document.getElementById('monthPublishedList');

function renderWeek() {
  const start = getWeekStart(weekOffset);
  const end = new Date(start);
  end.setDate(start.getDate() + 7);
  const sunday = new Date(end);
  sunday.setDate(end.getDate() - 1);

  weekRangeLabel.textContent = `${formatThaiShort(start)} – ${formatThaiShort(sunday)}`;

  const cardsInWeek = allCards.filter((c) => publishedInRange(c, start, end));
  const reelGoalCards = cardsInWeek.filter((c) => (c.platforms || []).some((p) => p === 'facebook' || p === 'tiktok'));

  renderGoal(weekGoalFill, weekGoalLabel, reelGoalCards.length, 3);
  renderPlatformGrid(weekPlatformGrid, platformCounts(cardsInWeek));
  renderPublishedList(weekPublishedList, cardsInWeek);
}

function renderMonth() {
  const start = getMonthStart(monthOffset);
  const end = getMonthStart(monthOffset + 1);

  monthRangeLabel.textContent = `${THAI_MONTHS[start.getMonth()]} ${start.getFullYear() + 543}`;

  const cardsInMonth = allCards.filter((c) => publishedInRange(c, start, end));
  renderGoal(monthGoalFill, monthGoalLabel, cardsInMonth.length, 12);
  renderPlatformGrid(monthPlatformGrid, platformCounts(cardsInMonth));
  renderPublishedList(monthPublishedList, cardsInMonth);
}

const CAL_DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function renderCalendar() {
  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth() + calOffset;
  const display = new Date(year, month, 1);

  const calMonthLabel = document.getElementById('calMonthLabel');
  calMonthLabel.textContent = `${THAI_MONTHS[display.getMonth()]} ${display.getFullYear() + 543}`;

  const start = new Date(display.getFullYear(), display.getMonth(), 1);
  const end = new Date(display.getFullYear(), display.getMonth() + 1, 1);

  const publishedDays = {};
  allCards.forEach((c) => {
    if (c.column !== 'published' || c.status === 'rejected') return;
    const ts = c.publishedAt || c.updatedAt;
    if (!ts) return;
    const d = new Date(ts);
    if (d >= start && d < end) {
      const key = d.getDate();
      if (!publishedDays[key]) publishedDays[key] = [];
      publishedDays[key].push(c);
    }
  });

  const plannedDays = {};
  allCards.forEach((c) => {
    if (!c.plannedPublishDate || c.status === 'rejected') return;
    const d = new Date(c.plannedPublishDate);
    if (d >= start && d < end) {
      const key = d.getDate();
      if (!plannedDays[key]) plannedDays[key] = [];
      plannedDays[key].push(c);
    }
  });

  const wrap = document.getElementById('calendarGrid');
  wrap.innerHTML = '';

  const grid = document.createElement('div');
  grid.className = 'cal-grid';

  CAL_DAY_NAMES.forEach((name) => {
    const hdr = document.createElement('div');
    hdr.className = 'cal-day-header';
    hdr.textContent = name;
    grid.appendChild(hdr);
  });

  // start weekday: 0=Sun … 6=Sat
  const firstWeekday = start.getDay();
  for (let i = 0; i < firstWeekday; i++) {
    const blank = document.createElement('div');
    blank.className = 'cal-cell cal-blank';
    grid.appendChild(blank);
  }

  const daysInMonth = new Date(display.getFullYear(), display.getMonth() + 1, 0).getDate();
  const todayKey = (today.getFullYear() === display.getFullYear() && today.getMonth() === display.getMonth()) ? today.getDate() : -1;

  for (let d = 1; d <= daysInMonth; d++) {
    const cards = publishedDays[d] || [];
    const planned = plannedDays[d] || [];
    const cell = document.createElement('div');
    cell.className = 'cal-cell';
    if (d === todayKey) cell.classList.add('cal-today');
    if (cards.length || planned.length) cell.classList.add('cal-has-content');

    const num = document.createElement('span');
    num.className = 'cal-day-num';
    num.textContent = d;
    cell.appendChild(num);

    if (cards.length) {
      const dot = document.createElement('span');
      dot.className = 'cal-count-dot';
      dot.textContent = cards.length;
      cell.appendChild(dot);
      cell.addEventListener('click', () => openDayPopover(d, cards, display));
    }

    cards.forEach((c) => {
      const chip = document.createElement('a');
      chip.className = 'cal-card-title';
      chip.textContent = c.title;
      chip.title = c.title;
      chip.href = `/index.html?card=${c.id}`;
      cell.appendChild(chip);
    });

    planned.forEach((c) => {
      const chip = document.createElement('a');
      chip.className = 'cal-card-planned';
      chip.textContent = `📅 ${c.title}`;
      chip.title = `Plan to Publish: ${c.title}`;
      chip.href = `/index.html?card=${c.id}`;
      cell.appendChild(chip);
    });

    grid.appendChild(cell);
  }

  wrap.appendChild(grid);
}

const calDayPopover = document.getElementById('calDayPopover');
const calDayPopoverTitle = document.getElementById('calDayPopoverTitle');
const calDayPopoverList = document.getElementById('calDayPopoverList');
document.getElementById('calDayPopoverClose').addEventListener('click', () => { calDayPopover.hidden = true; });

function openDayPopover(day, cards, monthDate) {
  calDayPopoverTitle.textContent = `${day} ${THAI_MONTHS[monthDate.getMonth()]} ${monthDate.getFullYear() + 543}`;
  calDayPopoverList.innerHTML = '';
  cards.forEach((c) => {
    const a = document.createElement('a');
    a.className = 'cal-day-popover-item';
    a.href = `/index.html?card=${c.id}`;
    a.textContent = c.title;
    calDayPopoverList.appendChild(a);
  });
  calDayPopover.hidden = false;
  calDayPopover.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

document.getElementById('calPrevBtn').addEventListener('click', () => { calOffset -= 1; calDayPopover.hidden = true; renderCalendar(); });
document.getElementById('calNextBtn').addEventListener('click', () => { calOffset += 1; calDayPopover.hidden = true; renderCalendar(); });

document.getElementById('weekPrevBtn').addEventListener('click', () => { weekOffset -= 1; renderWeek(); });
document.getElementById('weekNextBtn').addEventListener('click', () => { weekOffset += 1; renderWeek(); });
document.getElementById('monthPrevBtn').addEventListener('click', () => { monthOffset -= 1; renderMonth(); });
document.getElementById('monthNextBtn').addEventListener('click', () => { monthOffset += 1; renderMonth(); });

async function load() {
  const res = await fetch('/api/cards');
  const data = await res.json();
  allCards = data.cards;
  renderCalendar();
  renderWeek();
  renderMonth();
}

load();
