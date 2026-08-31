import 'dotenv/config';

// Facebook doesn't expose an organic-vs-paid split on a Reel's own insights
// (checked: /video_insights has no such metric for Reels). But when an ad's
// creative IS one of our existing organic videos (a boosted post), the ad's
// own video_play_actions figure is exactly the ad-attributed view count —
// PageVideoInsight.views (total) minus this is the organic portion. Only
// videos currently being promoted get a non-zero adViews; everything else
// stays fully organic (adViews left at 0).

const PORT = process.env.PORT || 5050;
const PAGE_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN;
const AD_ACCOUNT_ID = process.env.FB_AD_ACCOUNT_ID;
const USER_TOKEN = process.env.FB_USER_ACCESS_TOKEN;
const GRAPH_VERSION = 'v26.0';

if (!AD_ACCOUNT_ID || !USER_TOKEN || !PAGE_TOKEN) {
  console.error('Missing FB_AD_ACCOUNT_ID, FB_USER_ACCESS_TOKEN, or FB_PAGE_ACCESS_TOKEN in .env');
  process.exit(1);
}

async function fetchAdVideoIds() {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${AD_ACCOUNT_ID}/ads?fields=name,creative{video_id}&access_token=${PAGE_TOKEN}`;
  const json = await fetch(url).then((r) => r.json());
  if (json.error) throw new Error(`Graph API error (ads): ${json.error.message}`);
  const map = new Map(); // adId -> videoId
  for (const ad of json.data || []) {
    if (ad.creative?.video_id) map.set(ad.id, ad.creative.video_id);
  }
  return map;
}

async function fetchAdVideoViews() {
  const timeRange = encodeURIComponent(JSON.stringify({ since: '2024-01-01', until: new Date().toISOString().slice(0, 10) }));
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${AD_ACCOUNT_ID}/insights?level=ad&time_range=${timeRange}&fields=ad_id,video_play_actions&access_token=${USER_TOKEN}`;
  const json = await fetch(url).then((r) => r.json());
  if (json.error) throw new Error(`Graph API error (insights): ${json.error.message}`);
  const map = new Map(); // adId -> views
  for (const row of json.data || []) {
    const viewAction = (row.video_play_actions || []).find((a) => a.action_type === 'video_view');
    if (viewAction) map.set(row.ad_id, Number(viewAction.value) || 0);
  }
  return map;
}

const [adVideoIds, adVideoViews] = await Promise.all([fetchAdVideoIds(), fetchAdVideoViews()]);

let updated = 0;
for (const [adId, videoId] of adVideoIds) {
  const adViews = adVideoViews.get(adId) || 0;
  const res = await fetch(`http://localhost:${PORT}/api/page-video-insights/${videoId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ adViews }),
  });
  if (res.ok) {
    console.log(`videoId=${videoId} <- adViews=${adViews} (ad_id=${adId})`);
    updated++;
  } else {
    console.log(`SKIP videoId=${videoId} — no matching PageVideoInsight row (not synced yet?)`);
  }
}

console.log(`\nDone. Updated ${updated} video(s) with ad-attributed view counts.`);
