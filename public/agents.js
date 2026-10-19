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

// ─── AI team ────────────────────────────────────────────────────────────
const POLL_MS = 4000;
const STEPS = [
  { key: 'queued', label: 'สั่งแล้ว' },
  { key: 'running', label: 'กำลังทำ' },
  { key: 'review', label: 'รอตรวจ' },
  { key: 'done', label: 'เสร็จ' },
];
const STATUS_LABELS = { queued: 'รอคิว', running: 'กำลังทำ', review: 'รอตรวจ', done: 'เสร็จแล้ว', rejected: 'ทิ้งแล้ว', failed: 'ไม่สำเร็จ' };
const DAY_NAMES = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];
const MODEL_LABELS = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' };
function modelLabel(a) {
  const engine = ENGINE_LABELS[a.engine] || a.engine;
  return a.model ? `${engine} ${MODEL_LABELS[a.model] || a.model}` : engine;
}
const ENGINE_LABELS = { claude: 'Claude', codex: 'Codex', vectorcraft: 'VectorCraft', effectcraft: 'EffectCraft' };

let state = null;
let selectedAgent = null;
let cardsLoaded = false;
// Review cards hold the user's in-progress edits/checkboxes, so they're only
// rebuilt when the set of tasks under review actually changes.
let reviewKey = '';

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value' || (k in el && typeof v !== 'string')) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return el;
}

function agentById(id) {
  if (state?.team && id === state.team.id) return state.team;
  return state?.agents.find((a) => a.id === id) || { id, name: id, role: '', avatar: '' };
}

function timeText(d) {
  return d ? new Date(d).toLocaleString('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
}

function bangkokToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
}

async function api(url, body) {
  const res = await fetch(url, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

// ─── Status + roster ────────────────────────────────────────────────────
function renderStatus() {
  const box = document.getElementById('teamStatus');
  const { hours, usage, working, runner } = state;
  const days = `${DAY_NAMES[hours.days[0]]}–${DAY_NAMES[hours.days[hours.days.length - 1]]}`;
  const hoursText = `${days} ${String(hours.start).padStart(2, '0')}:00–${hours.end}:00`;
  box.replaceChildren(
    runner
      ? h('span', { class: `team-pill ${working ? 'team-pill-on' : 'team-pill-off'}` }, working ? '● ทีมกำลังเข้างาน' : '○ นอกเวลางาน งานใหม่จะรอคิวถึงเช้าวันทำงาน')
      : h('span', { class: 'team-pill team-pill-off' }, 'ดูได้อย่างเดียว ทีม AI สั่งงานได้เฉพาะบนเครื่อง Mac ของฝ่ายการตลาด'),
    h('span', { class: 'team-muted' }, `เวลางาน ${hoursText}`),
    runner ? h('span', { class: 'team-muted' }, usage.limit ? `วันนี้ใช้ไป ${usage.today}/${usage.limit} งาน` : `วันนี้ทำไป ${usage.today} งาน`) : null,
  );
  document.getElementById('teamCommandSection').hidden = !runner;
}

function renderRoster() {
  const roster = document.getElementById('teamRoster');
  roster.replaceChildren(...state.agents.map((a) => {
    // ผัง/พิมพ์/ประกอบ share one image task; each is busy during its own stage.
    const mine = a.pipelineStage ? state.tasks.filter((t) => t.agent === 'image' || (a.vectorEditor && t.agent === a.id)) : state.tasks.filter((t) => t.agent === a.id);
    const running = mine.find((t) => t.status === 'running' && (t.agent === a.id || !a.pipelineStage || (t.result?.stage || 'plan') === a.pipelineStage));
    const queued = mine.filter((t) => t.status === 'queued').length;
    // Work waiting for her is counted once, on the agent it's filed under.
    const reviewIds = mine.filter((t) => t.status === 'review' && t.agent === a.id).map((t) => t.id);
    const reviewing = reviewIds.length;
    const doneToday = mine.filter((t) => t.status === 'done' && t.decidedAt && new Date(t.decidedAt).toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' }) === bangkokToday()).length;
    let status = 'ว่าง';
    let cls = 'idle';
    if (running) { status = 'กำลังทำงาน…'; cls = 'busy'; }
    else if (a.pipelineStage && a.id !== 'image' && !a.vectorEditor) { status = 'ทำงานต่อจากงานภาพ'; }
    else if (queued) { status = `รอคิว ${queued} งาน`; cls = 'queued'; }
    else if (reviewing) { status = `รอคุณตรวจ ${reviewing} งาน`; cls = 'review'; }
    const said = state.bubbles?.[a.id] || {};
    const short = (t) => (t.length > 90 ? `${t.slice(0, 90)}…` : t);
    const rows = [
      said.think ? h('div', { class: 'team-cloud-row think', title: said.think.text }, h('b', {}, '🧠 คิด: '), short(said.think.text)) : null,
      said.doing ? h('div', { class: 'team-cloud-row doing', title: said.doing.text }, h('b', {}, '🛠️ ทำ: '), short(said.doing.text)) : null,
      said.handoff ? h('div', { class: 'team-cloud-row handoff', title: said.handoff.text }, h('b', {}, `📤 สั่ง${speaker(said.handoff.toAgent || 'you').name}: `), short(said.handoff.text)) : null,
    ].filter(Boolean);
    const cloud = rows.length ? h('div', { class: `team-cloud${said.doing ? ' live' : ''}` }, ...rows) : null;
    // Click the card to jump to this agent's work waiting in รออนุมัติ.
    const viewable = reviewing > 0;
    return h('div', { class: 'team-member-wrap' }, cloud, h('div', {
      class: `team-member team-member-${cls}${a.id === selectedAgent ? ' selected' : ''}${viewable ? ' team-member-link' : ''}`,
      ...(viewable ? {
        role: 'button', tabindex: '0', title: 'คลิกเพื่อดูงานที่รอคุณตรวจ',
        onclick: () => showReviewFor(reviewIds),
        onkeydown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); showReviewFor(reviewIds); } },
      } : {}),
    },
    h('button', {
      type: 'button',
      class: 'team-member-gear',
      onclick: (ev) => { ev.stopPropagation(); openSettings(a.id); },
      onkeydown: (ev) => ev.stopPropagation(),
      title: `ตั้งค่า${a.name}`,
      'aria-label': `ตั้งค่า${a.name}`,
    }, '⚙️'),
    h('img', { src: a.avatar, alt: '', class: 'team-avatar' }),
    h('div', { class: 'team-member-body' },
      h('div', { class: 'team-member-name' }, a.name, h('span', { class: `team-engine team-engine-${a.engine}${a.model ? ` team-model-${a.model}` : ''}`, title: 'โมเดล AI ที่ใช้' }, modelLabel(a))),
      h('div', { class: 'team-muted' }, a.role),
      h('div', { class: 'team-member-status' }, viewable ? `${status} ›` : status),
      doneToday ? h('div', { class: 'team-muted' }, `วันนี้เสร็จ ${doneToday} งาน`) : null,
    )));
  }));
}

// ─── Command form ───────────────────────────────────────────────────────
async function loadCards() {
  if (cardsLoaded) return;
  cardsLoaded = true;
  try {
    const { cards } = await api('/api/cards');
    const select = document.getElementById('teamCardSelect');
    const groups = { idea: 'ไอเดีย', clip: 'คลิป', youtube: 'YouTube', published: 'เผยแพร่แล้ว' };
    select.replaceChildren(...Object.entries(groups).map(([col, label]) => h('optgroup', { label },
      ...cards.filter((c) => c.column === col).map((c) => h('option', { value: c.id }, c.title)))));
  } catch { cardsLoaded = false; }
}

// ─── Chat with @mentions ───────────────────────────────────────────────
// "@ปิ๊ง …" to an agent that takes jobs creates a task; "@ผัง …" (and the
// other image-line agents) becomes a standing rule in that agent's settings.
const promptEl = document.getElementById('teamPrompt');
const menuEl = document.getElementById('teamMentionMenu');
let menuIndex = 0;
let chatMode = 'do';

function mentionables() {
  return state ? [...(state.team ? [state.team] : []), ...state.agents] : [];
}

function mentionTarget(text) {
  const m = /@(\S+)/.exec(text);
  if (!m) return null;
  const all = mentionables();
  return all.find((a) => a.name === m[1] || (a.id === 'all' && /^all$/i.test(m[1]))) || all.find((a) => m[1].startsWith(a.name)) || null;
}

// A chat message to an agent with work waiting for review continues that
// job (same as ↻ ให้แก้) unless she chooses to start a new one.
let followUpOff = false;
function followUpTask(id) {
  if (!id || id === 'image' || followUpOff) return null;
  return state.tasks.find((t) => t.agent === id && t.status === 'review' && t.result?.stage !== 'teaching') || null;
}

function renderFollowUp() {
  const box = document.getElementById('teamFollowUp');
  const a = agentById(selectedAgent);
  const doNow = a && (a.commandable ? chatMode === 'do' : a.orderable);
  const candidate = doNow && state.tasks.find((t) => t.agent === selectedAgent && t.status === 'review' && t.result?.stage !== 'teaching');
  box.hidden = !candidate;
  if (!candidate) return;
  const short = (t) => (t.length > 60 ? `${t.slice(0, 60)}…` : t);
  box.replaceChildren(followUpOff
    ? h('span', {}, '✨ งานใหม่ · ', h('button', { type: 'button', class: 'team-link', onclick: () => { followUpOff = false; renderFollowUp(); } }, `แก้ต่อจาก “${short(candidate.prompt || '')}” แทน`))
    : h('span', {}, '↪ แก้ต่อจากงานที่รอตรวจ: ', h('b', {}, `“${short(candidate.prompt || '')}”`), ' · ',
      h('button', { type: 'button', class: 'team-link', onclick: () => { followUpOff = true; renderFollowUp(); } }, 'เริ่มงานใหม่แทน')));
}

function selectAgent(id) {
  if (id !== selectedAgent) followUpOff = false;
  selectedAgent = id;
  const a = agentById(id);
  const to = document.getElementById('teamChatTo');
  if (!id) {
    to.replaceChildren('พิมพ์ ', h('b', {}, '@'), ' เพื่อเรียก Agent');
  } else {
    // ผัง / ประกอบ / มูฟ can either do it now (on the latest picture) or
    // keep it as a standing rule — she picks; "do it now" is the default.
    const dual = a.commandable;
    if (!dual) chatMode = a.orderable ? 'do' : 'rule';
    const modeBtn = (mode, label) => h('button', {
      type: 'button',
      class: `team-mode${chatMode === mode ? ' selected' : ''}`,
      'aria-pressed': String(chatMode === mode),
      onclick: () => { chatMode = mode; selectAgent(id); promptEl.focus(); },
    }, label);
    to.replaceChildren(h('img', { src: a.avatar, alt: '' }), ' ส่งถึง ', h('b', {}, a.name), ` · ${a.role}`,
      dual
        ? h('span', { class: 'team-modes' }, modeBtn('do', '▶ ทำตอนนี้'), modeBtn('rule', '📌 จำเป็นกฎ'))
        : h('span', {}, ` · ${a.orderable ? 'สั่งงานใหม่' : 'บอกให้จำเป็นกฎ'}`));
  }
  document.getElementById('teamCardRow').hidden = !a?.needsCard;
  document.getElementById('teamChatVectorRow').hidden = !a?.vectorEditor;
  document.getElementById('teamDateRow').hidden = id !== 'website';
  document.getElementById('teamDaysRow').hidden = id !== 'ads';
  document.getElementById('teamProductRow').hidden = id !== 'image';
  if (id === 'image') fillProducts();
  if (id === 'website' && !document.getElementById('teamDateInput').value) document.getElementById('teamDateInput').value = bangkokToday();
  if (a?.needsCard) loadCards();
  renderFollowUp();
}

// The "@partial" right before the caret, if the caret is inside a mention.
function partialMention() {
  const before = promptEl.value.slice(0, promptEl.selectionStart);
  const m = /(^|\s)@(\S*)$/.exec(before);
  return m ? { start: before.length - m[2].length - 1, query: m[2] } : null;
}

function renderMentionMenu() {
  const pm = partialMention();
  const options = pm && state ? mentionables().filter((a) => a.name.startsWith(pm.query) || a.role.includes(pm.query) || (a.id === 'all' && 'all'.startsWith(pm.query.toLowerCase()))) : [];
  if (!options.length) { menuEl.hidden = true; return; }
  menuIndex = Math.min(menuIndex, options.length - 1);
  menuEl.replaceChildren(...options.map((a, i) => h('li', {
    role: 'option',
    'aria-selected': String(i === menuIndex),
    class: i === menuIndex ? 'active' : '',
    onmousedown: (e) => { e.preventDefault(); pickMention(a); },
  }, h('img', { src: a.avatar, alt: '' }), h('b', {}, a.name), h('span', { class: 'team-muted' }, ` ${a.role}${a.commandable ? ' · สั่งทำ/ใส่กฎ' : a.orderable ? '' : ' · ใส่เป็นกฎ'}`))));
  menuEl.dataset.ids = options.map((a) => a.id).join(',');
  menuEl.hidden = false;
}

function pickMention(a) {
  const pm = partialMention();
  if (!pm) return;
  const after = promptEl.value.slice(promptEl.selectionStart);
  promptEl.value = `${promptEl.value.slice(0, pm.start)}@${a.name} ${after.replace(/^\S*/, '').trimStart()}`;
  const caret = pm.start + a.name.length + 2;
  promptEl.setSelectionRange(caret, caret);
  menuEl.hidden = true;
  selectAgent(a.id);
  promptEl.focus();
}

promptEl.addEventListener('input', () => {
  menuIndex = 0;
  renderMentionMenu();
  const target = mentionTarget(promptEl.value);
  if ((target?.id || null) !== selectedAgent) { chatMode = 'do'; selectAgent(target?.id || null); }
});
promptEl.addEventListener('keydown', (e) => {
  if (!menuEl.hidden) {
    const ids = (menuEl.dataset.ids || '').split(',');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      menuIndex = (menuIndex + (e.key === 'ArrowDown' ? 1 : ids.length - 1)) % ids.length;
      renderMentionMenu();
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickMention(agentById(ids[menuIndex])); return; }
    if (e.key === 'Escape') { menuEl.hidden = true; return; }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    document.getElementById('teamCommandForm').requestSubmit();
  }
});
promptEl.addEventListener('blur', () => setTimeout(() => { menuEl.hidden = true; }, 120));

// ─── Chat attachments ───────────────────────────────────────────────────
// Pictures go along with the command; big ones are shrunk to 2000px first.
const MAX_ATTACH = 4;
let attachments = [];
const attachList = document.getElementById('teamAttachList');

function shrinkImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 2000 / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      // PNG keeps transparency (cut-outs); everything else goes as JPEG.
      resolve(file.type === 'image/png' ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.9));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`เปิดภาพ ${file.name} ไม่ได้`)); };
    img.src = url;
  });
}

async function addAttachments(files) {
  const msg = document.getElementById('teamCommandMsg');
  const images = [...files].filter((f) => /^image\/(png|jpeg|webp)$/.test(f.type));
  if (!images.length) { if (files.length) msg.textContent = 'แนบได้เฉพาะภาพ PNG, JPG หรือ WebP'; return; }
  for (const file of images) {
    if (attachments.length >= MAX_ATTACH) { msg.textContent = `แนบภาพได้สูงสุด ${MAX_ATTACH} ภาพ`; break; }
    try { attachments.push({ name: file.name, data: await shrinkImage(file) }); } catch (err) { msg.textContent = err.message; }
  }
  renderAttachments();
}

function renderAttachments() {
  attachList.hidden = !attachments.length;
  attachList.replaceChildren(...attachments.map((a, i) => h('figure', { class: 'team-attach' },
    h('img', { src: a.data, alt: a.name }),
    h('button', { type: 'button', title: 'เอาออก', 'aria-label': `เอา ${a.name} ออก`, onclick: () => { attachments.splice(i, 1); renderAttachments(); } }, '✕'))));
}

const attachInput = document.getElementById('teamAttachInput');
document.getElementById('teamAttachBtn').addEventListener('click', () => attachInput.click());
attachInput.addEventListener('change', () => { addAttachments(attachInput.files); attachInput.value = ''; });
promptEl.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.some((f) => f.type.startsWith('image/'))) { e.preventDefault(); addAttachments(files); }
});
const chatForm = document.getElementById('teamCommandForm');
chatForm.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); chatForm.classList.add('dropping'); } });
chatForm.addEventListener('dragleave', (e) => { if (!chatForm.contains(e.relatedTarget)) chatForm.classList.remove('dropping'); });
chatForm.addEventListener('drop', (e) => { e.preventDefault(); chatForm.classList.remove('dropping'); addAttachments(e.dataTransfer.files); });

document.getElementById('teamCommandForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('teamCommandMsg');
  const target = mentionTarget(promptEl.value);
  if (!target) { msg.textContent = 'พิมพ์ @ แล้วเลือก Agent ก่อน'; promptEl.focus(); return; }
  const text = promptEl.value.replace(new RegExp(`@${target.name}\\S*`), '').trim();
  const input = {};
  if (target.vectorEditor) {
    input.sourceTaskId = document.getElementById('teamChatVectorSource').value;
    input.live = document.getElementById('teamChatVectorLive').checked;
  }
  if (target.needsCard) input.cardId = document.getElementById('teamCardSelect').value;
  if (target.id === 'website') input.date = document.getElementById('teamDateInput').value;
  if (target.id === 'ads') input.days = Number(document.getElementById('teamDaysInput').value) || 7;
  if (target.id === 'image' && document.getElementById('teamProductSelect').value) {
    input.productModel = document.getElementById('teamProductSelect').value;
    input.headline = document.getElementById('teamHeadlineInput').value.trim();
    input.subhead = document.getElementById('teamSubheadInput').value.trim();
  }
  try {
    const doNow = target.commandable ? chatMode === 'do' : target.orderable;
    const follow = doNow ? followUpTask(target.id) : null;
    if (follow) {
      if (!text) { msg.textContent = `พิมพ์ด้วยว่าจะให้${target.name}แก้อะไรต่อ`; return; }
      await api(`/api/agents/tasks/${follow.id}/revise`, { feedback: text, attachments });
      msg.textContent = `ส่งให้${target.name}แก้ต่อจากงานเดิมแล้ว${state.working ? '' : ' จะเริ่มทำในเวลางาน'}`;
    } else if (doNow && target.id === 'layout') {
      if (!text) { msg.textContent = 'พิมพ์ด้วยว่าจะให้ผังทำอะไรกับภาพล่าสุด'; return; }
      await api('/api/agents/layout/command', { text, attachments });
      msg.textContent = `ส่งให้ผังแก้ภาพล่าสุดแล้ว${state.working ? '' : ' จะเริ่มทำในเวลางาน'}`;
    } else if (doNow) {
      await api('/api/agents/tasks', { agent: target.id, prompt: text, input, attachments });
      msg.textContent = `ส่งงานให้${target.name}แล้ว${target.commandable ? ' (ใช้ภาพล่าสุด)' : ''}${state.working ? '' : ' จะเริ่มทำในเวลางาน'}`;
    } else {
      if (!text) { msg.textContent = `พิมพ์ด้วยว่าจะบอก${target.name}ว่าอะไร`; return; }
      if (attachments.length) { msg.textContent = 'ภาพแนบใช้ได้เฉพาะตอนสั่งงาน — เปลี่ยนเป็นโหมดสั่งทำ หรือเอาภาพออกก่อน'; return; }
      await api(`/api/agents/${target.id}/settings/note`, { text });
      msg.textContent = target.id === 'all'
        ? 'บันทึกเป็นกฎของทั้งทีมแล้ว ทุกตัวจะทำตามตั้งแต่งานถัดไป'
        : `${target.name}จำเป็นกฎแล้ว (ดูได้ในหน้าตั้งค่าของ${target.name})`;
    }
    promptEl.value = '';
    attachments = [];
    renderAttachments();
    selectAgent(null);
    refresh();
    refreshLog();
  } catch (err) {
    msg.textContent = err.message;
  }
});

// ─── Result views ───────────────────────────────────────────────────────
const SKIP_REASONS = ['ขายของไม่ชัด', 'ไม่ตรงกลุ่มลูกค้า', 'ซ้ำกับที่เคยทำ', 'ข้อความยาว/แข็งไป', 'ภาพไม่ดึงดูด', 'ไม่ตรงแบรนด์', 'ทำจริงยาก'];

// One proposed idea. In review she marks each ✓/✕; a ✕ asks why, and that
// reason is what the agent learns from next round.
function ideaCard(task, idea, i, editable) {
  const decision = task.result?.decisions?.[i];
  const details = task.agent === 'adideas'
    ? [
      h('div', { class: 'team-tags' }, h('span', { class: 'team-tag-plain' }, idea.campaign), h('span', { class: 'team-tag-plain' }, idea.productModel)),
      h('p', {}, h('b', {}, 'พาดหัว: '), idea.headline),
      idea.subhead ? h('p', {}, h('b', {}, 'บรรทัดรอง: '), idea.subhead) : null,
      h('p', { class: 'team-pre' }, h('b', {}, 'ข้อความโฆษณา: '), idea.primaryText),
      h('p', {}, h('b', {}, 'ภาพ: '), idea.visual),
      h('p', { class: 'team-muted' }, idea.why),
    ]
    : [
      h('div', { class: 'team-tags' }, h('span', { class: 'team-tag-plain' }, idea.productModel)),
      h('ol', {}, ...(idea.scenes || []).map((sc) => h('li', {}, sc))),
      h('p', { class: 'team-muted' }, idea.why),
    ];
  if (!editable) {
    return h('div', { class: `team-idea${decision ? (decision.picked ? ' picked' : ' skipped') : ''}` },
      h('strong', {}, `${decision ? (decision.picked ? '✓ ' : '✕ ') : ''}${idea.title}`),
      ...details,
      decision && !decision.picked && decision.reason ? h('p', { class: 'team-reason' }, `เหตุผลที่ไม่เลือก: ${decision.reason}`) : null);
  }
  const reason = h('input', { type: 'text', class: 'team-edit', placeholder: 'ทำไมไม่เลือก (ช่วยให้ทีมเรียนรู้)', 'data-reason': '' });
  const reasonBox = h('div', { class: 'team-reason-box', hidden: true },
    h('div', { class: 'team-tags' }, ...SKIP_REASONS.map((r) => h('button', {
      type: 'button',
      class: 'team-reason-chip',
      onclick: () => { reason.value = reason.value ? `${reason.value}, ${r}` : r; },
    }, r))),
    reason);
  const el = h('div', { class: 'team-idea' });
  const choose = (choice) => {
    el.dataset.choice = choice;
    el.classList.toggle('picked', choice === 'pick');
    el.classList.toggle('skipped', choice === 'skip');
    reasonBox.hidden = choice !== 'skip';
    if (choice === 'skip') reason.focus();
  };
  el.append(
    h('div', { class: 'team-idea-head' },
      h('strong', {}, idea.title),
      h('div', { class: 'team-choice' },
        h('button', { type: 'button', class: 'team-btn team-pick', onclick: () => choose('pick') }, '✓ เลือก'),
        h('button', { type: 'button', class: 'team-btn team-skip', onclick: () => choose('skip') }, '✕ ไม่เลือก'))),
    ...details,
    reasonBox);
  return el;
}

function renderLearnings() {
  const box = document.getElementById('teamLearnings');
  const items = state.learnings || [];
  if (!items.length) {
    box.replaceChildren(h('p', { class: 'team-muted' }, 'ยังไม่มี เมื่อคุณเลือก/ไม่เลือกไอเดีย หรือทิ้งงานพร้อมเหตุผล จะมาอยู่ตรงนี้ และทีมจะใช้ตอนทำงานรอบถัดไป'));
    return;
  }
  box.replaceChildren(h('ul', { class: 'team-learn-list' }, ...items.map((l) => h('li', { class: l.picked ? 'picked' : 'skipped' },
    h('span', {}, l.picked ? '✓ ' : '✕ '),
    h('span', { class: 'team-tag-plain' }, agentById(l.agent).name),
    ' ',
    h('b', {}, l.title.length > 90 ? `${l.title.slice(0, 90)}…` : l.title),
    l.reason ? h('span', { class: 'team-muted' }, ` — ${l.reason}`) : null))));
}

// editable=true renders the inputs the approve step reads back.
function resultView(task, editable) {
  const r = task.result || {};
  switch (task.agent) {
    case 'assemble':
      return vectorResultView(task, editable);
    case 'adideas':
    case 'productvideo':
      return h('div', { class: 'team-result' },
        r.summary ? h('p', {}, r.summary) : null,
        ...(r.ideas || []).map((idea, i) => ideaCard(task, idea, i, editable)));
    case 'caption':
      return h('div', { class: 'team-result' },
        task.cardTitle ? h('p', { class: 'team-muted' }, `การ์ด: ${task.cardTitle}`) : null,
        editable ? h('textarea', { class: 'team-edit', rows: 8, 'data-caption': '', value: r.caption || '' }) : h('p', { class: 'team-pre' }, r.caption || ''),
        r.note ? h('p', { class: 'team-muted' }, r.note) : null);
    case 'ads':
      return h('div', { class: 'team-result' },
        h('p', {}, r.summary || ''),
        r.highlights?.length ? h('div', {}, h('strong', {}, 'ที่น่าสนใจ'), h('ul', {}, ...r.highlights.map((x) => h('li', {}, x)))) : null,
        r.suggestions?.length ? h('div', {}, h('strong', {}, 'ข้อเสนอ'), h('ul', {}, ...r.suggestions.map((x) => h('li', {}, x)))) : null);
    case 'website':
      return h('div', { class: 'team-result' }, ...(r.entries || []).map((en, i) => h('div', { class: 'team-entry' },
        h('div', { class: 'team-muted' }, timeText(en.date)),
        editable
          ? h('label', { class: 'team-entry-edit' },
            h('input', { type: 'checkbox', checked: true, 'data-entry-keep': String(i) }),
            h('textarea', { class: 'team-edit', rows: 3, 'data-entry': String(i), value: en.text }))
          : h('p', {}, en.text))));
    case 'image': {
      // Picture on the left, ผัง's verdict and the tools on the right, so the
      // card uses its full width instead of one narrow column.
      const first = r.images?.[0];
      const tools = state.runner ? [
        first ? h('button', { type: 'button', class: 'team-btn team-btn-small', onclick: (e) => openInApp(r.document || first, e.currentTarget, 'vectorcraft') }, r.document ? 'เปิดไฟล์แยกเลเยอร์ใน VectorCraft' : 'เปิดใน VectorCraft') : null,
        r.layerFiles?.length ? h('button', { type: 'button', class: 'team-btn team-btn-small', onclick: (e) => makeMotion(task, e.currentTarget) }, '🎬 ทำเป็นแอนิเมชัน (EffectCraft)') : null,
        r.layerFiles?.length ? h('button', { type: 'button', class: 'team-btn team-btn-small', onclick: (e) => reassemble(task, e.currentTarget) }, '🧩 ให้ประกอบจัดใหม่ (ฟอนต์/สีล่าสุด)') : null,
        r.document ? h('button', { type: 'button', class: 'team-btn team-btn-small', onclick: () => chooseVectorSource(task.id) }, '✏️ ให้ประกอบแก้ภาพนี้') : null,
        r.document ? h('button', { type: 'button', class: 'team-btn team-btn-small', onclick: (e) => submitVectorTeaching(task.id, e.currentTarget) }, '🎓 ฉันแก้ให้ดูเป็นตัวอย่าง') : null,
      ].filter(Boolean) : [];
      return h('div', { class: 'team-result team-image-layout' },
        h('div', { class: `team-images${(r.images || []).length > 1 ? ' multi' : ''}` }, ...(r.images || []).map((src, i) => h('figure', { class: 'team-image' },
          h('a', { href: src, target: '_blank', rel: 'noopener' }, h('img', { src, alt: 'ภาพที่สร้าง' })),
          editable && r.images.length > 1 ? h('label', {}, h('input', { type: 'radio', name: `img-${task.id}`, value: String(i), checked: i === 0, 'data-image': String(i) }), ' ใช้ภาพนี้') : null))),
        h('div', { class: 'team-image-side' },
          task.input?.productModel ? h('p', { class: 'team-muted' }, `สินค้า: ${task.input.productModel}${task.input.headline ? ` · พาดหัว: ${task.input.headline}` : ''}`) : null,
          verdictCard(r),
          tools.length ? h('div', { class: 'team-image-tools' }, ...tools) : null));
    }
    case 'motion':
      return h('div', { class: 'team-result' },
        r.video ? h('video', { src: r.video, controls: true, muted: true, loop: true, playsinline: true, class: 'team-video' }) : null,
        r.note ? h('p', { class: 'team-muted' }, r.note) : null,
        state.runner ? h('div', { class: 'team-tags' },
          r.project ? h('button', { type: 'button', class: 'team-btn team-btn-small', onclick: (e) => openInApp(r.project, e.currentTarget, 'effectcraft') }, 'เปิดใน EffectCraft') : null,
          r.video ? h('button', { type: 'button', class: 'team-btn team-btn-small', onclick: (e) => openInApp(r.video, e.currentTarget, 'filmcraft') }, 'เปิดใน FilmCraft (ใส่เพลง/ตัดต่อ)') : null,
          r.video ? h('a', { href: r.video, download: '', class: 'team-btn team-btn-small' }, 'ดาวน์โหลด') : null) : null,
        r.video ? h('button', { type: 'button', class: 'team-btn team-btn-small', onclick: (e) => fullscreenVideo(e.currentTarget) }, '⛶ ดูเต็มจอ') : null);
    default:
      return h('div', { class: 'team-result' }, h('p', { class: 'team-pre' }, r.answer || ''));
  }
}

// ผัง's self-check, sized for a phone screen: score, ≤3 short problems, ≤2
// questions for her. Full wording, past rounds and layers stay folded away.
const PASSED_RE = /ผ่านเกณฑ์|ถูกต้อง\s*$|ดีแล้ว|ต่อเนื่องดี/;
function clip(text, max = 42) {
  const t = String(text || '').trim();
  if (t.length <= max) return t;
  let out = '';
  for (const word of t.split(/\s+/)) {
    if ((out ? `${out} ${word}` : word).length > max) break;
    out = out ? `${out} ${word}` : word;
    if (out.length >= 22) break;
  }
  return `${(out || t).slice(0, max)}…`;
}

// Questions about things her rules already answer (font, colours) aren't
// hers to decide; older reports still have them, so they're hidden here.
const RULED_RE = /ฟอนต์|Frutiger|สี|#[0-9a-f]{6}|โลโก้/i;

function verdictCard(r) {
  const last = r.checks?.[r.checks.length - 1];
  if (!last) return r.reviewNote ? h('p', { class: 'team-muted' }, `🔎 ${clip(r.reviewNote, 80)}`) : null;
  // New reports carry a checklist; older ones only a list of sentences.
  const list = last.list?.length
    ? last.list.map((c) => ({ pass: c.pass, item: c.item, note: c.note }))
    : last.issues.map((x) => ({ pass: PASSED_RE.test(x), item: '', note: x }));
  const sorted = [...list.filter((c) => !c.pass), ...list.filter((c) => c.pass)];
  const asks = (r.needsYou || []).filter((x) => !RULED_RE.test(x));
  const rounds = r.checks.length - 1;
  return h('div', { class: `team-verdict ${last.pass ? 'ok' : 'warn'}` },
    h('div', { class: 'tv-head' },
      h('span', { class: 'tv-score' }, String(last.score), h('small', {}, '/10')),
      h('div', {},
        h('b', {}, last.pass ? 'ผ่านแล้ว' : 'ยังไม่ผ่าน'),
        h('div', { class: 'team-muted' }, `ผังตรวจ ${list.length} ข้อ · ผ่าน ${list.length - sorted.filter((c) => !c.pass).length}${rounds ? ` · แก้เองไป ${rounds} รอบ` : ''}`))),
    h('ul', { class: 'tv-checks' }, ...sorted.map((c) => h('li', { class: c.pass ? 'pass' : 'fail' },
      h('span', { class: 'tv-mark', 'aria-label': c.pass ? 'ผ่าน' : 'ไม่ผ่าน' }, c.pass ? '✓' : '✗'),
      h('span', {}, c.item ? h('b', {}, c.item) : null, c.item && c.note ? ' — ' : null, clip(c.note, 110))))),
    asks.length ? h('div', { class: 'tv-ask' },
      h('div', { class: 'tv-label' }, '❓ ทีมขาดข้อมูล — ตอบได้ในช่อง ↻ ให้แก้ ด้านล่าง'),
      h('ul', { class: 'tv-list' }, ...asks.map((x) => h('li', { title: x }, clip(x, 110))))) : null,
    rounds ? h('details', { class: 'tv-more' },
      h('summary', {}, `ดูรอบก่อนหน้า (${rounds})`),
      h('div', { class: 'tv-rounds' },
        ...r.checks.map((c, i) => h('a', { href: c.image, target: '_blank', rel: 'noopener' },
          h('img', { src: c.image, alt: '' }), h('span', {}, `${i === rounds ? 'ล่าสุด' : `รอบ ${i + 1}`} · ${c.score}/10`))))) : null);
}

const DISCARD_REASONS = {
  image: ['สินค้าดูไม่เนียน/ลอย', 'ฉากไม่สมจริง', 'สีไม่ตรงแบรนด์', 'รกเกินไป', 'ไม่ตรงโจทย์', 'ไม่มีที่ว่างใส่พาดหัว'],
  default: ['ไม่ตรงโจทย์', 'ข้อมูลไม่ถูก', 'ภาษาแข็ง/ไม่เป็นธรรมชาติ', 'ยาวไป', 'ไม่ตรงแบรนด์'],
};

const STAGE_LABELS = { review: 'ผังกำลังตรวจภาพก่อนส่งให้คุณ', plan: 'ผังกำลังวางผัง', generate: 'พิมพ์กำลังเจนภาพ/ไดคัท', assemble: 'กำลังประกอบใน VectorCraft', motion: 'มูฟกำลังทำแอนิเมชัน' };

function fillProducts() {
  const select = document.getElementById('teamProductSelect');
  if (select.options.length > 1 || !state.products?.length) return;
  const types = [...new Set(state.products.map((p) => p.type))];
  select.append(...types.map((type) => h('optgroup', { label: type },
    ...state.products.filter((p) => p.type === type).map((p) => h('option', { value: p.model }, `${p.model} · ${p.nameTh}`)))));
}

// No file picking: ประกอบ works on the latest layered picture (one waiting
// for review first). A picture's own "🎓 สอนประกอบจากงานนี้" button switches
// to that one; ✕ goes back to the latest.
let vectorPinned = null;

function vectorTasks() {
  return state.tasks
    .filter((t) => t.result?.document?.endsWith('.vectorcraft') && !['queued', 'running'].includes(t.status) && t.result?.stage !== 'teaching')
    .sort((a, b) => (a.status === 'review') - (b.status === 'review') || new Date(a.updatedAt) - new Date(b.updatedAt))
    .reverse();
}

function fillVectorSources() {
  const tasks = vectorTasks();
  const pinned = vectorPinned && tasks.find((t) => t.id === vectorPinned);
  const current = pinned || tasks[0] || null;
  for (const id of ['teamChatVectorSource']) {
    const select = document.getElementById(id);
    select.replaceChildren(h('option', { value: current?.id || '' }, ''));
    select.value = current?.id || '';
  }
  const key = `${current?.id}:${current?.result?.images?.[0]}:${Boolean(pinned)}`;
  for (const box of document.querySelectorAll('[data-pick]')) {
    if (box.dataset.key === key) continue;
    box.dataset.key = key;
    box.replaceChildren(...(current
      ? [
        current.result.images?.[0] ? h('img', { src: current.result.images[0], alt: '' }) : null,
        h('span', {}, h('b', {}, pinned ? 'ภาพที่เลือก: ' : 'ภาพล่าสุด: '), (current.prompt || 'งานภาพ').slice(0, 70)),
        pinned ? h('button', { type: 'button', class: 'team-link', onclick: () => { vectorPinned = null; fillVectorSources(); } }, '✕ ใช้ภาพล่าสุด') : null,
      ]
      : [h('span', { class: 'team-muted' }, 'ยังไม่มีภาพแยกเลเยอร์ สั่ง @พิมพ์ ทำภาพก่อน')]));
  }
}

// A picture's "✏️ ให้ประกอบแก้ภาพนี้": pin it and start an @ประกอบ message.
function chooseVectorSource(id) {
  vectorPinned = id;
  fillVectorSources();
  if (!/@ประกอบ/.test(promptEl.value)) promptEl.value = `@ประกอบ ${promptEl.value.replace(/@\S+\s*/, '')}`;
  chatMode = 'do';
  selectAgent('assemble');
  promptEl.focus();
  promptEl.setSelectionRange(promptEl.value.length, promptEl.value.length);
}

// "🎓 ฉันแก้ให้ดูเป็นตัวอย่าง": open a copy in VectorCraft for her to edit;
// ประกอบ compares before/after and learns once she approves.
async function submitVectorTeaching(sourceTaskId, btn) {
  btn.disabled = true;
  try {
    const task = await api('/api/agents/vector-teaching/start', { sourceTaskId, prompt: '' });
    await api('/api/agents/open-in-app', { src: task.result.document, app: 'vectorcraft' });
    btn.textContent = 'เปิดสำเนาแล้ว แก้แล้วบันทึกใน VectorCraft';
    await refresh();
  } catch (err) { btn.textContent = err.message; btn.disabled = false; }
}

function renderVectorLive() {
  const live = state.vectorLive || { status: 'idle' };
  const active = ['connecting', 'playing'].includes(live.status);
  document.getElementById('teamVectorLiveStop').hidden = !active;
  document.getElementById('teamVectorLiveStatus').textContent = live.status === 'connecting' ? 'กำลังเปิด VectorCraft…'
    : live.status === 'playing' ? `กำลังแก้สดใน VectorCraft · ขั้น ${live.step}/${live.total} · ดูรายละเอียดใน Log`
      : live.status === 'done' ? `แสดงครบ ${live.total} ขั้นแล้ว เปิดตรวจใน VectorCraft ต่อได้`
        : live.status === 'failed' || live.status === 'stopped' ? live.error || 'หยุดแล้ว' : '';
}

document.getElementById('teamVectorLiveStop').addEventListener('click', async (e) => {
  e.currentTarget.disabled = true;
  try { await api('/api/agents/vector-live/stop', {}); await refresh(); }
  catch (err) { document.getElementById('teamVectorLiveStatus').textContent = err.message; }
  finally { e.target.disabled = false; }
});

async function replayVectorLive(task, btn, msg) {
  btn.disabled = true;
  try {
    await api(`/api/agents/tasks/${task.id}/vector-live`, {});
    msg.textContent = 'เปิดสำเนาใน VectorCraft แล้ว กำลังแสดงขั้นตอนเดิมทีละขั้น';
    await refresh();
  } catch (err) { msg.textContent = err.message; }
  finally { btn.disabled = false; }
}

function vectorResultView(task, editable) {
  const r = task.result || {};
  const msg = h('p', { class: 'team-muted', role: 'status' });
  if (r.stage === 'teaching') {
    return h('div', { class: 'team-result' },
      h('p', {}, 'เปิดสำเนานี้ แก้เป็นตัวอย่าง แล้วบันทึกไฟล์ใน VectorCraft (⌘S) ก่อนให้ประกอบเปรียบเทียบ'),
      h('p', { class: 'team-muted' }, 'ระบบอ่านการเปลี่ยนแปลงจากไฟล์ที่บันทึก ไม่ได้บันทึกการขยับเมาส์'),
      h('div', { class: 'team-actions' },
        h('button', { type: 'button', class: 'team-btn', disabled: !state.runner, onclick: (e) => openInApp(r.document, e.currentTarget, 'vectorcraft') }, 'เปิดไฟล์ตัวอย่างใน VectorCraft'),
        h('button', { type: 'button', class: 'team-btn team-btn-primary', disabled: !state.runner, onclick: async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          try { await api(`/api/agents/tasks/${task.id}/vector-teaching/capture`, {}); await refresh(); }
          catch (err) { msg.textContent = err.message; btn.disabled = false; }
        } }, 'บันทึกแล้ว ให้ประกอบเปรียบเทียบ'),
        h('button', { type: 'button', class: 'team-btn', disabled: !state.runner, onclick: async () => {
          try { await api(`/api/agents/tasks/${task.id}/reject`, { reason: 'ยกเลิกการสอน' }); await refresh(); }
          catch (err) { msg.textContent = err.message; }
        } }, 'ยกเลิกการสอน')),
      msg);
  }
  return h('div', { class: 'team-result' },
    h('div', { class: 'team-vector-comparison' },
      ...[['ก่อนแก้', r.beforeImage], ['หลังแก้', r.images?.[0]]].filter(([, src]) => src).map(([label, src]) => h('figure', {}, h('figcaption', {}, label), h('a', { href: src, target: '_blank', rel: 'noopener' }, h('img', { src, alt: label, loading: 'lazy' }))))),
    h('p', {}, r.summary || ''),
    r.document ? h('div', { class: 'team-actions' },
      h('a', { href: r.document, download: '', class: 'team-btn' }, 'ดาวน์โหลดไฟล์ที่แก้'),
      state.runner ? h('button', { type: 'button', class: 'team-btn', onclick: (e) => openInApp(r.document, e.currentTarget, 'vectorcraft') }, 'เปิดตรวจใน VectorCraft') : null,
      state.runner && r.commands?.length ? h('button', { type: 'button', class: 'team-btn', onclick: (e) => replayVectorLive(task, e.currentTarget, msg) }, '▶ ดูการแก้สดใน VectorCraft') : null,
      state.runner ? h('button', { type: 'button', class: 'team-btn', onclick: () => chooseVectorSource(task.id) }, 'ให้ประกอบแก้ต่อจากไฟล์นี้') : null) : null,
    msg,
    r.lesson ? h('div', {},
      h('h4', {}, editable ? 'บทเรียนที่เสนอ — ตรวจหรือแก้ก่อนกดผ่าน' : 'บทเรียนที่บันทึก'),
      h('strong', {}, r.lesson.title || ''),
      h('label', {}, 'ใช้เมื่อ', editable ? h('textarea', { class: 'team-edit', rows: 2, 'data-vector-condition': '', value: r.lesson.condition || '' }) : h('p', {}, r.lesson.condition || '')),
      h('label', {}, 'วิธีทำที่ให้จำ', editable ? h('textarea', { class: 'team-edit', rows: 4, 'data-vector-rule': '', value: r.lesson.rule || '' }) : h('p', { class: 'team-pre' }, r.lesson.rule || '')),
      editable ? h('p', { class: 'team-muted' }, 'ยังไม่ใช้เป็นบทเรียนจนคุณกด “ถูกต้อง และจำวิธีนี้”') : null) : null,
    r.diff?.length ? h('details', {}, h('summary', {}, `ตรวจพบการเปลี่ยนแปลงจริง ${r.diff.length} รายการ`), h('ul', {}, ...r.diff.map((d) => h('li', {}, d.name || `วัตถุ ${d.id}`)))) : null);
}

async function makeMotion(task, btn) {
  btn.disabled = true;
  try {
    await api('/api/agents/tasks', { agent: 'motion', input: { sourceTaskId: task.id } });
    btn.textContent = 'ส่งให้มูฟแล้ว ✓';
    refresh();
  } catch (err) {
    btn.textContent = err.message;
    btn.disabled = false;
  }
}

async function reassemble(task, btn) {
  btn.disabled = true;
  btn.textContent = 'ประกอบกำลังจัดใหม่…';
  try {
    await api(`/api/agents/tasks/${task.id}/reassemble`, {});
    reviewKey = '';
    refresh();
  } catch (err) {
    btn.textContent = err.message;
    btn.disabled = false;
  }
}

function fullscreenVideo(btn) {
  const video = btn.closest('.team-result')?.querySelector('video');
  if (!video) return;
  video.muted = false;
  video.play().catch(() => {});
  (video.requestFullscreen || video.webkitRequestFullscreen || video.webkitEnterFullscreen)?.call(video);
}

async function openInApp(src, btn, app) {
  const label = btn.textContent;
  btn.disabled = true;
  try {
    await api('/api/agents/open-in-app', { src, app });
    btn.textContent = 'เปิดแล้ว ✓';
  } catch (err) {
    btn.textContent = err.message;
  }
  setTimeout(() => { btn.textContent = label; btn.disabled = false; }, 2500);
}

function approveBody(task, card) {
  if (task.agent === 'assemble') return {
    rule: card.querySelector('[data-vector-rule]')?.value,
    condition: card.querySelector('[data-vector-condition]')?.value,
  };
  if (task.agent === 'adideas' || task.agent === 'productvideo') {
    const ideas = [...card.querySelectorAll('.team-idea')];
    const decisions = ideas.map((el) => ({ picked: el.dataset.choice === 'pick', reason: el.querySelector('[data-reason]').value }));
    if (ideas.some((el) => !el.dataset.choice)) throw new Error('เลือก ✓ หรือ ✕ ให้ครบทุกไอเดียก่อน');
    return { decisions };
  }
  if (task.agent === 'image') {
    const picked = card.querySelector('[data-image]:checked');
    return { image: picked ? Number(picked.dataset.image) : 0 };
  }
  if (task.agent === 'caption') return { caption: card.querySelector('[data-caption]').value };
  if (task.agent === 'website') {
    const entries = task.result?.entries || [];
    return {
      entries: entries
        .map((en, i) => ({ date: en.date, text: card.querySelector(`[data-entry="${i}"]`).value, keep: card.querySelector(`[data-entry-keep="${i}"]`).checked }))
        .filter((en) => en.keep)
        .map(({ date, text }) => ({ date, text })),
    };
  }
  return {};
}

function showReviewFor(taskIds) {
  const cards = [...document.querySelectorAll('#teamReview .team-review-card')].filter((c) => taskIds.includes(c.dataset.task));
  if (!cards.length) return;
  cards[0].scrollIntoView({ behavior: 'smooth', block: 'start' });
  for (const c of cards) {
    c.classList.remove('team-review-flash');
    void c.offsetWidth;
    c.classList.add('team-review-flash');
  }
}

function renderReview() {
  const box = document.getElementById('teamReview');
  const tasks = state.tasks.filter((t) => t.status === 'review');
  document.getElementById('teamReviewCount').textContent = tasks.length ? String(tasks.length) : '';
  const key = tasks.map((t) => `${t.id}:${t.rounds}:${t.result?.stage}:${t.result?.document}`).join('|');
  if (key === reviewKey) return;
  reviewKey = key;
  if (!tasks.length) {
    box.replaceChildren(h('p', { class: 'team-muted' }, 'ไม่มีงานรอตรวจ'));
    return;
  }
  box.replaceChildren(...tasks.map((task) => {
    const a = agentById(task.agent);
    const card = h('article', { class: 'team-review-card', 'data-task': task.id },
      h('div', { class: 'team-review-head' },
        h('img', { src: a.avatar, alt: '', class: 'team-avatar-sm' }),
        h('div', {},
          h('strong', {}, `${a.name} · ${a.role}`),
          h('div', { class: 'team-muted' }, `${task.prompt || a.role}${task.rounds > 1 ? ` · แก้รอบที่ ${task.rounds - 1}` : ''}`))),
      resultView(task, state.runner));
    if (state.runner && task.result?.stage !== 'teaching') card.append(decisionBar(task, a, card));
    return card;
  }));
}

// ─── Decisions ──────────────────────────────────────────────────────────
// Each review card gets three clearly separated choices. Picking one only
// opens its panel; nothing is sent until the coloured confirm button, and
// even then there are a few seconds to undo (she often mis-clicked before).
const UNDO_SECONDS = 5;

const PASS_EFFECT = {
  adideas: 'ไอเดียที่ติ๊ก ✓ จะกลายเป็นการ์ดใน Graphic Design และส่งให้พิมพ์ทำภาพ ส่วนที่ ✕ จะเก็บเหตุผลไว้ให้ปิ๊งเรียนรู้',
  productvideo: 'ไอเดียที่ติ๊ก ✓ จะกลายเป็นการ์ดในคอลัมน์ไอเดียของบอร์ด VDO',
  caption: 'แคปชันในกล่อง (ที่คุณแก้ได้) จะถูกบันทึกลงการ์ด',
  website: 'รายการที่ติ๊กไว้จะลงบันทึกเว็บไซต์',
  image: 'ภาพจะแนบเข้าการ์ด Graphic Design (ถ้างานนี้มาจากไอเดียแอด) ถ้าไม่ได้ผูกการ์ดจะเก็บไว้เฉยๆ',
  motion: 'เก็บคลิปนี้ไว้',
  assemble: 'เก็บไฟล์ที่แก้และจำเฉพาะบทเรียนที่คุณตรวจแล้ว ประกอบจะอ่านบทเรียนเมื่อรับงานแก้ครั้งถัดไป',
};

function decisionBar(task, a, card) {
  const panels = {};
  const tabs = {};
  const msg = h('p', { class: 'team-decision-msg', role: 'status' });
  const choose = (key) => {
    Object.entries(panels).forEach(([k, p]) => { p.hidden = k !== key; });
    Object.entries(tabs).forEach(([k, t]) => { t.classList.toggle('selected', k === key); t.setAttribute('aria-pressed', String(k === key)); });
    msg.textContent = '';
    panels[key]?.querySelector('textarea, input[type=text]')?.focus();
  };
  const closeBtn = () => h('button', { type: 'button', class: 'team-link', onclick: () => choose(null) }, 'ยกเลิก');

  // ✓ ผ่าน
  const nextBox = task.agent === 'adideas' ? h('input', { type: 'checkbox', checked: true }) : null;
  panels.pass = h('div', { class: 'team-panel team-panel-pass', hidden: true },
    h('p', {}, h('b', {}, 'เมื่อยืนยัน: '), PASS_EFFECT[task.agent] || 'งานนี้จะถูกบันทึกว่าผ่าน'),
    nextBox ? h('label', { class: 'team-check' }, nextBox, ' ขอไอเดียถัดไปจากปิ๊งต่อเลย') : null,
    h('div', { class: 'team-panel-actions' }, closeBtn(), h('button', {
      type: 'button',
      class: 'team-btn team-confirm-pass',
      onclick: () => {
        let body;
        try { body = approveBody(task, card); } catch (err) { msg.textContent = err.message; return; }
        if (nextBox?.checked) body.next = true;
        scheduleAction(card, `✓ ผ่าน — ${a.approveLabel || 'อนุมัติ'}`, () => api(`/api/agents/tasks/${task.id}/approve`, body));
      },
    }, `✓ ยืนยัน ผ่าน`)));

  // ↻ ให้แก้
  const fix = h('textarea', { class: 'team-edit', rows: 3, placeholder: `บอก${a.name}ว่าต้องแก้อะไร เช่น พาดหัวสั้นกว่านี้ / คนตัวเล็กไป` });
  panels.revise = h('div', { class: 'team-panel team-panel-revise', hidden: true },
    h('p', {}, `${a.name}จะทำงานนี้ใหม่ตามที่คุณบอก แล้วส่งกลับมาให้ตรวจอีกรอบ`),
    quickChips(task, fix),
    fix,
    h('div', { class: 'team-panel-actions' }, closeBtn(), h('button', {
      type: 'button',
      class: 'team-btn team-confirm-revise',
      onclick: () => {
        if (!fix.value.trim()) { msg.textContent = 'พิมพ์ก่อนว่าต้องแก้อะไร'; fix.focus(); return; }
        scheduleAction(card, `↻ ส่งกลับให้${a.name}แก้`, () => api(`/api/agents/tasks/${task.id}/revise`, { feedback: fix.value }));
      },
    }, '↻ ยืนยัน ส่งกลับให้แก้')));

  // ✕ ไม่ผ่าน
  const why = h('input', { type: 'text', class: 'team-edit', placeholder: 'ทำไมไม่ผ่าน (ทีมจะจำไว้ใช้รอบหน้า)' });
  panels.reject = h('div', { class: 'team-panel team-panel-reject', hidden: true },
    h('p', {}, 'งานนี้จะถูกทิ้ง ไม่ทำต่อ และเหตุผลจะถูกเก็บไว้ให้ทีมเรียนรู้'),
    quickChips(task, why),
    why,
    h('div', { class: 'team-panel-actions' }, closeBtn(), h('button', {
      type: 'button',
      class: 'team-btn team-confirm-reject',
      onclick: () => scheduleAction(card, '✕ ไม่ผ่าน', () => api(`/api/agents/tasks/${task.id}/reject`, { reason: why.value })),
    }, '✕ ยืนยัน ไม่ผ่าน')));

  const tab = (key, label, cls) => {
    tabs[key] = h('button', { type: 'button', class: `team-choice-tab ${cls}`, 'aria-pressed': 'false', onclick: () => choose(key) }, label);
    return tabs[key];
  };
  return h('div', { class: 'team-decision' },
    h('div', { class: 'team-decision-label' }, 'ตัดสินงานนี้'),
    h('div', { class: 'team-choice-tabs' },
      tab('pass', '✓ ผ่าน', 'is-pass'),
      tab('revise', '↻ ให้แก้', 'is-revise'),
      tab('reject', '✕ ไม่ผ่าน', 'is-reject')),
    panels.pass, panels.revise, panels.reject, msg);
}

function quickChips(task, input) {
  return h('div', { class: 'team-tags' }, ...(DISCARD_REASONS[task.agent] || DISCARD_REASONS.default).map((r) => h('button', {
    type: 'button',
    class: 'team-reason-chip',
    onclick: () => { input.value = input.value ? `${input.value}, ${r}` : r; input.focus(); },
  }, r)));
}

// Sends after a countdown with a big ย้อนกลับ button; the card is locked
// meanwhile so a second stray click can't fire anything.
function scheduleAction(el, label, run) {
  if (el.classList.contains('team-pending')) return;
  el.classList.add('team-pending');
  let left = UNDO_SECONDS;
  const count = h('span', {}, String(left));
  const undo = h('button', { type: 'button', class: 'team-btn team-undo' }, 'ย้อนกลับ');
  const bar = h('div', { class: 'team-pending-bar', role: 'status' }, h('span', {}, `${label} · ส่งใน `, count, ' วินาที'), undo);
  el.append(bar);
  const timer = setInterval(async () => {
    left -= 1;
    count.textContent = String(left);
    if (left > 0) return;
    clearInterval(timer);
    undo.disabled = true;
    bar.firstChild.textContent = `${label} · กำลังส่ง…`;
    try {
      const res = await run();
      bar.firstChild.textContent = `${label} · เรียบร้อย${res?.note ? ` — ${res.note}` : ''}`;
      setTimeout(() => { reviewKey = ''; refresh(); }, 1200);
    } catch (err) {
      bar.firstChild.textContent = `ส่งไม่สำเร็จ: ${err.message}`;
      el.classList.remove('team-pending');
      setTimeout(() => bar.remove(), 4000);
    }
  }, 1000);
  undo.addEventListener('click', () => {
    clearInterval(timer);
    el.classList.remove('team-pending');
    bar.remove();
  });
}

async function act(url, body, msgEl) {
  try {
    const res = await api(url, body);
    if (res.note) msgEl.textContent = res.note;
    reviewKey = '';
    refresh();
  } catch (err) {
    msgEl.textContent = err.message;
  }
}

function speaker(id) {
  if (id === 'you') return { name: 'หนิง', avatar: null };
  return agentById(id);
}

// ─── Task list ──────────────────────────────────────────────────────────
function stepper(status) {
  const idx = STEPS.findIndex((s) => s.key === status);
  return h('ol', { class: 'team-steps' }, ...STEPS.map((s, i) => h('li', { class: i < idx ? 'past' : i === idx ? 'now' : '' }, s.label)));
}

function renderTasks() {
  const box = document.getElementById('teamTasks');
  // Don't rebuild under a pending (undoable) action, or its ย้อนกลับ button vanishes.
  if (box.querySelector('.team-pending')) return;
  const open = new Set([...box.querySelectorAll('details[open]')].map((d) => d.dataset.id));
  const tasks = state.tasks.filter((t) => t.status !== 'review');
  if (!tasks.length) {
    box.replaceChildren(h('p', { class: 'team-muted' }, 'ยังไม่มีงาน'));
    return;
  }
  box.replaceChildren(...tasks.map((task) => {
    const a = agentById(task.agent);
    const msg = h('span', { class: 'team-muted' });
    const finished = ['done', 'rejected', 'failed'].includes(task.status);
    return h('div', { class: `team-task team-task-${task.status}` },
      h('img', { src: a.avatar, alt: '', class: 'team-avatar-sm' }),
      h('div', { class: 'team-task-body' },
        h('div', { class: 'team-task-top' },
          h('strong', {}, a.name),
          h('span', { class: `team-status team-status-${task.status}` }, STATUS_LABELS[task.status] || task.status),
          h('span', { class: 'team-muted' }, timeText(task.createdAt)),
          task.durationMs && finished ? h('span', { class: 'team-muted' }, `ใช้เวลา ${Math.max(1, Math.round(task.durationMs / 60000))} นาที`) : null),
        h('div', {}, task.prompt || task.cardTitle || a.role),
        task.status === 'running' && STAGE_LABELS[task.result?.stage] ? h('div', { class: 'team-stage' }, `⏳ ${STAGE_LABELS[task.result.stage]}…`) : null,
        task.agent === 'motion' && task.status === 'done' && task.result?.video ? resultView(task, false) : null,
        ['queued', 'running', 'done'].includes(task.status) ? stepper(task.status) : null,
        task.status === 'failed' ? h('p', { class: 'team-error' }, task.error) : null,
        task.status === 'done' && task.result ? h('details', { 'data-id': task.id, open: open.has(task.id) }, h('summary', {}, 'ดูผลงาน'), resultView(task, false)) : null,
        state.runner && (task.status === 'failed' || task.status === 'queued') ? h('div', { class: 'team-actions' },
          msg,
          task.status === 'failed' ? h('button', { type: 'button', class: 'team-btn', onclick: () => act(`/api/agents/tasks/${task.id}/retry`, {}, msg) }, 'ลองใหม่') : null,
          h('button', { type: 'button', class: 'team-btn', onclick: (e) => scheduleAction(e.currentTarget.closest('.team-task'), task.status === 'queued' ? 'ยกเลิกงาน' : 'ทิ้งงาน', () => api(`/api/agents/tasks/${task.id}/reject`, {})) }, task.status === 'queued' ? 'ยกเลิก' : 'ทิ้ง'),
        ) : null));
  }));
}

// ─── Agent settings dialog ──────────────────────────────────────────────
const settingsDialog = document.getElementById('teamSettings');
let settingsAgent = null;
let settingsDefault = '';

async function saveAgentName() {
  const id = settingsAgent;
  const msg = document.getElementById('teamNameMsg');
  const btn = document.getElementById('teamNameSave');
  btn.disabled = true;
  try {
    const res = await fetch(`/api/agents/${id}/name`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: document.getElementById('teamNameInput').value }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'บันทึกไม่สำเร็จ');
    const a = agentById(id);
    a.name = data.name;
    document.getElementById('teamNameInput').value = data.name;
    document.getElementById('teamSettingsTitle').textContent = `${a.name} · ${a.role}`;
    msg.textContent = `บันทึกแล้ว เรียกในแชทด้วย @${data.name}`;
    renderRoster();
    if (selectedAgent === id) selectAgent(id);
    refresh();
  } catch (err) {
    msg.textContent = err.message;
  } finally { btn.disabled = !state.runner; }
}
document.getElementById('teamNameSave').addEventListener('click', saveAgentName);
document.getElementById('teamNameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); saveAgentName(); } });

async function openSettings(id) {
  settingsAgent = id;
  const a = agentById(id);
  document.getElementById('teamSettingsAvatar').src = a.avatar;
  document.getElementById('teamSettingsTitle').textContent = `${a.name} · ${a.role}`;
  document.getElementById('teamSettingsMsg').textContent = '';
  document.getElementById('teamAdjust').value = '';
  document.getElementById('teamSettingsAbout').textContent = 'กำลังโหลด…';
  document.getElementById('teamEngineSection').hidden = true;
  document.getElementById('teamEngineMsg').textContent = '';
  document.getElementById('teamNameSection').hidden = id === 'all';
  document.getElementById('teamNameInput').value = a.name;
  document.getElementById('teamNameInput').disabled = !state.runner;
  document.getElementById('teamNameSave').disabled = !state.runner;
  document.getElementById('teamNameMsg').textContent = '';
  if (!settingsDialog.open) settingsDialog.showModal();
  try {
    const st = await api(`/api/agents/${id}/settings`);
    settingsDefault = st.defaultRules;
    document.getElementById('teamNameMsg').textContent = st.defaultName && st.defaultName !== st.name
      ? `ชื่อเดิม: ${st.defaultName} (ลบชื่อให้ว่างแล้วบันทึกเพื่อกลับไปใช้ชื่อเดิม)` : 'ใช้เรียกด้วย @ ในแชท ห้ามมีช่องว่าง';
    document.getElementById('teamEngineSection').hidden = !st.canChooseEngine;
    document.getElementById('teamEngine').value = st.enginePreference;
    document.getElementById('teamEngine').disabled = !state.runner;
    document.getElementById('teamEngineSave').disabled = !state.runner;
    document.querySelector('#teamEngine option[value="default"]').textContent = id === 'all'
      ? 'ค่าเดิม (Claude)' : `ตามทีม (${ENGINE_LABELS[st.teamEngine]})`;
    document.getElementById('teamEngineHelp').textContent = id === 'all'
      ? 'ใช้กับทุกฝ่ายที่เลือกตามทีม (พิมพ์ยังใช้ Codex สร้างภาพเสมอ) การเปลี่ยนมีผลในการเรียก AI ครั้งถัดไป'
      : 'เลือกตามทีม หรือกำหนดเฉพาะฝ่ายนี้ เก็บกฎและผลงานเดิมไว้ การเปลี่ยนมีผลในการเรียก AI ครั้งถัดไป';
    document.getElementById('teamSettingsMeta').textContent = `${ENGINE_LABELS[st.engine] || st.engine} · ${st.model}${st.tools.length ? ` · เครื่องมือ: ${st.tools.join(', ')}` : ''}`;
    document.getElementById('teamSettingsAbout').textContent = st.about;
    document.getElementById('teamRulesSection').hidden = !st.usesRules;
    document.getElementById('teamRules').value = st.rules;
    document.getElementById('teamRules').readOnly = !state.runner;
    document.getElementById('teamRulesState').textContent = st.isDefault ? '(ค่าเริ่มต้น)' : `(แก้ล่าสุด ${timeText(st.updatedAt)})`;
    document.getElementById('teamSettingsLearned').replaceChildren(...(st.learned.length ? st.learned : [{ none: true }]).map((l) => (l.none
      ? h('li', { class: 'team-muted' }, 'ยังไม่มี')
      : h('li', { class: l.picked ? 'picked' : 'skipped' }, h('span', {}, l.picked ? '✓ ' : '✕ '), h('b', {}, l.title.length > 80 ? `${l.title.slice(0, 80)}…` : l.title), l.reason ? h('span', { class: 'team-muted' }, ` — ${l.reason}`) : null))));
    document.getElementById('teamPromptSection').hidden = !st.prompt;
    document.getElementById('teamSettingsPrompt').textContent = `${st.prompt}${st.rules.trim() ? `\n\nกฎจากผู้ดูแล:\n${st.rules}` : ''}`;
  } catch (err) {
    document.getElementById('teamSettingsAbout').textContent = err.message;
  }
}

document.getElementById('teamSettingsClose').addEventListener('click', () => settingsDialog.close());
settingsDialog.addEventListener('click', (e) => { if (e.target === settingsDialog) settingsDialog.close(); });

document.getElementById('teamEngineSave').addEventListener('click', async (e) => {
  const id = settingsAgent;
  const msg = document.getElementById('teamEngineMsg');
  e.currentTarget.disabled = true;
  try {
    const response = await fetch(`/api/agents/${id}/engine`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ engine: document.getElementById('teamEngine').value }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'บันทึกไม่ได้');
    await refresh();
    if (settingsAgent === id) {
      await openSettings(id);
      msg.textContent = `บันทึกแล้ว ใช้ ${ENGINE_LABELS[data.engine]} ในการเรียก AI ครั้งถัดไป`;
    }
  } catch (err) { msg.textContent = err.message; }
  finally { e.target.disabled = !state.runner; }
});

document.getElementById('teamRulesSave').addEventListener('click', async () => {
  const msg = document.getElementById('teamSettingsMsg');
  try {
    await fetch(`/api/agents/${settingsAgent}/settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rules: document.getElementById('teamRules').value }),
    }).then(async (r) => { if (!r.ok) throw new Error((await r.json()).error || 'บันทึกไม่ได้'); });
    msg.textContent = 'บันทึกแล้ว ใช้ตั้งแต่งานถัดไป';
    document.getElementById('teamRulesState').textContent = '(เพิ่งบันทึก)';
  } catch (err) { msg.textContent = err.message; }
});

document.getElementById('teamRulesReset').addEventListener('click', () => {
  document.getElementById('teamRules').value = settingsDefault;
  document.getElementById('teamSettingsMsg').textContent = 'คืนค่าเริ่มต้นแล้ว กดบันทึกเพื่อใช้';
});

document.getElementById('teamAdjustBtn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const msg = document.getElementById('teamSettingsMsg');
  const request = document.getElementById('teamAdjust').value.trim();
  if (!request) { msg.textContent = 'พิมพ์ก่อนว่าอยากให้ปรับอะไร'; return; }
  btn.disabled = true;
  msg.textContent = 'AI กำลังแก้กฎ…';
  try {
    const res = await api(`/api/agents/${settingsAgent}/settings/adjust`, { request, rules: document.getElementById('teamRules').value });
    document.getElementById('teamRules').value = res.rules;
    msg.textContent = `${res.summary} — ตรวจแล้วกดบันทึก`;
  } catch (err) { msg.textContent = err.message; }
  btn.disabled = false;
});

// ─── Side log (every agent, newest first, like a terminal) ──────────────
const logEvents = [];
let logSince = null;
let logScrolled = false;
let logFollow = true;
// Pictures load after the list is drawn; keep the view pinned to the newest.
function followLogBottom() {
  if (!logFollow) return;
  const box = document.getElementById('teamLog');
  box.scrollTop = box.scrollHeight;
}

function logBlock(e) {
  const from = speaker(e.agent);
  const to = e.toAgent ? speaker(e.toAgent) : null;
  const failed = /ไม่สำเร็จ|failed/i.test(e.text);
  const kind = failed ? 'error' : e.kind;
  const label = e.kind === 'think' ? '🧠 คิด' : e.kind === 'handoff' ? `📤 → ${to?.name || ''}` : '🛠️';
  const time = new Date(e.createdAt).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  if (e.kind === 'log' && !e.detail) {
    return h('div', { class: `team-log-item team-log-${kind}` },
      h('div', { class: 'team-log-title' }, h('span', { class: 'team-log-dot' }), h('b', {}, from.name), ` ${e.text}`, h('span', { class: 'team-log-time' }, time)));
  }
  const io = (tag, text, cut) => h('div', { class: 'team-log-io' },
    h('span', { class: 'team-log-tag' }, tag),
    text.length > cut
      ? h('details', {}, h('summary', {}, `${text.slice(0, cut)}…`), h('pre', {}, text))
      : h('pre', {}, text));
  return h('div', { class: `team-log-item team-log-${kind}` },
    h('div', { class: 'team-log-title' }, h('span', { class: 'team-log-dot' }), h('b', {}, from.name), ` ${label}`, h('span', { class: 'team-log-time' }, time)),
    h('div', { class: 'team-log-box' },
      e.detail ? io('IN', e.detail, 220) : null,
      io('OUT', e.text, 360),
      e.image ? h('a', { href: e.image, target: '_blank', rel: 'noopener' }, h('img', { src: e.image, alt: '', class: 'team-log-img', onload: followLogBottom })) : null));
}

async function refreshLog() {
  try {
    const { events } = await api(`/api/agents/log${logSince ? `?since=${encodeURIComponent(logSince)}` : ''}`);
    if (!events.length && logEvents.length) return;
    logEvents.unshift(...events);
    logEvents.splice(300);
    if (logEvents.length) logSince = logEvents[0].createdAt;
    // Oldest at the top, newest at the bottom next to the chat box. Follow
    // new lines only if she's already at the bottom (not while reading back).
    const box = document.getElementById('teamLog');
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    box.replaceChildren(...(logEvents.length ? [...logEvents].reverse().map(logBlock) : [h('p', { class: 'team-muted' }, 'ยังไม่มีความเคลื่อนไหว')]));
    logFollow = atBottom || !logScrolled;
    if (logFollow) { box.scrollTop = box.scrollHeight; logScrolled = true; }
  } catch { /* next poll */ }
}

// ─── Resizable log column (drag the divider; remembered per browser) ────
(() => {
  const layout = document.querySelector('.team-layout');
  const handle = document.getElementById('teamLogResizer');
  const MIN = 260;
  const maxW = () => Math.round(window.innerWidth * 0.7);
  const apply = (w) => layout.style.setProperty('--log-w', `${Math.min(maxW(), Math.max(MIN, Math.round(w)))}px`);
  try { const saved = Number(localStorage.getItem('teamLogWidth')); if (saved) apply(saved); } catch {}
  const save = () => { try { localStorage.setItem('teamLogWidth', String(parseInt(getComputedStyle(layout).getPropertyValue('--log-w'), 10) || '')); } catch {} };
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add('team-resizing');
    const move = (ev) => apply(window.innerWidth - ev.clientX);
    const up = () => {
      handle.removeEventListener('pointermove', move);
      document.body.classList.remove('team-resizing');
      save();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up, { once: true });
  });
  handle.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const cur = document.querySelector('.team-log').getBoundingClientRect().width;
    apply(cur + (e.key === 'ArrowLeft' ? 40 : -40));
    save();
  });
  handle.addEventListener('dblclick', () => { layout.style.removeProperty('--log-w'); try { localStorage.removeItem('teamLogWidth'); } catch {} });
})();

// ─── Poll ───────────────────────────────────────────────────────────────
let first = true;
async function refresh() {
  try {
    state = await api('/api/agents');
  } catch (err) {
    document.getElementById('teamStatus').textContent = `โหลดข้อมูลไม่ได้: ${err.message}`;
    return;
  }
  renderStatus();
  if (first) { first = false; selectAgent(null); }
  renderRoster();
  renderReview();
  renderFollowUp();
  renderTasks();
  renderLearnings();
  fillVectorSources();
  renderVectorLive();
}

refresh();
refreshLog();
setInterval(() => { if (!document.hidden) { refresh(); refreshLog(); } }, POLL_MS);
