// The Outlook event a card shows as, per kind ('shoot' | 'plan' | 'public'),
// or null when it has none. Shared by server.js (syncCalendar) and
// scripts/cleanup-calendar-duplicates.mjs.
const pad2 = (n) => String(n).padStart(2, '0');
export const nextDay = (ymd) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };
export function calendarEvent(card, kind) {
  if (!card || card.status === 'rejected' || (kind === 'public' && card.column !== 'published')) return null;
  // Once published, the "✅ Public" event replaces the "📅 Plan" one, so the
  // plan event is deleted instead of sitting next to it as a duplicate.
  if (kind === 'plan' && card.column === 'published' && card.publishedAt) return null;
  const ymd = kind === 'shoot' ? card.shootDate : kind === 'plan' ? card.plannedPublishDate
    : card.publishedAt ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date(card.publishedAt)) : null;
  const day = ymd ? String(ymd).slice(0, 10) : null;
  if (!day) return null;
  const label = { shoot: '🎬 ถ่าย', plan: '📅 Plan', public: '✅ Public' }[kind];
  const ev = { id: card.id, kind, subject: `${label}: ${card.title}`, body: [card.shootNote && kind === 'shoot' ? card.shootNote : '', card.description || ''].filter(Boolean).join('\n\n'), allDay: true, start: `${day}T00:00:00`, end: `${nextDay(day)}T00:00:00` };
  // A shoot note like "09:00–11:00 น." or "14:00 น." gives the real time.
  const m = kind === 'shoot' && String(card.shootNote || '').match(/(\d{1,2})[:.](\d{2})(?:\s*(?:[–\-]|ถึง)\s*(\d{1,2})[:.](\d{2}))?/);
  if (m) {
    const sh = Number(m[1]); const sm = Number(m[2]);
    const eh = m[3] ? Number(m[3]) : Math.min(sh + 1, 23); const em = m[3] ? Number(m[4]) : sm;
    if (sh < 24 && eh < 24 && sm < 60 && em < 60 && eh * 60 + em > sh * 60 + sm) {
      Object.assign(ev, { allDay: false, start: `${day}T${pad2(sh)}:${pad2(sm)}:00`, end: `${day}T${pad2(eh)}:${pad2(em)}:00` });
    }
  }
  return ev;
}
