// Who has which dashboard page open, and when. Writing is open to every device
// that has picked a profile; reading needs TRACKER_KEY, which only NUNGNING
// holds, so it stays private even when the dashboard is reached through the
// web server. Without TRACKER_KEY set, reading is switched off entirely.
import crypto from 'crypto';

const HISTORY_KEY = '__tab_history';
const HISTORY_MAX = 400;
const ONLINE_MS = 90 * 1000;

const digest = (v) => crypto.createHash('sha256').update(String(v)).digest();
function allowed(req) {
  const key = process.env.TRACKER_KEY;
  if (!key) return false;
  const given = req.get('x-tracker-key');
  return Boolean(given) && crypto.timingSafeEqual(digest(given), digest(key));
}

export function registerTabTracker(app, { prisma }) {
  // kind "view" = page opened (also logged to history); "beat" = still open.
  app.post('/api/tab-views', async (req, res) => {
    const profileName = String(req.body?.profileName || '').slice(0, 60);
    const page = String(req.body?.page || '').slice(0, 80);
    if (!profileName || !page) return res.status(400).json({ error: 'profileName and page are required' });
    try {
      await prisma.tabView.upsert({
        where: { profileName_page: { profileName, page } },
        update: { viewedAt: new Date() },
        create: { profileName, page },
      });
      if (req.body?.kind === 'view') {
        const row = await prisma.agentSetting.findUnique({ where: { agent: HISTORY_KEY } });
        let history = [];
        try { history = JSON.parse(row?.rules || '[]'); } catch { /* start over */ }
        history.push([new Date().toISOString(), profileName, page]);
        const rules = JSON.stringify(history.slice(-HISTORY_MAX));
        await prisma.agentSetting.upsert({ where: { agent: HISTORY_KEY }, create: { agent: HISTORY_KEY, rules }, update: { rules } });
      }
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // A wrong or missing key looks like any unknown URL.
  app.get('/api/tab-activity', async (req, res) => {
    if (!allowed(req)) return res.status(404).json({ error: 'Not found' });
    try {
      const [rows, hist] = await Promise.all([
        prisma.tabView.findMany({ orderBy: { viewedAt: 'desc' } }),
        prisma.agentSetting.findUnique({ where: { agent: HISTORY_KEY } }),
      ]);
      let history = [];
      try { history = JSON.parse(hist?.rules || '[]'); } catch { /* none */ }
      const now = Date.now();
      res.json({
        now: rows.filter((r) => now - new Date(r.viewedAt).getTime() <= ONLINE_MS),
        last: rows,
        history: history.slice().reverse().map(([at, profileName, page]) => ({ at, profileName, page })),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}
