import 'dotenv/config';

const PORT = process.env.PORT || 5050;
const AD_ACCOUNT_ID = process.env.FB_AD_ACCOUNT_ID;
const ACCESS_TOKEN = process.env.FB_USER_ACCESS_TOKEN;
const GRAPH_VERSION = 'v26.0';

if (!AD_ACCOUNT_ID || !ACCESS_TOKEN) {
  console.error('Missing FB_AD_ACCOUNT_ID or FB_USER_ACCESS_TOKEN in .env');
  process.exit(1);
}

function yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function fetchInsights(since, until) {
  const fields = 'campaign_name,spend,reach,impressions,clicks,ctr,cpc';
  const timeRange = encodeURIComponent(JSON.stringify({ since, until }));
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${AD_ACCOUNT_ID}/insights?level=campaign&time_increment=1&time_range=${timeRange}&fields=${fields}&access_token=${ACCESS_TOKEN}`;
  const res = await fetch(url);
  const json = await res.json();
  if (json.error) throw new Error(`Graph API error: ${json.error.message}`);
  return json.data || [];
}

async function postInsight(row) {
  const res = await fetch(`http://localhost:${PORT}/api/ad-insights`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      date: row.date_start,
      campaignName: row.campaign_name,
      spend: Number(row.spend) || 0,
      reach: Number(row.reach) || 0,
      impressions: Number(row.impressions) || 0,
      clicks: Number(row.clicks) || 0,
      ctr: Number(row.ctr) || 0,
      cpc: Number(row.cpc) || 0,
    }),
  });
  return res.json();
}

const since = process.argv[2] || yesterday();
const until = process.argv[3] || since;

const rows = await fetchInsights(since, until);
console.log(`Fetched ${rows.length} insight row(s) for ${since}..${until}`);
for (const row of rows) {
  const result = await postInsight(row);
  console.log('Logged:', row.campaign_name, row.date_start, '->', result.id || result.error);
}
