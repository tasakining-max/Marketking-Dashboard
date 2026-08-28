import 'dotenv/config';
import fs from 'fs';

// Pulls AC shop ("ร้านแอร์") listings from Google Maps via SerpApi, one search per
// Thai province (77 total incl. Bangkok), and writes everything to a single CSV.
// Free-tier SerpApi budget is 250 searches/month — this uses 77 of them (one per
// province, first page of results only, ~20 results/province).

const API_KEY = process.env.SERPAPI_KEY;
if (!API_KEY) {
  console.error('Missing SERPAPI_KEY in .env');
  process.exit(1);
}

// [name, lat, lng] — province capital / main city center, used as Maps search origin.
const PROVINCES = [
  ['Bangkok', 13.7563, 100.5018],
  ['Samut Prakan', 13.5990, 100.5998],
  ['Nonthaburi', 13.8622, 100.5144],
  ['Pathum Thani', 14.0208, 100.5250],
  ['Phra Nakhon Si Ayutthaya', 14.3532, 100.5680],
  ['Ang Thong', 14.5896, 100.4549],
  ['Lop Buri', 14.7995, 100.6534],
  ['Sing Buri', 14.8907, 100.3968],
  ['Chai Nat', 15.1851, 100.1251],
  ['Saraburi', 14.5289, 100.9101],
  ['Nakhon Nayok', 14.2069, 101.2130],
  ['Nakhon Pathom', 13.8196, 100.0645],
  ['Samut Sakhon', 13.5475, 100.2743],
  ['Samut Songkhram', 13.4098, 100.0022],
  ['Suphan Buri', 14.4744, 100.1177],
  ['Kanchanaburi', 14.0227, 99.5328],
  ['Ratchaburi', 13.5282, 99.8134],
  ['Phetchaburi', 13.1119, 99.9440],
  ['Prachuap Khiri Khan', 11.8126, 99.7957],
  ['Chachoengsao', 13.6904, 101.0779],
  ['Chonburi', 13.3611, 100.9847],
  ['Rayong', 12.6833, 101.2372],
  ['Chanthaburi', 12.6112, 102.1039],
  ['Trat', 12.2428, 102.5178],
  ['Prachinburi', 14.0509, 101.3672],
  ['Sa Kaeo', 13.8241, 102.0645],
  ['Nakhon Ratchasima', 14.9799, 102.0977],
  ['Buriram', 14.9930, 103.1029],
  ['Surin', 14.8818, 103.4936],
  ['Sisaket', 15.1186, 104.3220],
  ['Ubon Ratchathani', 15.2286, 104.8564],
  ['Yasothon', 15.7927, 104.1451],
  ['Chaiyaphum', 15.8068, 102.0313],
  ['Amnat Charoen', 15.8656, 104.6259],
  ['Nong Bua Lamphu', 17.2216, 102.4260],
  ['Khon Kaen', 16.4419, 102.8360],
  ['Udon Thani', 17.4139, 102.7873],
  ['Loei', 17.4860, 101.7223],
  ['Nong Khai', 17.8783, 102.7420],
  ['Maha Sarakham', 16.1852, 103.3009],
  ['Roi Et', 16.0538, 103.6534],
  ['Kalasin', 16.4322, 103.5058],
  ['Sakon Nakhon', 17.1547, 104.1481],
  ['Nakhon Phanom', 17.4107, 104.7793],
  ['Mukdahan', 16.5450, 104.7233],
  ['Bueng Kan', 18.3609, 103.6465],
  ['Chiang Mai', 18.7883, 98.9853],
  ['Lamphun', 18.5744, 99.0087],
  ['Lampang', 18.2888, 99.4909],
  ['Uttaradit', 17.6200, 100.0993],
  ['Phrae', 18.1445, 100.1405],
  ['Nan', 18.7756, 100.7730],
  ['Phayao', 19.1667, 99.9020],
  ['Chiang Rai', 19.9105, 99.8406],
  ['Mae Hong Son', 19.3020, 97.9654],
  ['Nakhon Sawan', 15.7030, 100.1367],
  ['Uthai Thani', 15.3835, 100.0248],
  ['Kamphaeng Phet', 16.4827, 99.5226],
  ['Tak', 16.8840, 99.1258],
  ['Sukhothai', 17.0068, 99.8265],
  ['Phitsanulok', 16.8211, 100.2659],
  ['Phichit', 16.4381, 100.3487],
  ['Phetchabun', 16.4194, 101.1591],
  ['Nakhon Si Thammarat', 8.4304, 99.9631],
  ['Krabi', 8.0863, 98.9063],
  ['Phang Nga', 8.4510, 98.5310],
  ['Phuket', 7.8804, 98.3923],
  ['Surat Thani', 9.1382, 99.3215],
  ['Ranong', 9.9528, 98.6084],
  ['Chumphon', 10.4930, 99.1800],
  ['Songkhla', 7.1897, 100.5951],
  ['Satun', 6.6238, 100.0674],
  ['Trang', 7.5563, 99.6113],
  ['Phatthalung', 7.6167, 100.0742],
  ['Pattani', 6.8697, 101.2500],
  ['Yala', 6.5411, 101.2807],
  ['Narathiwat', 6.4264, 101.8231],
];

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function searchProvince(name, lat, lng) {
  const params = new URLSearchParams({
    engine: 'google_maps',
    q: 'ร้านแอร์',
    ll: `@${lat},${lng},13z`,
    type: 'search',
    api_key: API_KEY,
  });
  const res = await fetch(`https://serpapi.com/search.json?${params}`);
  const json = await res.json();
  if (json.error) {
    console.error(`  Error for ${name}: ${json.error}`);
    return [];
  }
  return json.local_results || [];
}

async function main() {
  const rows = [['province', 'name', 'address', 'phone', 'rating', 'reviews', 'open_state', 'place_id']];
  let total = 0;
  let closed = 0;

  for (const [name, lat, lng] of PROVINCES) {
    process.stdout.write(`${name}... `);
    const results = await searchProvince(name, lat, lng);
    console.log(`${results.length} results`);
    for (const r of results) {
      const openState = r.open_state || '';
      if (/permanently closed/i.test(openState)) closed++;
      rows.push([name, r.title || '', r.address || '', r.phone || '', r.rating ?? '', r.reviews ?? '', openState, r.place_id || '']);
    }
    total += results.length;
    // small delay to be a considerate API citizen
    await new Promise((r) => setTimeout(r, 300));
  }

  const csv = rows.map((r) => r.map(csvEscape).join(',')).join('\n');
  const outPath = new URL('../ac-shops-thailand.csv', import.meta.url);
  fs.writeFileSync(outPath, csv, 'utf8');
  console.log(`\nDone. ${total} listings across ${PROVINCES.length} provinces (${closed} flagged "Permanently closed") -> ${outPath.pathname}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
