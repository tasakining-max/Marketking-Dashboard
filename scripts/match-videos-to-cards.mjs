import 'dotenv/config';

// Links real Facebook video posts (synced into PageVideoInsight by
// sync-page-video-insights.mjs) to their matching card on the board, so the
// card shows real view/like/comment/share stats instead of none. Matches by
// same calendar day — a published card and its Facebook post reliably share
// a publish date, and description/title text varies too much to match on
// reliably. Also pulls the video's real cover thumbnail onto the card.
//
// Run: node scripts/match-videos-to-cards.mjs

const PORT = process.env.PORT || 5050;
const TOKEN = process.env.FB_PAGE_ACCESS_TOKEN;
const GRAPH_VERSION = 'v26.0';
const BASE = `http://localhost:${PORT}`;

function dateKey(d) { return new Date(d).toISOString().slice(0, 10); }

async function fetchVideoCover(videoId) {
  const thumbs = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${videoId}/thumbnails?access_token=${TOKEN}`).then((r) => r.json());
  const preferred = (thumbs.data || []).find((t) => t.is_preferred) || (thumbs.data || [])[0];
  if (!preferred) return null;
  const imgRes = await fetch(preferred.uri);
  const buf = Buffer.from(await imgRes.arrayBuffer());
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

const [cardsRes, videosRes] = await Promise.all([
  fetch(`${BASE}/api/cards?column=published`).then((r) => r.json()),
  fetch(`${BASE}/api/page-video-insights`).then((r) => r.json()),
]);

const unlinkedCards = (cardsRes.cards || []).filter((c) => !c.linkedVideoId && c.publishedAt);
const linkedVideoIds = new Set((cardsRes.cards || []).map((c) => c.linkedVideoId).filter(Boolean));
const unlinkedVideos = (videosRes.entries || videosRes).filter((v) => !linkedVideoIds.has(v.videoId));

const cardsByDate = new Map();
for (const c of unlinkedCards) {
  const key = dateKey(c.publishedAt);
  if (!cardsByDate.has(key)) cardsByDate.set(key, []);
  cardsByDate.get(key).push(c);
}

const claimedCardIds = new Set();
let linked = 0;
for (const video of unlinkedVideos) {
  const key = dateKey(video.createdTime);
  const candidates = cardsByDate.get(key) || [];
  if (candidates.length !== 1) {
    console.log(`SKIP videoId=${video.videoId} (${key}) — ${candidates.length} candidate card(s) on that date, need manual review`);
    continue;
  }
  const card = candidates[0];
  // Card just got claimed by an earlier video this same run (e.g. 2+ real
  // videos landed the same day as only one candidate card) — don't hand it
  // a second video, that'd silently overwrite the first, correct link.
  if (claimedCardIds.has(card.id)) {
    console.log(`SKIP videoId=${video.videoId} (${key}) — card "${card.title}" already linked to a video this run, need manual review`);
    continue;
  }
  claimedCardIds.add(card.id);
  const cover = TOKEN ? await fetchVideoCover(video.videoId).catch(() => null) : null;
  if (cover) {
    await fetch(`${BASE}/api/cards/${card.id}/image`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: cover }),
    });
  }
  await fetch(`${BASE}/api/cards/${card.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ linkedVideoId: video.videoId, caption: video.description || '' }),
  });
  console.log(`LINKED "${card.title}" -> videoId=${video.videoId} (${key})${cover ? ' + cover image' : ''}`);
  linked++;
}

console.log(`\nDone. Linked ${linked} card(s). ${unlinkedVideos.length - linked} still need manual review.`);
