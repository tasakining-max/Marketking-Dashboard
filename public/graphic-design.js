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

const USAGE_LABELS = {
  website: '🌐 เว็บไซต์',
  facebook_ads: '📘 Facebook Ads',
  instagram_ads: '📸 Instagram Ads',
  other: '📦 อื่นๆ',
};

async function fetchOrThrow(url, opts) {
  let res;
  try {
    res = await fetch(url, opts);
  } catch (e) {
    throw new Error('Network error — check your connection and try again.');
  }
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const data = await res.json();
      if (data && data.error) message = data.error;
    } catch (e) { /* not JSON */ }
    throw new Error(message);
  }
  return res;
}

const board = document.getElementById('board');
const dialog = document.getElementById('cardDialog');
const form = document.getElementById('cardForm');
const dialogTitle = document.getElementById('dialogTitle');
const titleInput = document.getElementById('cardTitle');
const descInput = document.getElementById('cardDescription');
const cardImageInput = document.getElementById('cardImageInput');
const cardImagePreviewWrap = document.getElementById('cardImagePreviewWrap');
const cardImagePreview = document.getElementById('cardImagePreview');
const cardImageRemoveBtn = document.getElementById('cardImageRemoveBtn');
const usageCheckboxes = Array.from(document.querySelectorAll('input[name="cardUsage"]'));
const cardFormError = document.getElementById('cardFormError');
const addBtn = document.getElementById('addBtn');
const cancelBtn = document.getElementById('cancelBtn');
const deleteBtn = document.getElementById('deleteBtn');
const cardSaveBtn = document.getElementById('cardSaveBtn');
const cardSaveBtnLabel = document.getElementById('cardSaveBtnLabel');
const cardSaveBtnSpinner = cardSaveBtn.querySelector('.btn-spinner');
const lightboxDialog = document.getElementById('lightboxDialog');
const lightboxImage = document.getElementById('lightboxImage');
const cardCommentLabel = document.getElementById('cardCommentLabel');
const cardCommentList = document.getElementById('cardCommentList');
const cardCommentInput = document.getElementById('cardCommentInput');
const cardCommentAddBtn = document.getElementById('cardCommentAddBtn');

let editingId = null;
let pendingImageDataUrl = null;
let removeImageRequested = false;
let draggingId = null;
let lastSignature = null;
let currentComments = [];

function getMyName() {
  try {
    const profile = JSON.parse(localStorage.getItem('dashboard_profile'));
    if (profile && profile.name) return profile.name;
  } catch (e) { /* ignore */ }
  return null;
}

function renderComments() {
  cardCommentList.innerHTML = '';
  const myName = getMyName();
  currentComments.forEach((c) => {
    const item = document.createElement('div');
    item.className = 'comment-item';

    const body = document.createElement('div');
    body.className = 'comment-body';

    const meta = document.createElement('div');
    meta.className = 'comment-meta';
    const author = document.createElement('span');
    author.className = 'comment-author';
    author.textContent = c.authorName || 'Unknown';
    meta.appendChild(author);
    const time = document.createElement('span');
    time.className = 'comment-time';
    time.textContent = c.createdAt ? new Date(c.createdAt).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' }) : '';
    meta.appendChild(time);

    if (myName && c.authorName === myName) {
      const actions = document.createElement('span');
      actions.className = 'comment-actions';
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'comment-action-btn comment-action-delete';
      del.textContent = 'Delete';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        await fetch(`/api/graphic-cards/${editingId}/comments/${c.id}`, { method: 'DELETE' });
        currentComments = currentComments.filter((x) => x.id !== c.id);
        renderComments();
        lastSignature = null;
      });
      actions.appendChild(del);
      meta.appendChild(actions);
    }

    body.appendChild(meta);

    const text = document.createElement('p');
    text.className = 'comment-text';
    text.textContent = c.text;
    body.appendChild(text);

    item.appendChild(body);
    cardCommentList.appendChild(item);
  });
  cardCommentList.scrollTop = cardCommentList.scrollHeight;
}

cardCommentAddBtn.addEventListener('click', async () => {
  const text = cardCommentInput.value.trim();
  if (!text || !editingId) return;
  let authorName = getMyName();
  if (!authorName) {
    authorName = prompt('ชื่อของคุณ (สำหรับแสดงในคอมเมนต์)');
    if (!authorName || !authorName.trim()) return;
    authorName = authorName.trim();
    try { localStorage.setItem('dashboard_profile', JSON.stringify({ ...(JSON.parse(localStorage.getItem('dashboard_profile') || '{}')), name: authorName })); } catch (e) { /* ignore */ }
  }
  cardCommentAddBtn.disabled = true;
  try {
    const updated = await fetchOrThrow(`/api/graphic-cards/${editingId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, authorName }),
    }).then((r) => r.json());
    currentComments = Array.isArray(updated.comments) ? updated.comments : [];
    cardCommentInput.value = '';
    renderComments();
    lastSignature = null;
  } catch (err) {
    alert(err.message || 'Could not post comment. Please try again.');
  } finally {
    cardCommentAddBtn.disabled = false;
  }
});

cardCommentInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    cardCommentAddBtn.click();
  }
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

function openDialog(card) {
  editingId = card ? card.id : null;
  dialogTitle.textContent = card ? 'Edit Design' : 'New Design';
  titleInput.value = card ? card.title : '';
  descInput.value = card ? card.description : '';
  usageCheckboxes.forEach((cb) => { cb.checked = Boolean(card && card.usage && card.usage.includes(cb.value)); });
  pendingImageDataUrl = null;
  removeImageRequested = false;
  cardImageInput.value = '';
  setImagePreview(card ? card.imageUrl : null);
  deleteBtn.hidden = !card;
  cardFormError.hidden = true;
  currentComments = card && Array.isArray(card.comments) ? card.comments : [];
  cardCommentLabel.hidden = !card;
  cardCommentInput.value = '';
  if (card) renderComments();
  dialog.classList.toggle('is-editing', !!card);
  dialog.showModal();
}

addBtn.addEventListener('click', () => openDialog(null));
cancelBtn.addEventListener('click', () => dialog.close());

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

function setSaveLoading(isLoading) {
  cardSaveBtn.disabled = isLoading;
  cardSaveBtnSpinner.hidden = !isLoading;
  cardSaveBtnLabel.textContent = isLoading ? 'Saving…' : 'Save';
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  cardFormError.hidden = true;
  setSaveLoading(true);
  try {
    const payload = {
      title: titleInput.value,
      description: descInput.value,
      usage: usageCheckboxes.filter((cb) => cb.checked).map((cb) => cb.value),
    };
    let cardId = editingId;
    if (editingId) {
      await fetchOrThrow(`/api/graphic-cards/${editingId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } else {
      payload.column = 'todo';
      const created = await fetchOrThrow('/api/graphic-cards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).then((r) => r.json());
      cardId = created.id;
    }
    if (pendingImageDataUrl) {
      await fetchOrThrow(`/api/graphic-cards/${cardId}/image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: pendingImageDataUrl }),
      });
    } else if (removeImageRequested) {
      await fetchOrThrow(`/api/graphic-cards/${cardId}/image`, { method: 'DELETE' });
    }
    dialog.close();
    lastSignature = null;
    fetchCards();
  } catch (err) {
    cardFormError.textContent = err.message || 'Could not save. Please try again.';
    cardFormError.hidden = false;
  } finally {
    setSaveLoading(false);
  }
});

deleteBtn.addEventListener('click', async () => {
  if (!editingId) return;
  if (!confirm('Delete this design?')) return;
  await fetch(`/api/graphic-cards/${editingId}`, { method: 'DELETE' });
  dialog.close();
  lastSignature = null;
  fetchCards();
});

function openLightbox(src) {
  lightboxImage.src = src;
  lightboxDialog.showModal();
}
lightboxDialog.addEventListener('click', () => lightboxDialog.close());
cardImagePreview.addEventListener('click', () => {
  if (cardImagePreview.src) openLightbox(cardImagePreview.src);
});

function renderCard(card) {
  const el = document.createElement('div');
  el.className = 'card';
  el.draggable = true;
  el.dataset.id = card.id;

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

  if (card.description) {
    const desc = document.createElement('p');
    desc.className = 'desc';
    desc.textContent = card.description;
    el.appendChild(desc);
  }

  if (Array.isArray(card.usage) && card.usage.length) {
    const tagRow = document.createElement('div');
    tagRow.className = 'tag-row';
    card.usage
      .filter((u) => USAGE_LABELS[u])
      .forEach((u) => {
        const badge = document.createElement('span');
        badge.className = 'tag-badge';
        badge.textContent = USAGE_LABELS[u];
        tagRow.appendChild(badge);
      });
    el.appendChild(tagRow);
  }

  el.addEventListener('click', () => openDialog(card));

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
    try {
      await reorderCards(column, ids);
    } catch (err) {
      alert(err.message || 'Could not move the card. Please try again.');
    }
  });

  return el;
}

async function reorderCards(column, ids) {
  await fetchOrThrow('/api/graphic-cards/reorder', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ column, order: ids }),
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
    try {
      await moveCard(draggingId, newColumn);
    } catch (err) {
      alert(err.message || 'Could not move the card. Please try again.');
    }
  });
});

async function fetchCards() {
  let data;
  try {
    const res = await fetch('/api/graphic-cards');
    data = await res.json();
  } catch (e) {
    return;
  }
  const cards = data.cards || [];
  const signature = JSON.stringify(cards.map((c) => [c.id, c.column, c.updatedAt]));
  if (signature === lastSignature) return;
  lastSignature = signature;

  board.querySelectorAll('.cards').forEach((c) => { c.innerHTML = ''; });
  cards.forEach((card) => {
    const container = board.querySelector(`[data-column-cards="${card.column}"]`);
    if (container) container.appendChild(renderCard(card));
  });
}

fetchCards();
setInterval(fetchCards, 4000);
