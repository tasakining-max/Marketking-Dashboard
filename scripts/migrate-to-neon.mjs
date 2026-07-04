import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaNeon } from '@prisma/adapter-neon';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

function readJson(file, fallback) {
  const p = path.join(ROOT, file);
  if (!fs.existsSync(p)) return fallback;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

async function main() {
  console.log('Starting migration to Neon...\n');

  // ===== CARDS =====
  const { cards } = readJson('data.json', { cards: [] });
  console.log(`Migrating ${cards.length} cards...`);
  for (const c of cards) {
    await prisma.card.upsert({
      where: { id: c.id },
      update: {},
      create: {
        id: c.id,
        title: c.title,
        description: c.description || '',
        column: c.column || 'idea',
        status: c.status || 'active',
        rejectionReason: c.rejectionReason || '',
        tags: c.tags || [],
        platforms: c.platforms || [],
        imageUrl: c.imageUrl || null,
        todos: c.todos || [],
        issues: c.issues || [],
        comments: c.comments || [],
        links: c.links || [],
        order: c.order || 0,
        pinned: c.pinned || false,
        plannedPublishDate: c.plannedPublishDate || null,
        publishedAt: c.publishedAt || null,
        createdAt: c.createdAt ? new Date(c.createdAt) : new Date(),
        updatedAt: c.updatedAt ? new Date(c.updatedAt) : new Date(),
      },
    });
  }
  console.log('✓ Cards done');

  // ===== KEY MESSAGES =====
  const { messages } = readJson('key-messages.json', { messages: [] });
  console.log(`\nMigrating ${messages.length} key messages...`);
  for (const m of messages) {
    await prisma.keyMessage.upsert({
      where: { id: m.id },
      update: { text: m.text },
      create: { id: m.id, text: m.text },
    });
  }
  console.log('✓ Key messages done');

  // ===== PROFILES =====
  const profiles = readJson('profiles.json', []);
  console.log(`\nMigrating ${profiles.length} profiles...`);
  for (const p of profiles) {
    await prisma.profile.upsert({
      where: { name: p.name },
      update: { imageUrl: p.imageUrl || '' },
      create: {
        id: p.id || crypto.randomUUID(),
        name: p.name,
        imageUrl: p.imageUrl || '',
      },
    });
  }
  console.log('✓ Profiles done');

  // ===== ACTIVITY =====
  const { activity = [], cronJobs = [] } = readJson('activity.json', {});
  console.log(`\nMigrating ${activity.length} activity entries...`);
  for (const a of activity) {
    await prisma.activityEntry.upsert({
      where: { id: a.id || crypto.randomUUID() },
      update: {},
      create: {
        id: a.id || crypto.randomUUID(),
        text: a.text || '',
        createdAt: a.createdAt ? new Date(a.createdAt) : new Date(),
      },
    });
  }
  console.log(`Migrating ${cronJobs.length} cron jobs...`);
  for (const j of cronJobs) {
    await prisma.cronJob.upsert({
      where: { id: j.id || crypto.randomUUID() },
      update: {},
      create: {
        id: j.id || crypto.randomUUID(),
        name: j.name || '',
        schedule: j.schedule || '',
        command: j.command || '',
        enabled: j.enabled !== false,
      },
    });
  }
  console.log('✓ Activity done');

  // ===== WEBSITE ISSUES =====
  const websiteIssues = readJson('website-issues.json', {});
  const entries = Object.entries(websiteIssues);
  console.log(`\nMigrating ${entries.length} website issue entries...`);
  for (const [id, entry] of entries) {
    await prisma.websiteIssue.upsert({
      where: { id },
      update: { issues: entry.issues || [] },
      create: {
        id,
        date: entry.date || '',
        feature: entry.feature || '',
        issues: entry.issues || [],
      },
    });
  }
  console.log('✓ Website issues done');

  // ===== MARKETING CHANGELOG =====
  const { entries: clEntries = [] } = readJson('marketing-changelog.json', { entries: [] });
  console.log(`\nMigrating ${clEntries.length} changelog entries...`);
  for (const e of clEntries) {
    const text = e.feature || e.text || '';
    const date = new Date(e.datetime || e.date || Date.now());
    await prisma.marketingChangelog.upsert({
      where: { id: e.id || crypto.randomUUID() },
      update: { text, date },
      create: { id: e.id || crypto.randomUUID(), text, date },
    });
  }
  console.log('✓ Marketing changelog done');

  // ===== WEBSITE CHANGELOG =====
  const { entries: wcEntries = [] } = readJson('website-changelog.json', { entries: [] });
  console.log(`\nMigrating ${wcEntries.length} website changelog entries...`);
  for (const e of wcEntries) {
    const text = e.feature || e.text || '';
    const date = new Date(e.datetime || e.date || Date.now());
    await prisma.websiteChangelog.upsert({
      where: { id: e.id || crypto.randomUUID() },
      update: { text, date },
      create: { id: e.id || crypto.randomUUID(), text, date },
    });
  }
  console.log('✓ Website changelog done');

  console.log('\n✅ Migration complete!');
}

main()
  .catch((e) => { console.error('Migration failed:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
