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

const monthsBack = Number(process.argv[2]) || 3;
const videos = await fetchVideos(monthsAgo(monthsBack));
console.log(`Fetched ${videos.length} video(s) from the last ${monthsBack} month(s)`);
for (const v of videos) {
  const shares = await fetchShares(v.id);
  const result = await postVideo(v, shares);
  console.log('Synced:', v.created_time.slice(0, 10), v.id, `(shares: ${shares})`, '->', result.id || result.error);
}
