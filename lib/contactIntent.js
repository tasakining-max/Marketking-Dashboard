// Guesses whether an ad visitor's contact tap (LINE / phone / Facebook /
// dealer button / dealer page / dealer phone / directions) was meant or a
// slip, from what that same session did on tasaki-web around the tap.
// Only behaviour the site actually logs is used (page views with max scroll,
// click events), so every reason shown on the Ads page is checkable in the
// journey listed under it.

// journey: [{ t: Date, kind: 'page' | 'tap', path, label, scroll }] sorted by t.
// event: { type, tFirst: Date, count, dealer }
// dealerRank: { rank, region } for directions / dealer-phone taps, else null.
export function judgeContactIntent(event, journey, dealerRank) {
  const reasons = []; // [{ sign: '+' | '-' | '!', text }]
  const t = new Date(event.tFirst).getTime();
  const pages = journey.filter((s) => s.kind === 'page');
  const landing = pages[0] ? new Date(pages[0].t).getTime() : t;
  const before = pages.filter((p) => new Date(p.t).getTime() <= t);
  const pageAtTap = before[before.length - 1];
  const after = pages.filter((p) => new Date(p.t).getTime() > t);
  const secSinceLanding = Math.max(0, Math.round((t - landing) / 1000));
  const secOnPage = pageAtTap ? Math.max(0, Math.round((t - new Date(pageAtTap.t).getTime()) / 1000)) : 0;
  const scroll = pageAtTap?.scroll || 0;
  const distinctPages = new Set(pages.map((p) => p.path)).size;
  const productPages = new Set(pages.filter((p) => /^\/products\/\d+\/[^/]+/.test(p.path)).map((p) => p.path.split('/')[3])).size;
  const otherContactTaps = new Set(journey.filter((s) => s.kind === 'tap').map((s) => s.label.split(':').slice(0, 2).join(':'))).size;
  let score = 0;
  const add = (sign, text, w) => { reasons.push({ sign, text }); score += w; };
  const dur = (s) => (s >= 3600 ? `${Math.round(s / 3600)} ชม.` : s >= 60 ? `${Math.round(s / 60)} นาที` : `${s} วินาที`);

  const isTap = !['dealerView', 'cta'].includes(event.type);

  // Rapid repeat taps on the same button: the person wanted it but nothing happened.
  if (isTap && event.count >= 3) {
    const sameBtn = journey.filter((s) => s.kind === 'tap' && s.type === event.type);
    const spanSec = sameBtn.length > 1 ? Math.round((new Date(sameBtn[sameBtn.length - 1].t) - new Date(sameBtn[0].t)) / 1000) : 0;
    if (spanSec <= 15) {
      reasons.push({ sign: '!', text: `กดปุ่มเดิม ${event.count} ครั้งใน ${spanSec} วินาที ตั้งใจกด แต่ปุ่มน่าจะไม่ทำงาน` });
      return { verdict: 'broken', label: 'ตั้งใจ แต่ปุ่มอาจไม่ทำงาน', reasons, secSinceLanding, secOnPage, scroll };
    }
  }

  // Time on the page before the tap.
  if (secOnPage >= 30 * 60) add('+', `เปิดหน้าทิ้งไว้ ${dur(secOnPage)} แล้วกลับมากด`, 1);
  else if (secOnPage >= 20) add('+', `อยู่ในหน้านั้น ${dur(secOnPage)} ก่อนกด`, 1);
  else if (secSinceLanding <= 8) add('-', `กดหลังเข้าเว็บแค่ ${secSinceLanding} วินาที`, -1);

  // How far they read the page they tapped on.
  if (scroll >= 50) add('+', `เลื่อนอ่านหน้านั้นถึง ${scroll}%`, 1);
  else if (scroll > 0 && scroll < 20 && isTap) add('-', `ยังอยู่จอแรก (เลื่อนแค่ ${scroll}%)`, -1);

  // Browsing depth.
  if (productPages >= 2) add('+', `ดูสินค้า ${productPages} รุ่นเทียบกัน`, 1);
  else if (distinctPages >= 3) add('+', `ดูเว็บต่อ ${distinctPages} หน้า`, 1);

  // Path into the dealer list.
  if (['directions', 'dealerPhone', 'dealerView'].includes(event.type)) {
    const regionPick = pages.some((p) => /^\/dealers\/[a-z]+/.test(p.path));
    if (regionPick) add('+', 'เลือกภาคเองในหน้าร้านตัวแทน', 1);
  }
  if (dealerRank && ['directions', 'dealerPhone'].includes(event.type)) {
    if (dealerRank.rank === 1) add('-', 'ร้านนี้อยู่อันดับ 1 ของรายชื่อ กดพลาดง่ายที่สุด', -1);
    else add('+', `เลื่อนผ่าน ${dealerRank.rank - 1} ร้านก่อนจะเลือกร้านนี้`, 1);
  }

  // Tried more than one way to reach us.
  if (otherContactTaps >= 2) add('+', `กดติดต่อหลายช่องทาง (${otherContactTaps} แบบ)`, 1);

  // What happened right after.
  if (after.length) {
    const gap = Math.round((new Date(after[0].t).getTime() - t) / 1000);
    if (isTap && gap >= 20 && gap <= 30 * 60) add('+', `ออกไป ${dur(gap)} แล้วกลับมาเว็บ (น่าจะไปดูแผนที่/แชท/โทรแล้ว)`, 1);
    else if (isTap && gap < 20) reasons.push({ sign: '·', text: `เปิดหน้าอื่นในเว็บต่อภายใน ${gap} วินาที` });
  } else if (isTap) {
    reasons.push({ sign: '·', text: 'กดแล้วไม่กลับมาเว็บอีก (อาจไปคุยต่อ หรือปิดไปเลย)' });
  }

  const verdict = score >= 2 ? 'intent' : score <= -1 ? 'mistake' : 'unsure';
  const label = { intent: 'ตั้งใจ', mistake: 'น่าจะกดพลาด', unsure: 'ไม่แน่ใจ' }[verdict];
  return { verdict, label, reasons, secSinceLanding, secOnPage, scroll };
}
