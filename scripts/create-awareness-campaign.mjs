import 'dotenv/config';
import { prisma } from '../lib/db.js';

// Creates a real Facebook Awareness campaign (Campaign -> Ad Set -> Ads) using
// existing organic Page videos as ad creative. Everything is created in PAUSED
// status so nothing spends money until you review it in Ads Manager and switch
// it on yourself.
//
// Note: Reels can't be boosted directly via object_story_id (Meta rejects it as
// "Page post can't be used"). Instead each ad creative is built fresh from the
// video asset via object_story_spec.video_data, which needs the video's own
// thumbnail uploaded to the ad account's image library first (image_hash).
//
// Usage:
//   node scripts/create-awareness-campaign.mjs            (dry run — prints payloads, calls nothing)
//   node scripts/create-awareness-campaign.mjs --live      (actually calls the Graph API, still PAUSED)

const AD_ACCOUNT_ID = process.env.FB_AD_ACCOUNT_ID;
const PAGE_ID = process.env.FB_PAGE_ID;
const ACCESS_TOKEN = process.env.FB_USER_ACCESS_TOKEN;
const PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN;
const GRAPH_VERSION = 'v26.0';
const BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

if (!AD_ACCOUNT_ID || !PAGE_ID || !ACCESS_TOKEN) {
  console.error('Missing FB_AD_ACCOUNT_ID / FB_PAGE_ID / FB_USER_ACCESS_TOKEN in .env');
  process.exit(1);
}

const LIVE = process.argv.includes('--live');

// The two organic videos we're boosting for this test — chosen for having ~5x
// the views of the next tier down among the last 3 months of reels.
const VIDEO_IDS = [
  '1122552184284613', // เลือกซื้อ เลือกใช้แอร์ Tasaki เถอะ — 12.5K views, 11.8s
  '2227196254682518', // ผลิตเองในไทย คลังใหญ่ อะไหล่พร้อม! — 12.4K views, 15s
];

const DAILY_BUDGET_THB = 150;
const DAYS = 7;
const CAMPAIGN_NAME = `Awareness - Test - ${new Date().toISOString().slice(0, 10)}`;

async function graphPost(path, params) {
  const url = `${BASE}/${path}`;
  const body = new URLSearchParams({ ...params, access_token: ACCESS_TOKEN });
  if (!LIVE) {
    console.log(`\n[DRY RUN] POST ${path}`);
    const preview = Object.fromEntries(body);
    delete preview.access_token;
    console.log(JSON.stringify(preview, null, 2));
    return { id: `dry_run_${path.split('/').pop()}_${Math.random().toString(36).slice(2, 8)}` };
  }
  const res = await fetch(url, { method: 'POST', body });
  const json = await res.json();
  if (json.error) throw new Error(`Graph API error on ${path}: ${json.error.message}`);
  return json;
}

// Fetches the video's preferred thumbnail and uploads it to the ad account's
// image library, returning the image_hash ad creatives need. Real network calls
// only happen in --live mode.
async function getVideoImageHash(videoId) {
  const thumbRes = await fetch(`${BASE}/${videoId}/thumbnails?fields=uri,is_preferred&access_token=${PAGE_ACCESS_TOKEN}`);
  const thumbJson = await thumbRes.json();
  if (thumbJson.error) throw new Error(`Graph API error on GET ${videoId}/thumbnails: ${thumbJson.error.message}`);
  const preferred = thumbJson.data.find((t) => t.is_preferred) || thumbJson.data[0];
  if (!preferred) throw new Error(`No thumbnail found for video ${videoId}`);

  const imgRes = await fetch(preferred.uri);
  const imgBuffer = Buffer.from(await imgRes.arrayBuffer());

  const form = new FormData();
  form.append('access_token', ACCESS_TOKEN);
  form.append('filename', new Blob([imgBuffer], { type: 'image/jpeg' }), `${videoId}.jpg`);
  const uploadRes = await fetch(`${BASE}/${AD_ACCOUNT_ID}/adimages`, { method: 'POST', body: form });
  const uploadJson = await uploadRes.json();
  if (uploadJson.error) throw new Error(`Graph API error on POST adimages: ${uploadJson.error.message}`);
  const firstKey = Object.keys(uploadJson.images)[0];
  return uploadJson.images[firstKey].hash;
}

async function main() {
  console.log(LIVE ? '=== LIVE RUN (will call the real Graph API; results created PAUSED) ===' : '=== DRY RUN (no API calls — review payloads below) ===');

  // Preflight: confirm each video actually resolves to a postable object_story_id
  // before we build ad creatives around it.
  for (const videoId of VIDEO_IDS) {
    const info = await prisma.pageVideoInsight.findUnique({ where: { videoId } });
    if (!info) throw new Error(`videoId ${videoId} not found in PageVideoInsight — did the id change?`);
    console.log(`Using video: ${videoId} | ${info.views} views | ${info.description.slice(0, 50)}`);
  }

  if (LIVE) {
    for (const videoId of VIDEO_IDS) {
      const storyId = `${PAGE_ID}_${videoId}`;
      const qs = new URLSearchParams({ fields: 'id,permalink_url', access_token: PAGE_ACCESS_TOKEN });
      const res = await fetch(`${BASE}/${storyId}?${qs}`);
      const check = await res.json();
      if (check.error) throw new Error(`Graph API error on GET ${storyId}: ${check.error.message}`);
      console.log(`Verified object_story_id ${storyId} ->`, check.permalink_url || check.id);
    }
  }

  // 1. Campaign
  const campaign = await graphPost(`${AD_ACCOUNT_ID}/campaigns`, {
    name: CAMPAIGN_NAME,
    objective: 'OUTCOME_AWARENESS',
    status: 'PAUSED',
    special_ad_categories: '[]',
    is_adset_budget_sharing_enabled: 'false', // budget is set on the ad set, not the campaign
  });
  console.log('Campaign created:', campaign.id);

  // 2. Ad Set
  const now = new Date();
  const end = new Date(now.getTime() + DAYS * 24 * 60 * 60 * 1000);
  const adSet = await graphPost(`${AD_ACCOUNT_ID}/adsets`, {
    name: `${CAMPAIGN_NAME} - Ad Set`,
    campaign_id: campaign.id,
    daily_budget: String(DAILY_BUDGET_THB * 100), // THB minor unit (satang)
    billing_event: 'IMPRESSIONS',
    optimization_goal: 'REACH',
    bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
    targeting: JSON.stringify({
      geo_locations: { countries: ['TH'] },
      age_min: 25,
      age_max: 55,
      targeting_automation: { advantage_audience: 0 },
    }),
    start_time: now.toISOString(),
    end_time: end.toISOString(),
    status: 'PAUSED',
  });
  console.log('Ad Set created:', adSet.id);

  // 3. Ad Creative + Ad per video (fresh creative built from the video asset)
  for (const videoId of VIDEO_IDS) {
    const imageHash = LIVE ? await getVideoImageHash(videoId) : '<dry-run: thumbnail not fetched>';
    console.log(`Thumbnail image_hash for ${videoId}:`, imageHash);

    const creative = await graphPost(`${AD_ACCOUNT_ID}/adcreatives`, {
      name: `Creative - ${videoId}`,
      object_story_spec: JSON.stringify({
        page_id: PAGE_ID,
        video_data: {
          video_id: videoId,
          image_hash: imageHash,
          call_to_action: { type: 'LEARN_MORE', value: { link: `https://www.facebook.com/${PAGE_ID}` } },
        },
      }),
    });
    console.log('Creative created:', creative.id, 'for video', videoId);

    const ad = await graphPost(`${AD_ACCOUNT_ID}/ads`, {
      name: `Ad - ${videoId}`,
      adset_id: adSet.id,
      creative: JSON.stringify({ creative_id: creative.id }),
      status: 'PAUSED',
    });
    console.log('Ad created:', ad.id);
  }

  console.log(LIVE
    ? '\nDone. Everything was created PAUSED — go review it in Ads Manager and activate the campaign/ad set when ready.'
    : '\nDry run complete — no real objects created. Re-run with --live to actually create them (still PAUSED, no spend until you activate).');

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
