import 'dotenv/config';

const PORT = process.env.PORT || 5050;
const PAGE_ID = process.env.FB_PAGE_ID;
const ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN;
const GRAPH_VERSION = 'v26.0';

if (!PAGE_ID || !ACCESS_TOKEN) {
  console.error('Missing FB_PAGE_ID or FB_PAGE_ACCESS_TOKEN in .env');
  process.exit(1);
}

function monthsAgo(n) {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return Math.floor(d.getTime() / 1000);
}

async function fetchVideos(sinceUnix) {
  const fields = 'id,description,created_time,length,permalink_url,views,post_views,likes.summary(true).limit(0),comments.summary(true).limit(0)';
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${PAGE_ID}/videos?fields=${fields}&since=${sinceUnix}&limit=100&access_token=${ACCESS_TOKEN}`;
  const res = await fetch(url);
  const json = await res.json();
  if (json.error) throw new Error(`Graph API error: ${json.error.message}`);
  return json.data || [];
}

// Reels don't carry a `shares` field on the video object itself — it only
// shows up on the companion Page-Post object, addressed as {page_id}_{video_id}.
async function fetchShares(videoId) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${PAGE_ID}_${videoId}?fields=shares&access_token=${ACCESS_TOKEN}`;
  const res = await fetch(url);
  const json = await res.json();
  if (json.error) return 0;
  return json.shares?.count || 0;
}

async function postVideo(v, shares) {
  const res = await fetch(`http://localhost:${PORT}/api/page-video-insights`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      videoId: v.id,
      description: v.description || '',
      createdTime: v.created_time,
      length: v.length || 0,
      permalinkUrl: v.permalink_url || '',
      views: v.views || 0,
      postViews: v.post_views || 0,
      likes: v.likes?.summary?.total_count || 0,
      comments: v.comments?.summary?.total_count || 0,
      shares,
    }),
  });
  return res.json();
}

async function deleteVideo(videoId) {
  await fetch(`http://localhost:${PORT}/api/page-video-insights/${videoId}`, { method: 'DELETE' });
}

// ─── Real, distributed page posts only ──────────────────────────────────
// The Page's /videos feed also returns things that aren't a real published
// clip: the Facebook Story leg every auto-post fires alongside the Reel
// (same clip, no caption, permalinks as {page_id}/videos/{id} instead of
// /reel/{id}/), and stray uploads that never actually went out (test cuts,
// failed retries — views stay in single digits forever; real posts start
// in the thousands, so 50 is a safe floor with a lot of headroom on both
// sides). Filtered here, before anything reaches the database, rather than
// hidden later at render time.
const MIN_DISTRIBUTED_VIEWS = 50;
function isRealDistributedPost(v) {
  return /\/reel\//.test(v.permalink_url || '') && (v.views || 0) >= MIN_DISTRIBUTED_VIEWS;
}

const monthsBack = Number(process.argv[2]) || 3;
const videos = await fetchVideos(monthsAgo(monthsBack));
console.log(`Fetched ${videos.length} video(s) from the last ${monthsBack} month(s)`);
const keep = videos.filter(isRealDistributedPost);
const skip = videos.filter((v) => !isRealDistributedPost(v));
for (const v of keep) {
  const shares = await fetchShares(v.id);
  const result = await postVideo(v, shares);
  console.log('Synced:', v.created_time.slice(0, 10), v.id, `(shares: ${shares})`, '->', result.id || result.error);
}
for (const v of skip) {
  await deleteVideo(v.id);
  console.log('Skipped (not a real distributed page post):', v.created_time.slice(0, 10), v.id, `views:${v.views || 0}`, v.permalink_url || '');
}
