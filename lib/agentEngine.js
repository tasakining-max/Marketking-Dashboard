// Provider preferences use reserved AgentSetting rows, separate from user rules.
// This preserves existing settings and needs no database migration.
const PREFIX = '__engine:';
export const LANGUAGE_ENGINES = ['claude', 'codex'];

export async function enginePreferences(prisma) {
  const rows = await prisma.agentSetting.findMany({ where: { agent: { startsWith: PREFIX } } });
  return Object.fromEntries(rows.filter((r) => LANGUAGE_ENGINES.includes(r.rules)).map((r) => [r.agent.slice(PREFIX.length), r.rules]));
}

export function effectiveEngine(preferences, id) {
  return preferences[id] || preferences.all || 'claude';
}

export async function saveEngine(prisma, id, engine) {
  if (![...LANGUAGE_ENGINES, 'default'].includes(engine)) throw new Error('เลือก Claude, Codex หรือค่าเริ่มต้น');
  const agent = `${PREFIX}${id}`;
  if (engine === 'default') {
    await prisma.agentSetting.deleteMany({ where: { agent } });
  } else {
    await prisma.agentSetting.upsert({ where: { agent }, create: { agent, rules: engine }, update: { rules: engine } });
  }
}

// Codex structured output requires closed objects and every property required.
export function codexSchema(schema) {
  const out = { ...schema };
  if (out.type === 'object') {
    out.properties = Object.fromEntries(Object.entries(out.properties || {}).map(([k, v]) => [k, codexSchema(v)]));
    out.required = Object.keys(out.properties);
    out.additionalProperties = false;
  }
  if (out.items) out.items = codexSchema(out.items);
  return out;
}

export function claudeSession(sessionId) {
  if (!sessionId || sessionId.startsWith('codex:')) return null;
  return sessionId.replace(/^claude:/, '');
}

export function revisionContext(task) {
  if (!task.feedback) return '';
  return `\n\n${conversationNote(task)}\nร่างก่อนหน้า:\n${JSON.stringify(task.result || {})}\nปรับงานเดิมตามคำสั่งล่าสุดแล้วส่งใหม่ในรูปแบบเดิม`;
}

// The whole back-and-forth on one job, oldest first, so a short follow-up
// like "ยังไม่เหมือน" is read against what she asked before.
export function conversationNote(task) {
  const earlier = task.input?.history || [];
  const pics = task.input?.attachments?.length || 0;
  return [
    `คำสั่งแรกของงานนี้: ${task.prompt || '-'}`,
    ...earlier.map((x, i) => `คำสั่งแก้รอบที่ ${i + 1} (ทำไปแล้ว): ${x}`),
    `คำสั่งล่าสุด (ตีความต่อจากคำสั่งก่อนหน้าเสมอ): ${task.feedback}`,
    pics ? `หนิงแนบภาพอ้างอิงไว้ ${pics} ภาพ (ภาพท้ายสุดในรายการภาพแนบ) ถ้าคำสั่งพูดถึง "เหมือน" "แบบนี้" "อันนี้" ให้เทียบกับภาพอ้างอิงนั้น` : '',
  ].filter(Boolean).join('\n');
}

// Her last few jobs with this agent (oldest first), attached when a chat
// command is created, so "ทำต่อ" or "ยังไม่เหมือน" has something to refer to
// even after the earlier job was rejected or failed.
export function recentNote(task) {
  const recent = task.input?.recent || [];
  if (!recent.length) return '';
  const status = { review: 'รอหนิงตรวจ', done: 'หนิงอนุมัติแล้ว', rejected: 'หนิงกดไม่ผ่าน', failed: 'ทำไม่สำเร็จ', queued: 'รอคิว', running: 'กำลังทำ' };
  const lines = recent.map((r, i) => [
    `${i + 1}. หนิงสั่ง: ${r.prompt || '-'}`,
    ...(r.fixes || []).map((f) => `   แล้วสั่งแก้: ${f}`),
    `   ผล: ${status[r.status] || r.status}${r.outcome ? ` — ${r.outcome}` : ''}${r.pictures ? ` (แนบภาพอ้างอิง ${r.pictures} ภาพ)` : ''}`,
  ].join('\n'));
  return `\n\nบทสนทนาก่อนหน้ากับหนิงในงานนี้ (เก่า → ใหม่):\n${lines.join('\n')}\nคำสั่งใหม่อาจสั้นและอ้างถึงเรื่องข้างบน (เช่น "ทำต่อ" "ยังไม่เหมือน" "แบบเดิม") ให้ตีความต่อจากบทสนทนานี้ และทำเรื่องล่าสุดที่ยังไม่สำเร็จ อย่าตอบว่าไม่รู้บริบท ถามกลับเฉพาะเมื่อบทสนทนาก็ไม่ช่วยจริงๆ\n`;
}
