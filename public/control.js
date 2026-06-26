const POLL_INTERVAL_MS = 3000;

const gatewayStatus = document.getElementById('gatewayStatus');
const lastRestart = document.getElementById('lastRestart');
const lastActivity = document.getElementById('lastActivity');
const botList = document.getElementById('botList');
const cronList = document.getElementById('cronList');
const activityFeed = document.getElementById('activityFeed');
const clearBtn = document.getElementById('clearBtn');
const logBtn = document.getElementById('logBtn');
const logDialog = document.getElementById('logDialog');
const logForm = document.getElementById('logForm');
const logMessage = document.getElementById('logMessage');
const logType = document.getElementById('logType');
const logCancelBtn = document.getElementById('logCancelBtn');

const BOT_AVATARS = {
  'Takujung': '/agent-assets/takujung.PNG',
  'Main agent': '/agent-assets/MainAgent.png',
  'Video Creator': '/agent-assets/VDOCreator.png'
};

let lastSignature = null;

function timeAgo(iso) {
  if (!iso) return 'never';
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function signature(data) {
  return JSON.stringify(data);
}

async function fetchStatus() {
  const res = await fetch('/api/status');
  const data = await res.json();
  const sig = signature(data);
  if (sig !== lastSignature) {
    lastSignature = sig;
    render(data);
  } else {
    lastRestart.textContent = data.lastRestart ? `${data.lastRestart}` : 'unknown';
  }
}

function render(data) {
  gatewayStatus.innerHTML = data.gatewayRunning
    ? '<span class="dot dot-green"></span> Online'
    : '<span class="dot dot-red"></span> Offline';

  lastRestart.textContent = data.lastRestart || 'unknown';

  lastActivity.textContent = data.activity.length ? timeAgo(data.activity[0].createdAt) : 'no activity yet';

  botList.innerHTML = '';
  if (!data.bots || !data.bots.length) {
    botList.innerHTML = '<p class="empty-state">No bots configured.</p>';
  } else {
    data.bots.forEach((bot) => {
      const item = document.createElement('div');
      item.className = 'bot-card';
      const avatar = BOT_AVATARS[bot.name];
      const onlineClass = bot.online ? 'online' : 'offline';
      item.innerHTML = `
        <div class="bot-avatar-wrap ${onlineClass}">
          ${avatar ? `<img class="bot-avatar" src="${avatar}" alt="${escapeHtml(bot.name)}" />` : '<div class="bot-avatar"></div>'}
          <span class="ring-dot ${bot.online ? 'dot-green' : 'dot-red'}"></span>
        </div>
        <div class="bot-info">
          <span class="bot-name">${escapeHtml(bot.name)}</span>
          ${bot.role ? `<span class="bot-role">${escapeHtml(bot.role)}</span>` : ''}
          <span class="bot-status-line ${onlineClass}">${bot.online ? '● ONLINE' : '● OFFLINE'}</span>
          <span class="bot-model" title="${bot.modelIsLive ? 'Model used in the most recent session' : 'Configured default model (no session activity yet)'}">
            ${bot.model ? escapeHtml(bot.model) : 'unknown'}${bot.modelIsLive ? '' : ' (default)'}
          </span>
          <span class="bot-guilds">${bot.guildCount} GUILD${bot.guildCount === 1 ? '' : 'S'}</span>
        </div>
      `;
      botList.appendChild(item);
    });
  }

  cronList.innerHTML = '';
  if (!data.cronJobs.length) {
    cronList.innerHTML = '<p class="empty-state">No scheduled jobs.</p>';
  } else {
    data.cronJobs.forEach((job) => {
      const item = document.createElement('div');
      item.className = 'cron-item';
      item.innerHTML = `<span class="cron-schedule">${escapeHtml(job.schedule || '')}</span><span class="cron-label">${escapeHtml(job.label || '')}</span>`;
      cronList.appendChild(item);
    });
  }

  activityFeed.innerHTML = '';
  if (!data.activity.length) {
    activityFeed.innerHTML = '<p class="empty-state">No activity logged yet.</p>';
  } else {
    data.activity.forEach((entry) => {
      const item = document.createElement('div');
      item.className = `activity-item activity-${entry.type}`;
      const msg = document.createElement('p');
      msg.className = 'activity-msg';
      msg.textContent = entry.message;
      const meta = document.createElement('p');
      meta.className = 'activity-meta';
      meta.textContent = timeAgo(entry.createdAt);
      item.appendChild(msg);
      item.appendChild(meta);
      activityFeed.appendChild(item);
    });
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

clearBtn.addEventListener('click', async () => {
  if (!confirm('Clear the entire activity log?')) return;
  await fetch('/api/activity', { method: 'DELETE' });
  lastSignature = null;
  fetchStatus();
});

logBtn.addEventListener('click', () => {
  logMessage.value = '';
  logType.value = 'info';
  logDialog.showModal();
  logMessage.focus();
});

logCancelBtn.addEventListener('click', () => logDialog.close());

logForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  await fetch('/api/activity', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: logMessage.value, type: logType.value })
  });
  logDialog.close();
  lastSignature = null;
  fetchStatus();
});

fetchStatus();
setInterval(fetchStatus, POLL_INTERVAL_MS);
