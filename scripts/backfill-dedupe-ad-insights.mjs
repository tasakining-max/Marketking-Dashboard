import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const NAME_TO_AD_ID = {
  'R&D อากาศประเทศไทย': '120249643175390194',
  'ไฟฟรีจากแดด - Solar Hybrid': '120249643492620194',
  'ชาไทย ( Highest View)': '120249642932630194',
};

const rows = await prisma.adInsight.findMany({ orderBy: { date: 'asc' } });
console.log(`Found ${rows.length} rows total`);

// Step 1: backfill adId from creativeName
for (const r of rows) {
  const adId = NAME_TO_AD_ID[r.creativeName];
  if (adId && r.adId !== adId) {
    await prisma.adInsight.update({ where: { id: r.id }, data: { adId } });
  }
}
console.log('Backfilled adId for all rows.');

// Step 2: dedupe — group by (date key, adId), keep row with highest impressions
const refreshed = await prisma.adInsight.findMany();
const groups = new Map();
for (const r of refreshed) {
  const dateKey = r.date.toISOString().slice(0, 10);
  const key = `${dateKey}__${r.adId}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(r);
}

let deletedCount = 0;
for (const [key, group] of groups) {
  if (group.length <= 1) continue;
  group.sort((a, b) => b.impressions - a.impressions);
  const keep = group[0];
  const toDelete = group.slice(1);
  console.log(`${key}: keeping row ${keep.id} (impressions=${keep.impressions}, spend=${keep.spend}), deleting ${toDelete.length} dup(s)`);
  for (const d of toDelete) {
    await prisma.adInsight.delete({ where: { id: d.id } });
    deletedCount++;
  }
}
console.log(`Deleted ${deletedCount} duplicate row(s).`);

const final = await prisma.adInsight.findMany({ orderBy: { date: 'asc' } });
const total = final.reduce((s, r) => s + r.spend, 0);
console.log(`Final row count: ${final.length}, total spend: ${total.toFixed(2)}`);

await prisma.$disconnect();
