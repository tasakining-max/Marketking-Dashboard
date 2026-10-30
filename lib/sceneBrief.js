// The scene brief for พิมพ์ (Codex), written the way the barbershop ad's scene
// finally came out right (2026-10-28): the picture is described as numbered
// bands with pixel positions, so the whole subject lands inside the 1:1 crop,
// the sky stays clear for the headline, and a wall is left empty for the AC.
// ผัง only supplies the place, the people and the props; the geometry comes
// from the frame, so every ad gets the same disciplined layout.

// Bands, from the 1:1 crop of a 1080x1920 master (crops.at(-1)).
export function sceneBands(frame) {
  const [W, H] = frame.size;
  const sq = frame.crops?.at(-1)?.rect || [0, Math.round(H * 0.22), W, W];
  const top = sq[1];
  const bottom = sq[1] + sq[3];
  const roof = top + 280;
  return {
    W, H, top, bottom,
    skyClear: [top + 10, roof - 10],
    panels: [roof, roof + 90],
    eave: [roof + 90, roof + 150],
    shop: [roof + 150, bottom - 20],
    acZone: [Math.round(W * 0.31), roof + 160, Math.round(W * 0.69), roof + 390],
    peopleHeadY: roof + 400,
    floor: bottom - 30,
    yard: [bottom - 10, H],
  };
}

// scene: what ผัง decides (place, people, props); returns the full prompt.
export function sceneBrief(frame, scene) {
  const b = sceneBands(frame);
  const [ax0, ay0, ax1, ay1] = b.acZone;
  return `ฉาก: ${String(scene || '').trim()}
มุมกล้องตรงจากด้านหน้า ระดับสายตา ระยะใกล้ หน้าร้านกว้างเกือบเต็มภาพ (x 20–${b.W - 20}) ไม่ถอยไกล ภาพแนบคือแอดที่ผ่านแล้ว ให้ทำระยะภาพ สเกลคน และองค์ประกอบใกล้เคียง
ตำแหน่ง (ภาพ ${b.W}x${b.H}) ทั้งหลังคา แผงโซลาร์ ร้าน และคนทั้งสองเต็มตัว ต้องอยู่ในช่วง y ${b.top + 280}–${b.bottom - 10} เพราะแอดจะถูกครอปเป็นสี่เหลี่ยมจัตุรัส y ${b.top}–${b.bottom}:
1. y 0–${b.skyClear[1]}: ท้องฟ้าน้ำเงินสด แดดจ้า ช่วง y ${b.skyClear[0]}–${b.skyClear[1]} โล่ง ไม่มีของ ไม่มีเมฆหนา ไม่มีดวงอาทิตย์หรือแสงแฟลร์ในภาพ ท้องฟ้าไล่เฉดน้ำเงินเท่านั้น (วางพาดหัว และพระอาทิตย์จะวางทีหลัง)
2. y ${b.panels[0]}–${b.panels[1]}: แผงโซลาร์ 2 แผงบนหลังคาเห็นชัด
3. y ${b.eave[0]}–${b.eave[1]}: ขอบหลังคาสีขาวเรียบ ไม่มีตัวหนังสือ
4. y ${b.shop[0]}–${b.shop[1]}: หน้าร้านกระจกใสบานเลื่อน "ปิดสนิท" ทั้งแถว กรอบอะลูมิเนียมบาง เห็นภายในชัด ห้ามเปิดโล่ง ร้านตื้น ผนังด้านหลังห่างกระจกไม่เกิน 3 เมตร คนยืนใกล้กระจก
   - ใต้ฝ้ากลางร้าน x ${ax0}–${ax1}, y ${ay0}–${ay1} เป็นผนังขาวเรียบว่างเปล่า ไม่มีโคมไฟ ไม่มีของ ไม่มีแอร์ (จะวางแอร์จริงกว้างราว 400px ตรงนี้)
   - คนเห็นเต็มตัวใต้โซนแอร์ หัวอยู่ราว y ${b.peopleHeadY} เท้าอยู่ราว y ${b.floor} ตัวใหญ่ชัด (สูงราว 550–600px) ไม่บังโซนแอร์ สองคนหน้าตาและรูปร่างต่างกันชัดเจน
5. y ${b.yard[0]}–${b.yard[1]}: ลานปูนหน้าร้านและทางเท้า ไม่มีคนหรือของสำคัญ (ส่วนนี้ถูกครอป)
6. ด้านขวามีเสาไฟฟ้าคอนกรีตกับสายไฟเข้าร้านบางส่วน
7. ในร้านเย็นชัด แสงขาวอมฟ้า กระจกมีไอเย็นจางๆ ขอบล่าง ข้างนอกแดดร้อนจ้า ธีมน้ำเงิน Tasaki น้ำเงิน ฟ้า ขาว เงิน เทา ต้นไม้เขียวน้อยมาก
8. ภาพถ่ายจากกล้องจริง สีธรรมชาติ ไม่ HDR ไม่สดจัด ผิวคนมีรายละเอียดจริง มือนิ้วครบ สัดส่วนจริง
9. ห้ามมีตัวหนังสือ โลโก้ ป้ายร้าน แอร์ ช่องลม หรือกราฟิกใดๆ ในภาพ`;
}

// The size to ask image_gen for: the master's exact aspect ratio, both edges a
// multiple of 16 (gpt-image-2's rule) and never smaller than the master, so
// the picture comes out the right shape and is only scaled, never cropped.
export function genSize([w, h]) {
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const g = gcd(w, h);
  const bw = (w / g) * 16;
  const bh = (h / g) * 16;
  const m = Math.ceil(Math.max(w / bw, h / bh));
  return [bw * m, bh * m];
}
