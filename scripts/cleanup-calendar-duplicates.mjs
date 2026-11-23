// One-off cleanup of the "Marketing Calendar" in Outlook after the drag bug
// (dragging a card sent "add" without deleting the old event, so 📅 Plan stayed
// after ✅ Public and 🎬/✅ events piled up on every drag). Per card it sends the
// same "PlannerSync" mail the server sends:
//   - for each event the card should have: upsert with oldSubject = its own
//     subject → the flow deletes every copy that day, then creates one;
//   - for a published card: delete its old "📅 Plan" event. The plan date was
//     cleared on publish, so the window is 180 days before → 60 after publishing.
//   node scripts/cleanup-calendar-duplicates.mjs         → list (dry run)
//   node scripts/cleanup-calendar-duplicates.mjs --send  → send the mails
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import nodemailer from 'nodemailer';
import { calendarEvent, nextDay } from '../lib/calendarEvent.js';

const send = process.argv.includes('--send');
const prisma = new PrismaClient({ adapter: new PrismaPg(new pg.Pool({ connectionString: process.env.DATABASE_URL })) });
const addDays = (ymd, n) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

const cards = await prisma.card.findMany({ where: { status: { not: 'rejected' } }, omit: { imageUrl: true } });
const msgs = [];
for (const card of cards) {
  for (const kind of ['shoot', 'plan', 'public']) {
    const ev = calendarEvent(card, kind);
    if (!ev) continue;
    const day = ev.start.slice(0, 10);
    msgs.push({ action: 'upsert', ...ev, oldSubject: ev.subject, oldFrom: `${day}T00:00:00+07:00`, oldTo: `${nextDay(day)}T00:00:00+07:00` });
  }
  const pub = calendarEvent(card, 'public');
  if (pub) {
    const day = pub.start.slice(0, 10);
    const subject = `📅 Plan: ${card.title}`;
    msgs.push({ action: 'delete', subject, start: `${day}T00:00:00`, end: `${nextDay(day)}T00:00:00`, allDay: true, body: '',
      oldSubject: subject, oldFrom: `${addDays(day, -180)}T00:00:00+07:00`, oldTo: `${addDays(day, 60)}T00:00:00+07:00` });
  }
}
for (const m of msgs) console.log(`${m.action.padEnd(6)} ${m.start.slice(0, 10)}  ${m.subject}`);
console.log(`${msgs.length} mail(s) for ${cards.length} card(s)${send ? '' : ' — dry run, add --send'}`);

if (send && msgs.length) {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS || !process.env.PLANNER_EMAIL_TO) throw new Error('SMTP_USER/SMTP_PASS/PLANNER_EMAIL_TO missing in .env');
  const mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.office365.com', port: Number(process.env.SMTP_PORT) || 587,
    secure: false, requireTLS: true, auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  let ok = 0;
  for (const [i, m] of msgs.entries()) {
    try {
      await mailer.sendMail({ from: process.env.SMTP_USER, to: process.env.PLANNER_EMAIL_TO, subject: 'PlannerSync', text: Buffer.from(JSON.stringify(m)).toString('base64') });
      ok++;
    } catch (e) { console.error(`Failed: ${m.subject}: ${e.message}`); }
    if ((i + 1) % 20 === 0) console.log(`…${i + 1}/${msgs.length}`);
    await new Promise((r) => setTimeout(r, 2500)); // stay under Office 365's 30 mails/min
  }
  console.log(`Sent ${ok}/${msgs.length}`);
}
await prisma.$disconnect();
