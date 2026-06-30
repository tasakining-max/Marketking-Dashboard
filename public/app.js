const POLL_INTERVAL_MS = 3000;

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

const board = document.getElementById('board');
const dialog = document.getElementById('cardDialog');
const form = document.getElementById('cardForm');
const titleInput = document.getElementById('cardTitle');
const descInput = document.getElementById('cardDescription');
const dialogTitle = document.getElementById('dialogTitle');
const tagLabel = document.getElementById('cardTagLabel');
const tagCheckboxes = Array.from(document.querySelectorAll('input[name="cardTag"]'));
const ideaTagLabel = document.getElementById('cardIdeaTagLabel');
const ideaTagCheckboxes = Array.from(document.querySelectorAll('input[name="cardIdeaTag"]'));
const platformLabel = document.getElementById('cardPlatformLabel');
const platformCheckboxes = Array.from(document.querySelectorAll('input[name="cardPlatform"]'));
const cardImageInput = document.getElementById('cardImageInput');
const cardImagePreviewWrap = document.getElementById('cardImagePreviewWrap');
const cardImagePreview = document.getElementById('cardImagePreview');
const cardImageRemoveBtn = document.getElementById('cardImageRemoveBtn');
const todoLabel = document.getElementById('cardTodoLabel');
const todoListEl = document.getElementById('cardTodoList');
const todoInput = document.getElementById('cardTodoInput');
const todoAddBtn = document.getElementById('cardTodoAddBtn');
const issueLabel = document.getElementById('cardIssueLabel');
const issueListEl = document.getElementById('cardIssueList');
const issueInput = document.getElementById('cardIssueInput');
const issueAddBtn = document.getElementById('cardIssueAddBtn');
const deleteBtn = document.getElementById('deleteBtn');
const lightboxDialog = document.getElementById('lightboxDialog');
const lightboxImage = document.getElementById('lightboxImage');
const cancelBtn = document.getElementById('cancelBtn');
const addBtn = document.getElementById('addBtn');
const commentLabel = document.getElementById('cardCommentLabel');
const commentListEl = document.getElementById('cardCommentList');
const commentInput = document.getElementById('cardCommentInput');
const commentAddBtn = document.getElementById('cardCommentAddBtn');
const commentAuthorAvatar = document.getElementById('commentAuthorAvatar');
const profileBtn = document.getElementById('profileBtn');
const profileHeaderAvatar = document.getElementById('profileHeaderAvatar');
const profileDialog = document.getElementById('profileDialog');
const profileForm = document.getElementById('profileForm');
const profileNameInput = document.getElementById('profileName');
const profileImageInput = document.getElementById('profileImageInput');
const profilePreviewAvatar = document.getElementById('profilePreviewAvatar');
const profileCancelBtn = document.getElementById('profileCancelBtn');

const rejectDialog = document.getElementById('rejectDialog');
const rejectForm = document.getElementById('rejectForm');
const rejectReasonInput = document.getElementById('rejectReason');
const rejectCancelBtn = document.getElementById('rejectCancelBtn');
const rejectedSection = document.getElementById('rejectedSection');
const rejectedToggle = document.getElementById('rejectedToggle');
const rejectedList = document.getElementById('rejectedList');
const rejectedCount = document.getElementById('rejectedCount');

const COLUMNS = ['idea', 'clip', 'youtube', 'published'];
const TAG_LABELS = {
  factory: '🏭 ถ่ายที่โรงงาน',
  office: '🏢 ถ่ายที่ออฟฟิศ',
  ai: '🤖 AI VDO',
  archive: '🗂 ใช้รูป/วิดีโอเก่า',
  motion: '🎨 Motion Graphic',
  knowledge: '🧠 ความรู้',
  product: '📦 สินค้า',
  trend: '🔥 เทรนด์',
  branding: '🛡️ ความน่าเชื่อถือ/แบรนดิ้ง'
};
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
let editingId = null;
let rejectingId = null;
let lastSignature = null;
let draggingId = null;
let pendingImageDataUrl = null;
let removeImageRequested = false;
let pendingTodos = [];
let pendingComments = [];
let profilePendingImageDataUrl = null;

function loadProfile() {
  try { return JSON.parse(localStorage.getItem('dashboard_profile')) || {}; } catch { return {}; }
}
function saveProfile(p) { localStorage.setItem('dashboard_profile', JSON.stringify(p)); }

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

function initProfileUI() {
  const profile = loadProfile();
  renderAvatar(profileHeaderAvatar, profile.name, profile.imageUrl);
  renderAvatar(commentAuthorAvatar, profile.name, profile.imageUrl);
}
initProfileUI();

const profileSwitcherList = document.getElementById('profileSwitcherList');
const profileAddName = document.getElementById('profileAddName');
const profileAddBtn = document.getElementById('profileAddBtn');

function renderProfileSwitcher() {
  const myName = loadProfile().name;
  profileSwitcherList.innerHTML = '';

  if (!teamProfiles.length) {
    const empty = document.createElement('p');
    empty.className = 'profile-switcher-empty';
    empty.textContent = 'No profiles yet. Add one below.';
    profileSwitcherList.appendChild(empty);
    return;
  }

  teamProfiles.forEach((p) => {
    const isCurrent = p.name === myName;
    const row = document.createElement('div');
    row.className = 'profile-switcher-row' + (isCurrent ? ' is-current' : '');

    const av = document.createElement('span');
    av.className = 'profile-avatar-sm';
    renderAvatar(av, p.name, p.imageUrl);
    row.appendChild(av);

    const name = document.createElement('span');
    name.className = 'profile-switcher-name';
    name.textContent = p.name;
    row.appendChild(name);

    if (isCurrent) {
      const badge = document.createElement('span');
      badge.className = 'profile-current-badge';
      badge.textContent = 'Current';
      row.appendChild(badge);
    } else {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'profile-switcher-btn';
      btn.textContent = 'Switch';
      btn.addEventListener('click', () => {
        saveProfile({ name: p.name, imageUrl: p.imageUrl || null });
        initProfileUI();
        profileDialog.close();
      });
      row.appendChild(btn);
    }

    profileSwitcherList.appendChild(row);
  });
}

async function addTeamProfile(name) {
  name = name.trim();
  if (!name) return;
  await fetch('/api/profiles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, imageUrl: null })
  });
  await fetchTeamProfiles();
  renderProfileSwitcher();
  profileAddName.value = '';
}

profileAddBtn.addEventListener('click', () => addTeamProfile(profileAddName.value));
profileAddName.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); addTeamProfile(profileAddName.value); }
});

profileBtn.addEventListener('click', () => {
  const profile = loadProfile();
  profileNameInput.value = profile.name || '';
  profilePendingImageDataUrl = null;
  renderAvatar(profilePreviewAvatar, profile.name, profile.imageUrl);
  profileDialog.showModal();
  fetchTeamProfiles().then(renderProfileSwitcher);
});
document.querySelector('.profile-avatar-picker-wrap').addEventListener('click', () => profileImageInput.click());
profileCancelBtn.addEventListener('click', () => profileDialog.close());
profileImageInput.addEventListener('change', () => {
  const file = profileImageInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    profilePendingImageDataUrl = reader.result;
    renderAvatar(profilePreviewAvatar, profileNameInput.value, profilePendingImageDataUrl);
  };
  reader.readAsDataURL(file);
});
profileNameInput.addEventListener('input', () => {
  const profile = loadProfile();
  renderAvatar(profilePreviewAvatar, profileNameInput.value, profilePendingImageDataUrl || profile.imageUrl);
});
profileForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const profile = loadProfile();
  profile.name = profileNameInput.value.trim();
  if (profilePendingImageDataUrl) profile.imageUrl = profilePendingImageDataUrl;
  saveProfile(profile);
  initProfileUI();
  profileDialog.close();
  fetchTeamProfiles().then(renderProfileSwitcher);
  fetch('/api/profiles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: profile.name, imageUrl: profile.imageUrl || null })
  });
});
let pendingIssues = [];
let draggingIssueId = null;
let pendingLinks = [];

function signature(data) {
  return JSON.stringify(
    data.cards.map((c) => [c.id, c.title, c.description, c.column, c.status, c.rejectionReason, c.tags, c.platforms, c.imageUrl, c.todos, c.issues, c.comments, c.order, c.updatedAt])
  );
}

let prevCommentMap = null; // cardId → latest comment createdAt

function checkNewComments(cards) {
  const newMap = {};
  cards.forEach((c) => {
    if (Array.isArray(c.comments) && c.comments.length) {
      newMap[c.id] = { latest: c.comments[c.comments.length - 1], title: c.title, comments: c.comments };
    }
  });

  if (prevCommentMap !== null) {
    Object.entries(newMap).forEach(([id, { latest, title, comments }]) => {
      const prev = prevCommentMap[id];
      const prevLatest = prev?.latest;
      if (!prevLatest || latest.createdAt > prevLatest.createdAt) {
        // New comment detected — don't alert if we posted it ourselves
        const myProfile = loadProfile();
        if (latest.authorName !== myProfile.name) {
          showToast({
            avatar: { name: latest.authorName, imageUrl: latest.authorImage },
            message: `<strong>${latest.authorName}</strong> commented on <em>${title}</em>`,
            sub: latest.text,
            onClick: () => {
              const card = cards.find((c) => c.id === id);
              if (card) openDialog(card);
            }
          });
        }
      }
    });
  }

  prevCommentMap = newMap;
}

function showToast({ avatar, message, sub, onClick }) {
  const toast = document.createElement('div');
  toast.className = 'toast';

  const av = document.createElement('span');
  av.className = 'profile-avatar-sm toast-avatar';
  renderAvatar(av, avatar.name, avatar.imageUrl);
  toast.appendChild(av);

  const body = document.createElement('div');
  body.className = 'toast-body';
  const msgEl = document.createElement('p');
  msgEl.className = 'toast-msg';
  msgEl.innerHTML = message;
  const subEl = document.createElement('p');
  subEl.className = 'toast-sub';
  subEl.textContent = sub.length > 80 ? sub.slice(0, 80) + '…' : sub;
  body.appendChild(msgEl);
  body.appendChild(subEl);
  toast.appendChild(body);

  const close = document.createElement('button');
  close.className = 'toast-close';
  close.innerHTML = '×';
  close.addEventListener('click', (e) => { e.stopPropagation(); dismissToast(toast); });
  toast.appendChild(close);

  if (onClick) toast.addEventListener('click', onClick);

  document.getElementById('toastContainer').appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('toast-show'));

  const timer = setTimeout(() => dismissToast(toast), 5000);
  toast._timer = timer;
}

function dismissToast(toast) {
  clearTimeout(toast._timer);
  toast.classList.remove('toast-show');
  toast.classList.add('toast-hide');
  setTimeout(() => toast.remove(), 300);
}

async function fetchCards() {
  const res = await fetch('/api/cards');
  const data = await res.json();
  const sig = signature(data);
  if (sig !== lastSignature) {
    checkNewComments(data.cards);
    lastSignature = sig;
    render(data.cards);
  }
}

function orderValue(card) {
  return card.order ?? new Date(card.createdAt).getTime();
}

function render(cards) {
  const active = cards.filter((c) => c.status !== 'rejected');
  for (const column of COLUMNS) {
    const container = board.querySelector(`[data-column-cards="${column}"]`);
    container.innerHTML = '';
    active
      .filter((c) => c.column === column)
      .sort((a, b) => orderValue(a) - orderValue(b))
      .forEach((card) => container.appendChild(renderCard(card)));
  }
  renderRejected(cards.filter((c) => c.status === 'rejected'));
}

function renderRejected(cards) {
  rejectedCount.textContent = cards.length;
  rejectedSection.hidden = cards.length === 0;
  rejectedList.innerHTML = '';
  cards
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .forEach((card) => {
      const item = document.createElement('div');
      item.className = 'rejected-item';

      const title = document.createElement('p');
      title.className = 'title';
      title.textContent = card.title;
      item.appendChild(title);

      const reason = document.createElement('p');
      reason.className = 'reason';
      reason.textContent = `Reason: ${card.rejectionReason}`;
      item.appendChild(reason);

      const actions = document.createElement('div');
      actions.className = 'rejected-actions';

      const restore = document.createElement('button');
      restore.type = 'button';
      restore.className = 'restore-btn';
      restore.textContent = 'Restore to Idea';
      restore.addEventListener('click', async () => {
        await fetch(`/api/cards/${card.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'active' })
        });
        lastSignature = null;
        fetchCards();
      });
      actions.appendChild(restore);

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'delete-btn';
      del.title = 'Delete permanently';
      del.setAttribute('aria-label', 'Delete permanently');
      del.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M9 3h6l1 2h4v2H4V5h4l1-2zm-3 6h12l-1 12H7L6 9zm4 2v8h1v-8H10zm3 0v8h1v-8h-1z"/></svg>';
      del.addEventListener('click', async () => {
        if (!confirm(`Permanently delete "${card.title}"?`)) return;
        await fetch(`/api/cards/${card.id}`, { method: 'DELETE' });
        lastSignature = null;
        fetchCards();
      });
      actions.appendChild(del);

      item.appendChild(actions);

      rejectedList.appendChild(item);
    });
}

function formatPublished(iso) {
  if (!iso) return '';
  const published = new Date(iso);
  const today = new Date();
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dayDiff = Math.round((startOfDay(today) - startOfDay(published)) / 86400000);
  if (dayDiff === 0) return 'Published today';
  if (dayDiff === 1) return 'Published yesterday';
  if (dayDiff > 1) return `Published ${dayDiff} days ago`;
  return `Published ${published.toLocaleDateString()}`;
}

function renderCard(card) {
  const el = document.createElement('div');
  el.className = 'card';
  el.draggable = true;
  el.dataset.id = card.id;

  const isPublished = card.column === 'published';

  if (card.imageUrl) {
    const img = document.createElement('img');
    img.className = 'card-image';
    img.src = card.imageUrl;
    img.alt = card.title;
    img.title = 'Click to view full size';
    img.draggable = false;
    img.addEventListener('click', (e) => {
      e.stopPropagation();
      openLightbox(card.imageUrl);
    });
    el.appendChild(img);
  }

  const title = document.createElement('p');
  title.className = 'title';
  title.textContent = card.title;
  el.appendChild(title);

  if ((card.column === 'clip' || card.column === 'youtube' || card.column === 'idea') && Array.isArray(card.tags) && card.tags.length) {
    const tagRow = document.createElement('div');
    tagRow.className = 'tag-row';
    card.tags
      .filter((t) => TAG_LABELS[t])
      .forEach((t) => {
        const tagBadge = document.createElement('span');
        tagBadge.className = `tag-badge tag-${t}`;
        tagBadge.textContent = TAG_LABELS[t];
        tagRow.appendChild(tagBadge);
      });
    el.appendChild(tagRow);
  }

  if (card.column === 'published' && Array.isArray(card.platforms) && card.platforms.length) {
    const platformRow = document.createElement('div');
    platformRow.className = 'tag-row';
    card.platforms
      .filter((p) => PLATFORM_LABELS[p])
      .forEach((p) => platformRow.appendChild(createPlatformBadge(p)));
    el.appendChild(platformRow);
  }

  if ((card.column === 'clip' || card.column === 'youtube') && Array.isArray(card.todos) && card.todos.length) {
    const total = card.todos.length;
    const done = card.todos.filter((t) => t.status === 'done').length;
    const inProgress = card.todos.filter((t) => t.status === 'in_progress').length;
    const donePct = Math.round((done / total) * 100);
    const inProgressPct = Math.round((inProgress / total) * 100);

    const progressWrap = document.createElement('div');
    progressWrap.className = 'progress-tank';
    progressWrap.title = `${done}/${total} เสร็จแล้ว, ${inProgress} กำลังทำ`;

    const doneFill = document.createElement('div');
    doneFill.className = 'progress-tank-fill done-fill';
    doneFill.style.width = `${donePct}%`;
    progressWrap.appendChild(doneFill);

    const inProgressFill = document.createElement('div');
    inProgressFill.className = 'progress-tank-fill in-progress-fill';
    inProgressFill.style.width = `${inProgressPct}%`;
    progressWrap.appendChild(inProgressFill);

    const label = document.createElement('span');
    label.className = 'progress-tank-label';
    label.textContent = `${done}/${total}`;
    progressWrap.appendChild(label);

    el.appendChild(progressWrap);
  }

  if ((card.column === 'clip' || card.column === 'youtube') && Array.isArray(card.issues) && card.issues.length) {
    const unsolvedCount = card.issues.filter((i) => i.status !== 'solved').length;
    if (unsolvedCount > 0) {
      const issueBadge = document.createElement('div');
      issueBadge.className = 'issue-badge';
      issueBadge.textContent = `⚠️ ${unsolvedCount} ปัญหา`;
      issueBadge.title = card.issues.filter((i) => i.status !== 'solved').map((i) => i.text).join('\n');
      el.appendChild(issueBadge);
    }
  }

  if (Array.isArray(card.comments) && card.comments.length) {
    const commentBadge = document.createElement('div');
    commentBadge.className = 'comment-badge';
    const avatarRow = document.createElement('span');
    avatarRow.className = 'comment-badge-avatars';
    const shown = card.comments.slice(-3);
    shown.forEach((c) => {
      const av = document.createElement('span');
      av.className = 'profile-avatar-xs';
      renderAvatar(av, c.authorName, c.authorImage);
      av.title = c.authorName;
      avatarRow.appendChild(av);
    });
    commentBadge.appendChild(avatarRow);
    const countEl = document.createElement('span');
    countEl.textContent = `💬 ${card.comments.length}`;
    commentBadge.appendChild(countEl);
    el.appendChild(commentBadge);
  }

  if (Array.isArray(card.links) && card.links.length) {
    const linkRow = document.createElement('div');
    linkRow.className = 'card-link-row';
    card.links.forEach((l) => {
      const a = document.createElement('a');
      a.className = 'card-link-chip';
      a.href = l.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = l.label || '🔗 Link';
      a.title = l.url;
      a.addEventListener('click', (e) => e.stopPropagation());
      linkRow.appendChild(a);
    });
    el.appendChild(linkRow);
  }

  if (isPublished) {
    const publishedLabel = document.createElement('p');
    publishedLabel.className = 'published-date';
    publishedLabel.textContent = formatPublished(card.publishedAt || card.updatedAt);
    el.appendChild(publishedLabel);
  }

  const expandable = document.createElement('div');
  expandable.className = 'card-expandable';
  expandable.hidden = isPublished;

  if (card.description) {
    const desc = document.createElement('p');
    desc.className = 'desc';
    desc.textContent = card.description;
    expandable.appendChild(desc);
  }

  if (Array.isArray(card.todos) && card.todos.length) {
    const todoList = document.createElement('ul');
    todoList.className = 'inline-todo-list';
    card.todos.forEach((todo) => {
      const item = document.createElement('li');
      item.className = `inline-todo-item ${todo.status === 'done' ? 'done' : ''}`;

      const cb = document.createElement('button');
      cb.type = 'button';
      cb.className = `inline-todo-check ${todo.status === 'done' ? 'checked' : ''}`;
      cb.setAttribute('aria-label', todo.status === 'done' ? 'Mark incomplete' : 'Mark done');
      cb.innerHTML = todo.status === 'done'
        ? '<svg width="12" height="12" viewBox="0 0 12 12"><polyline points="2,6 5,9 10,3" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>'
        : '';
      cb.addEventListener('click', async (e) => {
        e.stopPropagation();
        const newStatus = todo.status === 'done' ? 'pending' : 'done';
        const updatedTodos = card.todos.map((t) =>
          t.id === todo.id ? { ...t, status: newStatus } : t
        );
        await fetch(`/api/cards/${card.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ todos: updatedTodos })
        });
        lastSignature = null;
        fetchCards();
      });

      const label = document.createElement('span');
      label.className = 'inline-todo-text';
      label.textContent = todo.text;

      item.appendChild(cb);
      item.appendChild(label);
      todoList.appendChild(item);
    });
    expandable.appendChild(todoList);
  }

  if (Array.isArray(card.issues) && card.issues.length) {
    const issueHeader = document.createElement('p');
    issueHeader.className = 'inline-section-label';
    issueHeader.textContent = 'ปัญหา / ต้องการความช่วยเหลือ';
    expandable.appendChild(issueHeader);

    const issueList = document.createElement('ul');
    issueList.className = 'inline-issue-list';
    card.issues.forEach((issue) => {
      const solved = issue.status === 'solved';
      const item = document.createElement('li');
      item.className = `inline-issue-item ${solved ? 'solved' : ''}`;

      const cb = document.createElement('button');
      cb.type = 'button';
      cb.className = `inline-issue-check ${solved ? 'checked' : ''}`;
      cb.setAttribute('aria-label', solved ? 'Mark as problem' : 'Mark as solved');
      cb.innerHTML = solved
        ? '<svg width="12" height="12" viewBox="0 0 12 12"><polyline points="2,6 5,9 10,3" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>'
        : '';
      cb.addEventListener('click', async (e) => {
        e.stopPropagation();
        const newStatus = solved ? 'problem' : 'solved';
        const updatedIssues = card.issues.map((i) =>
          i.id === issue.id ? { ...i, status: newStatus } : i
        );
        await fetch(`/api/cards/${card.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ issues: updatedIssues })
        });
        lastSignature = null;
        fetchCards();
      });

      const label = document.createElement('span');
      label.className = 'inline-issue-text';
      label.textContent = issue.text;

      item.appendChild(cb);
      item.appendChild(label);
      issueList.appendChild(item);
    });
    expandable.appendChild(issueList);
  }

  if (isPublished) {
    const seeMore = document.createElement('button');
    seeMore.type = 'button';
    seeMore.className = 'see-more-btn';
    seeMore.textContent = 'See more';
    seeMore.addEventListener('click', (e) => {
      e.stopPropagation();
      const collapsed = expandable.hidden;
      expandable.hidden = !collapsed;
      seeMore.textContent = collapsed ? 'See less' : 'See more';
    });
    el.appendChild(seeMore);
  }

  el.appendChild(expandable);

  const colIndex = COLUMNS.indexOf(card.column);
  const moveRow = document.createElement('div');
  moveRow.className = 'move-row';

  const detailBtn = document.createElement('button');
  detailBtn.className = 'detail-btn';
  detailBtn.type = 'button';
  detailBtn.title = 'View detail';
  detailBtn.setAttribute('aria-label', 'View detail');
  detailBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>';
  detailBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openDialog(card);
  });
  moveRow.appendChild(detailBtn);

  if (colIndex > 0) {
    const back = document.createElement('button');
    back.className = 'move-btn';
    back.type = 'button';
    back.title = `Move back to ${COLUMNS[colIndex - 1]}`;
    back.textContent = '←';
    back.addEventListener('click', (e) => {
      e.stopPropagation();
      moveCard(card.id, COLUMNS[colIndex - 1]);
    });
    moveRow.appendChild(back);
  }

  if (colIndex < COLUMNS.length - 1) {
    const forward = document.createElement('button');
    forward.className = 'move-btn';
    forward.type = 'button';
    forward.title = `Move to ${COLUMNS[colIndex + 1]}`;
    forward.textContent = '→';
    forward.addEventListener('click', (e) => {
      e.stopPropagation();
      moveCard(card.id, COLUMNS[colIndex + 1]);
    });
    moveRow.appendChild(forward);
  }

  if (card.column === 'idea') {
    const reject = document.createElement('button');
    reject.className = 'reject-btn';
    reject.type = 'button';
    reject.title = 'Reject idea';
    reject.textContent = 'Reject';
    reject.addEventListener('click', (e) => {
      e.stopPropagation();
      openRejectDialog(card.id);
    });
    moveRow.appendChild(reject);
  }

  const deleteBtnEl = document.createElement('button');
  deleteBtnEl.className = 'delete-btn';
  deleteBtnEl.type = 'button';
  deleteBtnEl.title = 'Delete card';
  deleteBtnEl.setAttribute('aria-label', 'Delete card');
  deleteBtnEl.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M9 3h6l1 2h4v2H4V5h4l1-2zm-3 6h12l-1 12H7L6 9zm4 2v8h1v-8H10zm3 0v8h1v-8h-1z"/></svg>';
  deleteBtnEl.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm(`Delete "${card.title}"?`)) return;
    await fetch(`/api/cards/${card.id}`, { method: 'DELETE' });
    lastSignature = null;
    fetchCards();
  });
  moveRow.appendChild(deleteBtnEl);

  expandable.appendChild(moveRow);

  el.addEventListener('dragstart', () => {
    draggingId = card.id;
    el.classList.add('dragging');
  });
  el.addEventListener('dragend', () => {
    draggingId = null;
    el.classList.remove('dragging');
  });
  el.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  el.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!draggingId || draggingId === card.id) return;
    const container = el.parentElement;
    const column = container.dataset.columnCards;
    const ids = Array.from(container.children).map((c) => c.dataset.id);
    const fromIdx = ids.indexOf(draggingId);
    if (fromIdx !== -1) ids.splice(fromIdx, 1);
    const toIdx = ids.indexOf(card.id);
    ids.splice(toIdx, 0, draggingId);
    await reorderCards(column, ids);
  });

  return el;
}

async function reorderCards(column, ids) {
  await fetch('/api/cards/reorder', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ column, order: ids })
  });
  lastSignature = null;
  fetchCards();
}

async function moveCard(id, column) {
  const container = board.querySelector(`[data-column-cards="${column}"]`);
  const ids = Array.from(container.children).map((c) => c.dataset.id).filter((i) => i !== id);
  ids.push(id);
  await reorderCards(column, ids);
}

board.querySelectorAll('.column').forEach((columnEl) => {
  const newColumn = columnEl.dataset.column;
  columnEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    columnEl.classList.add('drag-over');
  });
  columnEl.addEventListener('dragleave', () => {
    columnEl.classList.remove('drag-over');
  });
  columnEl.addEventListener('drop', async (e) => {
    e.preventDefault();
    columnEl.classList.remove('drag-over');
    if (!draggingId) return;
    await moveCard(draggingId, newColumn);
  });
});

function openLightbox(src) {
  lightboxImage.src = src;
  lightboxDialog.showModal();
}

lightboxDialog.addEventListener('click', () => lightboxDialog.close());

cardImagePreview.addEventListener('click', () => {
  if (cardImagePreview.src) openLightbox(cardImagePreview.src);
});

function setImagePreview(url) {
  if (url) {
    cardImagePreview.src = url;
    cardImagePreviewWrap.hidden = false;
  } else {
    cardImagePreview.src = '';
    cardImagePreviewWrap.hidden = true;
  }
}

let draggingTodoId = null;

const TODO_STATUS_LABELS = {
  plan: '○',
  in_progress: '◐',
  done: '✓'
};
const TODO_STATUS_TITLES = {
  plan: 'Plan',
  in_progress: 'On progress',
  done: 'Done'
};
const TODO_STATUS_CYCLE = { plan: 'in_progress', in_progress: 'done', done: 'plan' };

function renderTodoList() {
  todoListEl.innerHTML = '';
  pendingTodos.forEach((todo) => {
    const item = document.createElement('div');
    item.className = 'todo-item';
    item.draggable = true;
    item.dataset.id = todo.id;

    const handle = document.createElement('span');
    handle.className = 'todo-drag-handle';
    handle.setAttribute('aria-label', 'Drag to reorder');
    handle.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><circle cx="8" cy="6" r="1.6"/><circle cx="16" cy="6" r="1.6"/><circle cx="8" cy="12" r="1.6"/><circle cx="16" cy="12" r="1.6"/><circle cx="8" cy="18" r="1.6"/><circle cx="16" cy="18" r="1.6"/></svg>';
    item.appendChild(handle);

    const statusBtn = document.createElement('button');
    statusBtn.type = 'button';
    statusBtn.setAttribute('aria-label', 'Toggle status');
    const updateStatusBtn = () => {
      statusBtn.className = `todo-status-btn ${todo.status}`;
      statusBtn.textContent = TODO_STATUS_LABELS[todo.status];
      statusBtn.title = TODO_STATUS_TITLES[todo.status];
    };
    updateStatusBtn();
    statusBtn.addEventListener('click', () => {
      todo.status = TODO_STATUS_CYCLE[todo.status];
      updateStatusBtn();
      text.classList.toggle('done', todo.status === 'done');
    });
    item.appendChild(statusBtn);

    const text = document.createElement('span');
    text.className = 'todo-text';
    text.contentEditable = 'true';
    text.textContent = todo.text;
    if (todo.status === 'done') text.classList.add('done');
    text.addEventListener('blur', () => {
      const newText = text.textContent.trim();
      todo.text = newText || todo.text;
      text.textContent = todo.text;
    });
    text.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        text.blur();
      }
    });
    item.appendChild(text);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'todo-delete';
    del.setAttribute('aria-label', 'Delete to-do');
    del.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M9 3h6l1 2h4v2H4V5h4l1-2zm-3 6h12l-1 12H7L6 9zm4 2v8h1v-8H10zm3 0v8h1v-8h-1z"/></svg>';
    del.addEventListener('click', () => {
      pendingTodos = pendingTodos.filter((t) => t.id !== todo.id);
      renderTodoList();
    });
    item.appendChild(del);

    item.addEventListener('dragstart', () => {
      draggingTodoId = todo.id;
      item.classList.add('dragging');
    });
    item.addEventListener('dragend', () => {
      draggingTodoId = null;
      item.classList.remove('dragging');
    });
    item.addEventListener('dragover', (e) => {
      e.preventDefault();
    });
    item.addEventListener('drop', (e) => {
      e.preventDefault();
      if (!draggingTodoId || draggingTodoId === todo.id) return;
      const fromIdx = pendingTodos.findIndex((t) => t.id === draggingTodoId);
      const toIdx = pendingTodos.findIndex((t) => t.id === todo.id);
      const [moved] = pendingTodos.splice(fromIdx, 1);
      pendingTodos.splice(toIdx, 0, moved);
      renderTodoList();
    });

    todoListEl.appendChild(item);
  });
}

function addTodo() {
  const text = todoInput.value.trim();
  if (!text) return;
  pendingTodos.push({ id: crypto.randomUUID(), text, status: 'plan' });
  todoInput.value = '';
  renderTodoList();
  todoInput.focus();
}

todoAddBtn.addEventListener('click', addTodo);
todoInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    addTodo();
  }
});

function renderIssueList() {
  issueListEl.innerHTML = '';
  pendingIssues.forEach((issue) => {
    const solved = issue.status === 'solved';
    const item = document.createElement('div');
    item.className = `todo-item ${solved ? 'issue-solved' : ''}`;
    item.draggable = true;
    item.dataset.id = issue.id;

    const handle = document.createElement('span');
    handle.className = 'todo-drag-handle';
    handle.setAttribute('aria-label', 'Drag to reorder');
    handle.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><circle cx="8" cy="6" r="1.6"/><circle cx="16" cy="6" r="1.6"/><circle cx="8" cy="12" r="1.6"/><circle cx="16" cy="12" r="1.6"/><circle cx="8" cy="18" r="1.6"/><circle cx="16" cy="18" r="1.6"/></svg>';
    item.appendChild(handle);

    const cb = document.createElement('button');
    cb.type = 'button';
    cb.className = `inline-issue-check ${solved ? 'checked' : ''}`;
    cb.style.flexShrink = '0';
    cb.innerHTML = solved
      ? '<svg width="12" height="12" viewBox="0 0 12 12"><polyline points="2,6 5,9 10,3" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      : '';
    cb.title = solved ? 'Mark as problem' : 'Mark as solved';
    cb.addEventListener('click', () => {
      issue.status = solved ? 'problem' : 'solved';
      renderIssueList();
    });
    item.appendChild(cb);

    const text = document.createElement('span');
    text.className = 'todo-text';
    text.contentEditable = 'true';
    text.textContent = issue.text;
    text.addEventListener('blur', () => {
      const newText = text.textContent.trim();
      issue.text = newText || issue.text;
      text.textContent = issue.text;
    });
    text.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        text.blur();
      }
    });
    item.appendChild(text);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'todo-delete';
    del.setAttribute('aria-label', 'Delete issue');
    del.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M9 3h6l1 2h4v2H4V5h4l1-2zm-3 6h12l-1 12H7L6 9zm4 2v8h1v-8H10zm3 0v8h1v-8h-1z"/></svg>';
    del.addEventListener('click', () => {
      pendingIssues = pendingIssues.filter((i) => i.id !== issue.id);
      renderIssueList();
    });
    item.appendChild(del);

    item.addEventListener('dragstart', () => {
      draggingIssueId = issue.id;
      item.classList.add('dragging');
    });
    item.addEventListener('dragend', () => {
      draggingIssueId = null;
      item.classList.remove('dragging');
    });
    item.addEventListener('dragover', (e) => {
      e.preventDefault();
    });
    item.addEventListener('drop', (e) => {
      e.preventDefault();
      if (!draggingIssueId || draggingIssueId === issue.id) return;
      const fromIdx = pendingIssues.findIndex((i) => i.id === draggingIssueId);
      const toIdx = pendingIssues.findIndex((i) => i.id === issue.id);
      const [moved] = pendingIssues.splice(fromIdx, 1);
      pendingIssues.splice(toIdx, 0, moved);
      renderIssueList();
    });

    issueListEl.appendChild(item);
  });
}

function addIssue() {
  const text = issueInput.value.trim();
  if (!text) return;

  pendingIssues.push({ id: crypto.randomUUID(), text, status: 'problem' });
  issueInput.value = '';
  renderIssueList();
  issueInput.focus();
}

issueAddBtn.addEventListener('click', addIssue);
issueInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    addIssue();
  }
});

const cardLinkList = document.getElementById('cardLinkList');
const cardLinkLabel = document.getElementById('cardLinkLabel');
const cardLinkUrl = document.getElementById('cardLinkUrl');
const cardLinkAddBtn = document.getElementById('cardLinkAddBtn');

function renderLinkList() {
  cardLinkList.innerHTML = '';
  pendingLinks.forEach((link) => {
    const row = document.createElement('div');
    row.className = 'link-item';

    const anchor = document.createElement('a');
    anchor.className = 'link-item-anchor';
    anchor.href = link.url;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.textContent = link.label || link.url;
    anchor.title = link.url;
    row.appendChild(anchor);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'link-item-remove';
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', () => {
      pendingLinks = pendingLinks.filter((l) => l.id !== link.id);
      renderLinkList();
    });
    row.appendChild(removeBtn);

    cardLinkList.appendChild(row);
  });
}

function addLink() {
  const url = cardLinkUrl.value.trim();
  if (!url) return;
  const label = cardLinkLabel.value.trim();
  pendingLinks.push({ id: crypto.randomUUID(), label, url });
  cardLinkLabel.value = '';
  cardLinkUrl.value = '';
  renderLinkList();
  cardLinkUrl.focus();
}

cardLinkAddBtn.addEventListener('click', addLink);
cardLinkUrl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); addLink(); }
});

function renderCommentList() {
  commentListEl.innerHTML = '';
  const myName = loadProfile().name;
  pendingComments.forEach((comment) => {
    const isOwner = myName && comment.authorName === myName;

    const item = document.createElement('div');
    item.className = 'comment-item';

    const avatar = document.createElement('span');
    avatar.className = 'profile-avatar-sm comment-avatar';
    renderAvatar(avatar, comment.authorName, comment.authorImage);
    item.appendChild(avatar);

    const body = document.createElement('div');
    body.className = 'comment-body';

    const meta = document.createElement('div');
    meta.className = 'comment-meta';
    const nameEl = document.createElement('span');
    nameEl.className = 'comment-author';
    nameEl.textContent = comment.authorName || 'Unknown';
    const timeEl = document.createElement('span');
    timeEl.className = 'comment-time';
    timeEl.textContent = comment.createdAt ? new Date(comment.createdAt).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' }) : '';
    meta.appendChild(nameEl);
    meta.appendChild(timeEl);

    if (isOwner) {
      const actions = document.createElement('span');
      actions.className = 'comment-actions';

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'comment-action-btn';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', () => startEditComment(comment.id, body, textEl));

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'comment-action-btn comment-action-delete';
      delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', () => {
        pendingComments = pendingComments.filter((c) => c.id !== comment.id);
        renderCommentList();
      });

      actions.appendChild(editBtn);
      actions.appendChild(delBtn);
      meta.appendChild(actions);
    }

    const textEl = document.createElement('p');
    textEl.className = 'comment-text';
    renderCommentText(textEl, comment.text);

    body.appendChild(meta);
    body.appendChild(textEl);
    item.appendChild(body);
    commentListEl.appendChild(item);
  });
  commentListEl.scrollTop = commentListEl.scrollHeight;
}

function startEditComment(id, body, textEl) {
  const comment = pendingComments.find((c) => c.id === id);
  if (!comment) return;

  const editArea = document.createElement('textarea');
  editArea.className = 'comment-edit-area';
  editArea.value = comment.text;

  const btnRow = document.createElement('div');
  btnRow.className = 'comment-edit-btns';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'comment-edit-save';
  saveBtn.textContent = 'Save';
  saveBtn.addEventListener('click', () => {
    const newText = editArea.value.trim();
    if (!newText) return;
    comment.text = newText;
    renderCommentList();
  });

  const cancelBtn2 = document.createElement('button');
  cancelBtn2.type = 'button';
  cancelBtn2.className = 'comment-edit-cancel';
  cancelBtn2.textContent = 'Cancel';
  cancelBtn2.addEventListener('click', () => renderCommentList());

  btnRow.appendChild(saveBtn);
  btnRow.appendChild(cancelBtn2);

  textEl.replaceWith(editArea);
  body.appendChild(btnRow);
  editArea.focus();
  editArea.setSelectionRange(editArea.value.length, editArea.value.length);
}

function addComment() {
  const text = commentInput.value.trim();
  if (!text) return;
  const profile = loadProfile();
  pendingComments.push({
    id: crypto.randomUUID(),
    text,
    authorName: profile.name || 'Anonymous',
    authorImage: profile.imageUrl || null,
    createdAt: new Date().toISOString()
  });
  commentInput.value = '';
  renderCommentList();
  commentInput.focus();
}

function renderCommentText(el, text) {
  el.innerHTML = '';
  text.split(/(@\S+)/g).forEach((part) => {
    if (part.startsWith('@')) {
      const chip = document.createElement('span');
      chip.className = 'mention-chip';
      chip.textContent = part;
      el.appendChild(chip);
    } else {
      el.appendChild(document.createTextNode(part));
    }
  });
}

let teamProfiles = [];

async function fetchTeamProfiles() {
  try {
    const res = await fetch('/api/profiles');
    const data = await res.json();
    if (Array.isArray(data)) teamProfiles = data;
  } catch (e) { /* keep existing teamProfiles */ }
}

fetchTeamProfiles();

(function registerExistingProfile() {
  const profile = loadProfile();
  if (profile.name) {
    fetch('/api/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: profile.name, imageUrl: profile.imageUrl || null })
    });
  }
})();

function getKnownNames() {
  const myName = loadProfile().name;
  return teamProfiles
    .map((p) => p.name)
    .filter((n) => n && n !== myName)
    .sort();
}

const mentionDropdown = document.getElementById('mentionDropdown');
let mentionStart = -1;

function closeMentionDropdown() {
  mentionDropdown.hidden = true;
  mentionDropdown.innerHTML = '';
  mentionStart = -1;
}

function openMentionDropdown(query) {
  const names = getKnownNames().filter((n) => n.toLowerCase().startsWith(query.toLowerCase()));
  if (!names.length) { closeMentionDropdown(); return; }
  mentionDropdown.innerHTML = '';
  names.forEach((name) => {
    const li = document.createElement('li');
    li.className = 'mention-item';
    li.textContent = `@${name}`;
    li.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const val = commentInput.value;
      commentInput.value = val.slice(0, mentionStart) + `@${name} ` + val.slice(commentInput.selectionEnd);
      closeMentionDropdown();
      commentInput.focus();
    });
    mentionDropdown.appendChild(li);
  });
  mentionDropdown.hidden = false;
}

commentInput.addEventListener('input', () => {
  const val = commentInput.value;
  const cursor = commentInput.selectionStart;
  const textBefore = val.slice(0, cursor);
  const match = textBefore.match(/@(\w*)$/);
  if (match) {
    mentionStart = match.index;
    openMentionDropdown(match[1]);
  } else {
    closeMentionDropdown();
  }
});

commentInput.addEventListener('keydown', (e) => {
  if (!mentionDropdown.hidden) {
    const items = mentionDropdown.querySelectorAll('.mention-item');
    const active = mentionDropdown.querySelector('.mention-item.active');
    const idx = active ? [...items].indexOf(active) : -1;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (active) active.classList.remove('active');
      (items[(idx + 1) % items.length] || items[0]).classList.add('active');
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (active) active.classList.remove('active');
      (items[(idx - 1 + items.length) % items.length]).classList.add('active');
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      if (active) { e.preventDefault(); active.dispatchEvent(new MouseEvent('mousedown')); return; }
    }
    if (e.key === 'Escape') { closeMentionDropdown(); return; }
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    addComment();
  }
});

commentInput.addEventListener('blur', () => setTimeout(closeMentionDropdown, 150));

commentAddBtn.addEventListener('click', addComment);

function openDialog(card) {
  editingId = card ? card.id : null;
  dialogTitle.textContent = card ? 'Edit Card' : 'New Idea';
  titleInput.value = card ? card.title : '';
  descInput.value = card ? card.description : '';
  deleteBtn.hidden = !card;
  tagLabel.hidden = !(card && (card.column === 'clip' || card.column === 'youtube'));
  const cardTags = (card && card.tags) || [];
  tagCheckboxes.forEach((cb) => { cb.checked = cardTags.includes(cb.value); });
  ideaTagLabel.hidden = card ? card.column !== 'idea' : false;
  ideaTagCheckboxes.forEach((cb) => { cb.checked = cardTags.includes(cb.value); });
  platformLabel.hidden = !(card && card.column === 'published');
  const cardPlatforms = (card && card.platforms) || [];
  platformCheckboxes.forEach((cb) => { cb.checked = cardPlatforms.includes(cb.value); });
  todoLabel.hidden = !(card && (card.column === 'clip' || card.column === 'youtube'));
  pendingTodos = ((card && card.todos) || []).map((t) => ({ ...t }));
  todoInput.value = '';
  renderTodoList();
  issueLabel.hidden = !(card && (card.column === 'clip' || card.column === 'youtube'));
  pendingIssues = ((card && card.issues) || []).map((i) => ({ ...i }));
  issueInput.value = '';
  renderIssueList();
  commentLabel.hidden = !card;
  dialog.classList.toggle('is-editing', !!card);
  pendingLinks = ((card && card.links) || []).map((l) => ({ ...l }));
  cardLinkLabel.value = '';
  cardLinkUrl.value = '';
  renderLinkList();
  pendingComments = ((card && card.comments) || []).map((c) => ({ ...c }));
  commentInput.value = '';
  const profile = loadProfile();
  renderAvatar(commentAuthorAvatar, profile.name, profile.imageUrl);
  renderCommentList();
  cardImageInput.value = '';
  pendingImageDataUrl = null;
  removeImageRequested = false;
  setImagePreview(card && card.imageUrl);
  dialog.showModal();
  titleInput.focus();
}

const backToReportBtn = document.getElementById('backToReportBtn');

addBtn.addEventListener('click', () => openDialog(null));
cancelBtn.addEventListener('click', () => dialog.close());
dialog.addEventListener('close', () => { backToReportBtn.hidden = true; });

cardImageInput.addEventListener('change', () => {
  const file = cardImageInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    pendingImageDataUrl = reader.result;
    removeImageRequested = false;
    setImagePreview(pendingImageDataUrl);
  };
  reader.readAsDataURL(file);
});

cardImageRemoveBtn.addEventListener('click', () => {
  pendingImageDataUrl = null;
  removeImageRequested = true;
  cardImageInput.value = '';
  setImagePreview(null);
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = { title: titleInput.value, description: descInput.value };
  if (!tagLabel.hidden) {
    payload.tags = tagCheckboxes.filter((cb) => cb.checked).map((cb) => cb.value);
  }
  if (!ideaTagLabel.hidden) {
    payload.tags = ideaTagCheckboxes.filter((cb) => cb.checked).map((cb) => cb.value);
  }
  if (!platformLabel.hidden) {
    payload.platforms = platformCheckboxes.filter((cb) => cb.checked).map((cb) => cb.value);
  }
  if (!todoLabel.hidden) {
    payload.todos = pendingTodos;
  }
  if (!issueLabel.hidden) {
    payload.issues = pendingIssues;
  }
  if (!commentLabel.hidden) {
    payload.comments = pendingComments;
  }
  payload.links = pendingLinks;
  let cardId = editingId;
  if (editingId) {
    await fetch(`/api/cards/${editingId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } else {
    payload.column = 'idea';
    const created = await fetch('/api/cards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then((r) => r.json());
    cardId = created.id;
  }
  if (pendingImageDataUrl) {
    await fetch(`/api/cards/${cardId}/image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: pendingImageDataUrl })
    });
  } else if (removeImageRequested) {
    await fetch(`/api/cards/${cardId}/image`, { method: 'DELETE' });
  }
  dialog.close();
  lastSignature = null;
  fetchCards();
});

deleteBtn.addEventListener('click', async () => {
  if (!editingId) return;
  if (!confirm('Delete this card?')) return;
  await fetch(`/api/cards/${editingId}`, { method: 'DELETE' });
  dialog.close();
  lastSignature = null;
  fetchCards();
});

function openRejectDialog(id) {
  rejectingId = id;
  rejectReasonInput.value = '';
  rejectDialog.showModal();
  rejectReasonInput.focus();
}

rejectCancelBtn.addEventListener('click', () => rejectDialog.close());

rejectForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!rejectingId) return;
  await fetch(`/api/cards/${rejectingId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'rejected', rejectionReason: rejectReasonInput.value })
  });
  rejectingId = null;
  rejectDialog.close();
  lastSignature = null;
  fetchCards();
});

rejectedToggle.addEventListener('click', () => {
  rejectedList.hidden = !rejectedList.hidden;
});

async function fetchCardsAndOpenParam() {
  const res = await fetch('/api/cards');
  const data = await res.json();
  const sig = signature(data);
  if (sig !== lastSignature) {
    checkNewComments(data.cards);
    lastSignature = sig;
    render(data.cards);
  }
  const paramId = new URLSearchParams(window.location.search).get('card');
  if (paramId) {
    const target = data.cards.find((c) => c.id === paramId);
    if (target) {
      openDialog(target);
      document.getElementById('backToReportBtn').hidden = false;
    }
    window.history.replaceState({}, '', '/index.html');
  }
}

fetchCardsAndOpenParam();
setInterval(fetchCards, POLL_INTERVAL_MS);

const keyMessagesList = document.getElementById('keyMessagesList');
const addKeyMessageBtn = document.getElementById('addKeyMessageBtn');
let draggingMessageId = null;
let keyMessagesSignature = null;

async function fetchKeyMessages() {
  const res = await fetch('/api/key-messages');
  const data = await res.json();
  const sig = JSON.stringify(data.messages.map((m) => [m.id, m.text]));
  if (sig !== keyMessagesSignature) {
    keyMessagesSignature = sig;
    renderKeyMessages(data.messages);
  }
}

function renderKeyMessages(messages) {
  keyMessagesList.innerHTML = '';
  messages.forEach((msg, index) => {
    const item = document.createElement('div');
    item.className = 'key-message-item';
    item.draggable = true;
    item.dataset.id = msg.id;

    const rank = document.createElement('span');
    rank.className = 'key-message-rank';
    rank.textContent = index + 1;
    item.appendChild(rank);

    const text = document.createElement('div');
    text.className = 'key-message-text';
    text.contentEditable = 'true';
    text.textContent = msg.text;
    text.addEventListener('blur', async () => {
      const newText = text.textContent.trim();
      if (!newText || newText === msg.text) {
        text.textContent = msg.text;
        return;
      }
      await fetch(`/api/key-messages/${msg.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: newText })
      });
      keyMessagesSignature = null;
      fetchKeyMessages();
    });
    text.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        text.blur();
      }
    });
    item.appendChild(text);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'key-message-delete';
    del.title = 'Delete key message';
    del.setAttribute('aria-label', 'Delete key message');
    del.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M9 3h6l1 2h4v2H4V5h4l1-2zm-3 6h12l-1 12H7L6 9zm4 2v8h1v-8H10zm3 0v8h1v-8h-1z"/></svg>';
    del.addEventListener('click', async () => {
      if (!confirm('Delete this key message?')) return;
      await fetch(`/api/key-messages/${msg.id}`, { method: 'DELETE' });
      keyMessagesSignature = null;
      fetchKeyMessages();
    });
    item.appendChild(del);

    item.addEventListener('dragstart', () => {
      draggingMessageId = msg.id;
      item.classList.add('dragging');
    });
    item.addEventListener('dragend', () => {
      draggingMessageId = null;
      item.classList.remove('dragging');
    });
    item.addEventListener('dragover', (e) => {
      e.preventDefault();
    });
    item.addEventListener('drop', async (e) => {
      e.preventDefault();
      if (!draggingMessageId || draggingMessageId === msg.id) return;
      const ids = Array.from(keyMessagesList.children).map((el) => el.dataset.id);
      const fromIdx = ids.indexOf(draggingMessageId);
      const toIdx = ids.indexOf(msg.id);
      ids.splice(fromIdx, 1);
      ids.splice(toIdx, 0, draggingMessageId);
      await fetch('/api/key-messages/reorder', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order: ids })
      });
      keyMessagesSignature = null;
      fetchKeyMessages();
    });

    keyMessagesList.appendChild(item);
  });
}

addKeyMessageBtn.addEventListener('click', async () => {
  const text = prompt('New key message:');
  if (!text || !text.trim()) return;
  await fetch('/api/key-messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: text.trim() })
  });
  keyMessagesSignature = null;
  fetchKeyMessages();
});

fetchKeyMessages();
setInterval(fetchKeyMessages, POLL_INTERVAL_MS);

const websiteChangelogList = document.getElementById('websiteChangelogList');
const websiteChangelogLink = document.getElementById('websiteChangelogLink');
let websiteChangelogSignature = null;

async function fetchWebsiteChangelog() {
  const res = await fetch('/api/website-changelog');
  const data = await res.json();
  const sig = JSON.stringify(data.entries);
  if (sig !== websiteChangelogSignature) {
    websiteChangelogSignature = sig;
    if (data.siteUrl) {
      websiteChangelogLink.href = data.siteUrl;
      websiteChangelogLink.textContent = data.siteUrl.replace(/^https?:\/\//, '');
    }
    renderWebsiteChangelog(data.entries);
  }
}

function renderChangelogEntries(container, entries) {
  container.innerHTML = '';
  if (!entries.length) {
    container.innerHTML = '<p class="empty-state">No updates logged yet.</p>';
    return;
  }
  [...entries].sort((a, b) => new Date(b.date) - new Date(a.date)).forEach((entry) => {
    const item = document.createElement('div');
    item.className = 'changelog-entry';
    const date = document.createElement('p');
    date.className = 'changelog-date';
    date.textContent = entry.date;
    item.appendChild(date);
    const feature = document.createElement('p');
    feature.className = 'changelog-feature';
    feature.textContent = entry.feature;
    item.appendChild(feature);
    container.appendChild(item);
  });
}

function renderWebsiteChangelog(entries) {
  renderChangelogEntries(websiteChangelogList, entries);
}

fetchWebsiteChangelog();
setInterval(fetchWebsiteChangelog, POLL_INTERVAL_MS);

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
setInterval(fetchMarketingChangelog, POLL_INTERVAL_MS);

const marketingChangelogRefreshBtn = document.getElementById('marketingChangelogRefreshBtn');
marketingChangelogRefreshBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  spinRefreshBtn(marketingChangelogRefreshBtn);
  marketingChangelogSignature = null;
  fetchMarketingChangelog();
});

const summaryBtn = document.getElementById('summaryBtn');
const summaryDialog = document.getElementById('summaryDialog');
const summaryForm = document.getElementById('summaryForm');
const summaryText = document.getElementById('summaryText');
const summaryCloseBtn = document.getElementById('summaryCloseBtn');

const THAI_MONTHS = ['มกราคม','กุมภาพันธ์','มีนาคม','เมษายน','พฤษภาคม','มิถุนายน','กรกฎาคม','สิงหาคม','กันยายน','ตุลาคม','พฤศจิกายน','ธันวาคม'];

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function isToday(iso) {
  if (!iso) return false;
  return iso.slice(0, 10) === todayKey();
}

function thaiDateToday() {
  const d = new Date();
  return `${d.getDate()} ${THAI_MONTHS[d.getMonth()]} ${d.getFullYear() + 543}`;
}

async function buildSummary() {
  const [cardsRes, changelogRes, marketingChangelogRes] = await Promise.all([
    fetch('/api/cards').then((r) => r.json()),
    fetch('/api/website-changelog').then((r) => r.json()),
    fetch('/api/marketing-changelog').then((r) => r.json())
  ]);

  const cards = cardsRes.cards;
  const newIdeas = cards.filter((c) => c.column === 'idea' && c.status !== 'rejected' && isToday(c.createdAt));
  const publishedToday = cards.filter((c) => c.column === 'published' && isToday(c.publishedAt));
  const movedToClip = cards.filter((c) => (c.column === 'clip' || c.column === 'youtube') && isToday(c.updatedAt));
  const rejectedToday = cards.filter((c) => c.status === 'rejected' && isToday(c.updatedAt));
  const websiteUpdatesToday = (changelogRes.entries || []).filter((e) => e.date === todayKey());
  const marketingUpdatesToday = (marketingChangelogRes.entries || []).filter((e) => e.date === todayKey());

  const activeClips = cards.filter((c) => (c.column === 'clip' || c.column === 'youtube') && c.status !== 'rejected');
  const clipsWithTodos = activeClips.filter((c) => Array.isArray(c.todos) && c.todos.length);
  const clipsWithIssues = activeClips.filter((c) => Array.isArray(c.issues) && c.issues.length);

  const lines = [];
  lines.push(`📅 สรุปงานวันนี้ — ${thaiDateToday()}`);
  lines.push('');

  if (publishedToday.length) {
    lines.push(`✅ ลงคอนเทนต์เสร็จแล้ววันนี้ (${publishedToday.length})`);
    publishedToday.forEach((c) => lines.push(`- ${c.title}`));
    lines.push('');
  }
  if (movedToClip.length) {
    lines.push(`🎬 เริ่มทำคลิปวันนี้ (${movedToClip.length})`);
    movedToClip.forEach((c) => lines.push(`- ${c.title}`));
    lines.push('');
  }
  if (clipsWithTodos.length) {
    lines.push(`🎬 ความคืบหน้าคลิปที่กำลังทำอยู่ (${clipsWithTodos.length})`);
    clipsWithTodos.forEach((c) => {
      const total = c.todos.length;
      const done = c.todos.filter((t) => t.status === 'done').length;
      const statusText = done === total ? 'ทำเสร็จหมดแล้ว รอตรวจ' : `ทำไปแล้ว ${done} จาก ${total} เรื่อง`;
      lines.push(`- ${c.title} (${statusText})`);
    });
    lines.push('');
  }
  if (clipsWithIssues.length) {
    lines.push(`🆘 มีเรื่องต้องขอความช่วยเหลือ (${clipsWithIssues.length} คลิป)`);
    clipsWithIssues.forEach((c) => {
      lines.push(`- ${c.title}:`);
      c.issues.forEach((i) => lines.push(`   • ${i.text}`));
    });
    lines.push('');
  }
  if (newIdeas.length) {
    lines.push(`💡 ไอเดียใหม่วันนี้ (${newIdeas.length})`);
    newIdeas.forEach((c) => lines.push(`- ${c.title}`));
    lines.push('');
  }
  if (rejectedToday.length) {
    lines.push(`🗑 ไอเดียที่ตีกลับวันนี้ (${rejectedToday.length})`);
    rejectedToday.forEach((c) => lines.push(`- ${c.title} (เหตุผล: ${c.rejectionReason})`));
    lines.push('');
  }
  if (websiteUpdatesToday.length) {
    lines.push(`🌐 อัปเดตเว็บไซต์วันนี้ (${websiteUpdatesToday.length})`);
    websiteUpdatesToday.forEach((e) => lines.push(`- ${e.feature}`));
    lines.push('');
  }
  if (marketingUpdatesToday.length) {
    lines.push(`🛠 ปรับปรุงเครื่องมือทำงานวันนี้ (${marketingUpdatesToday.length})`);
    marketingUpdatesToday.forEach((e) => lines.push(`- ${e.feature}`));
    lines.push('');
  }

  if (lines.length === 2) {
    lines.push('วันนี้ยังไม่มีความเคลื่อนไหว');
  }

  return lines.join('\n').trim();
}

summaryBtn.addEventListener('click', async () => {
  summaryText.value = 'กำลังสรุป...';
  summaryDialog.showModal();
  summaryText.value = await buildSummary();
});

summaryCloseBtn.addEventListener('click', () => summaryDialog.close());

summaryForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await navigator.clipboard.writeText(summaryText.value);
  } catch {
    summaryText.select();
    document.execCommand('copy');
  }
  const submitBtn = summaryForm.querySelector('button[type="submit"]');
  const original = submitBtn.textContent;
  submitBtn.textContent = '✅ Copied!';
  setTimeout(() => { submitBtn.textContent = original; }, 1500);
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
