// Inverter vs Non-Inverter — 45s, 9:16, built for EffectCraft.
// Run: effectcraft-cli script build.jsx --empty --save-as inverter-vs-non-45s.ecproj
// Same design system as remotion-clips (Tasaki Blue top / charcoal bottom, silver VS badge,
// silver divider, snap-in motion). Safe zone for TikTok / Reels / Shorts: top 20%, bottom 25%,
// left 5%, right 18.5% (clears the like/comment/share rail) -> content box x 54-880, y 384-1440.

var A = "/Users/marketingengineer/marketing-dashboard/effectcraft-clips/assets/";
var W = 1080, H = 1920, FPS = 30, DUR = 45, F = 1 / FPS;
var FONT_B = "FrutigerNeueLTPro-Bold", FONT_R = "FrutigerNeueLTPro-Regular";
var WHITE = [1, 1, 1], CYAN = hex("#8FE3FF"), SILVER = hex("#C8D8E8"), TOPIC = hex("#D6F1FF");

var SAFE = { l: 54, r: 880, t: 384, b: 1440 };

// Layout (px). Labels sit just clear of the 160px VS badge; each half's content block lives between.
var TOP_Y = 650, BOT_Y = 1270, ICON_X = 150, ICON_PX = 180, TEXT_X = 270;

function hex(h) { return [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255]; }
function tr(L, n) { return L.property("ADBE Transform Group").property(n); }
function span(L, a, b) { L.inPoint = a; L.outPoint = b; return L; }
var footage = {};
function imp(n) { return footage[n] || (footage[n] = app.project.importFile(new ImportOptions(new File(A + n)))); }

app.beginUndoGroup("Build Inverter vs Non-Inverter");
var comp = app.project.items.addComp("InverterVsNon_45s", W, H, 1, DUR, FPS);

function solid(name, color, w, h, x, y) {
  var L = comp.layers.addSolid(color, name, w, h, 1);
  tr(L, "ADBE Position").setValue([x, y]);
  return L;
}
function ramp(L, c1, c2, w, h) {
  var fx = L.property("ADBE Effect Parade").addProperty("ADBE Ramp");
  fx.property(1).setValue([0, 0]); fx.property(2).setValue(hex(c1));
  fx.property(3).setValue([w, h]); fx.property(4).setValue(hex(c2));
}
function image(name, x, y, scale) {
  var L = comp.layers.add(imp(name));
  tr(L, "ADBE Position").setValue([x, y]);
  tr(L, "ADBE Scale").setValue([scale, scale]);
  return L;
}
function text(str, o) {
  var L = comp.layers.addText(str);
  var p = L.property("ADBE Text Properties").property("ADBE Text Document");
  var td = p.value;
  td.font = o.bold === false ? FONT_R : FONT_B; td.fontSize = o.size; td.fillColor = o.color || WHITE;
  td.applyStroke = false;
  td.justification = o.left ? ParagraphJustification.LEFT_JUSTIFY : ParagraphJustification.CENTER_JUSTIFY;
  if (o.tracking) td.tracking = o.tracking;
  if (o.leading) { td.autoLeading = false; td.leading = o.leading; }
  p.setValue(td);
  // Shrink to fit the safe box (centred text keeps its centre, so the narrower right side limits it).
  var max = o.left ? SAFE.r - o.x : 2 * Math.min(o.x - SAFE.l, SAFE.r - o.x), w = L.sourceRectAtTime(0, false).width;
  if (w > max) { td = p.value; td.fontSize = Math.floor(o.size * max / w); if (o.leading) td.leading = Math.floor(o.leading * max / w); p.setValue(td); }
  tr(L, "ADBE Position").setValue([o.x, o.y]);
  return L;
}

// --- motion: everything snaps in within 8 frames, no slow fades -------------------------------
function pop(L, t0) { // scale 0 -> 108% -> 100% in 8 frames
  var s = tr(L, "ADBE Scale"), v = s.value;
  s.setValueAtTime(t0, [0, 0]);
  s.setValueAtTime(t0 + 5 * F, [v[0] * 1.08, v[1] * 1.08]);
  s.setValueAtTime(t0 + 8 * F, v);
}
function rise(L, t0, delay) { // label/text: quick opacity + 24px lift, frames delay..delay+6
  var o = tr(L, "ADBE Opacity"), p = tr(L, "ADBE Position"), v = p.value, a = t0 + delay * F, b = a + 6 * F;
  o.setValueAtTime(a, 0); o.setValueAtTime(b, 100);
  p.setValueAtTime(a, [v[0], v[1] + 24]); p.setValueAtTime(b, v);
}
function blurToSharp(L, t0) { // fast blur-to-sharp, frames 14-24
  var fx = L.property("ADBE Effect Parade").addProperty("ADBE Gaussian Blur 2");
  fx.property(1).setValueAtTime(t0 + 14 * F, 18); fx.property(1).setValueAtTime(t0 + 24 * F, 0);
}

// --- persistent background ----------------------------------------------------------------------
ramp(solid("BG Inverter", WHITE, W, H / 2, W / 2, H / 4), "#0074A2", "#005A82", W, H / 2);
ramp(solid("BG Non-Inverter", WHITE, W, H / 2, W / 2, H * 3 / 4), "#0E1520", "#222E40", W, H / 2);

// One comparison scene: topic + icon/main/sub per half.
function scene(t0, t1, topic, inv, non) {
  var tp = span(text(topic, { size: 50, color: TOPIC, x: W / 2, y: 440 }), t0, t1); rise(tp, t0, 0);
  half(t0, t1, inv, TOP_Y, "white", WHITE);
  half(t0, t1, non, BOT_Y, "silver", SILVER);
}
function half(t0, t1, d, cy, variant, sub) {
  var ic = span(image(d.icon + "_" + variant + ".png", ICON_X, cy, ICON_PX / 480 * 100), t0, t1); pop(ic, t0);
  if (d.iconExpr) tr(ic, d.iconExpr[0]).expression = d.iconExpr[1];
  var m = span(text(d.main, { size: 84, left: true, x: TEXT_X, y: cy - 8 }), t0, t1); rise(m, t0, 2);
  var s = span(text(d.sub, { size: 40, bold: false, color: sub, left: true, leading: 52, x: TEXT_X, y: cy + 56 }), t0, t1); rise(s, t0, 4);
  return ic;
}

var PULSE = "var m = 1 + 0.07 * Math.abs(Math.sin(time * 9)); [value[0] * m, value[1] * m]";
var SOFT = "var m = 1 + 0.03 * Math.sin(time * 3); [value[0] * m, value[1] * m]";

// 1) Intro 0-6s: real product photos (each photo is the variant it's labelled as) + logo
var S1 = 0, S2 = 6, S3 = 13, S4 = 19.5, S5 = 26, S6 = 32.5, S7 = 39;
var logo = span(image("tasaki-logo-white.png", W / 2, 418, 64 / 252 * 100), S1, S2); pop(logo, S1);
var hook = span(text("แอร์ 2 แบบ เลือกแบบไหนดี?", { size: 50, color: TOPIC, x: W / 2, y: 520 }), S1, S2); rise(hook, S1, 0);
var pi = span(image("Inverter.png", W / 2, 676, 620 / 2792 * 100), S1, S2); pop(pi, S1); blurToSharp(pi, S1);
var pn = span(image("non-inverter.png", W / 2, 1270, 680 / 2441 * 100), S1, S2); pop(pn, S1); blurToSharp(pn, S1);

// 2) How it runs 6-13s: rotor graphic (generic compressor motion, no product photo)
scene(S2, S3, "คอมเพรสเซอร์ทำงานต่างกันยังไง", {
  icon: "rotor", main: "หมุนต่อเนื่อง", sub: "ช้า-เร็ว ปรับตาม\nอุณหภูมิห้อง",
  iconExpr: ["ADBE Rotate Z", "var t = time - inPoint; value + t * 300 + 120 * Math.sin(t * 1.6)"]
}, {
  icon: "rotor", main: "เปิด-ปิดเป็นรอบ", sub: "หมุนเต็มกำลัง → หยุด\n→ หมุนใหม่",
  iconExpr: ["ADBE Rotate Z", "var t = time - inPoint, p = 1.8, on = 1.1, n = Math.floor(t / p); value + (n * on + Math.min(t - n * p, on)) * 900"]
});

// 3-6) Comparison scenes — approved copy from the Remotion series, neutral framing
scene(S3, S4, "ราคา & ค่าไฟ",
  { icon: "bolt", main: "ลงทุนสูงกว่า", sub: "แต่ค่าไฟถูกลง\nในระยะยาว" },
  { icon: "tag", main: "ราคาเข้าถึงง่าย", sub: "ติดตั้งง่าย\nไม่ซับซ้อน" });
scene(S4, S5, "เรื่องเสียง",
  { icon: "quiet", main: "เงียบกว่า", sub: "ทำงานต่อเนื่อง\nนุ่มนวล ไม่รบกวน", iconExpr: ["ADBE Scale", SOFT] },
  { icon: "loud", main: "ได้ยินตอนสตาร์ท", sub: "เสียงมอเตอร์เมื่อเริ่ม\nทำงานเต็มกำลัง", iconExpr: ["ADBE Scale", PULSE] });
scene(S5, S6, "เหมาะกับการใช้งานแบบไหน",
  { icon: "moon", main: "เปิดทั้งวัน", sub: "หรือเปิดตลอดคืน\nยิ่งใช้นาน ยิ่งคุ้ม" },
  { icon: "clock", main: "วันละ 3-4 ชม.", sub: "ใช้ไม่นาน ก็ประหยัดได้\nไม่ต้องลงทุนสูง" });
scene(S6, S7, "การดูแลรักษา",
  { icon: "chip", main: "ช่างเฉพาะทาง", sub: "เทคโนโลยีสูง\nแนะนำให้ดูแลพิเศษ" },
  { icon: "wrench", main: "ซ่อมง่ายทั่วไป", sub: "ระบบเรียบง่าย\nหาช่างได้ทุกที่" });

// 7) Outro 39-45s: both products again, which one suits you — no winner
var oq = span(text("เลือกแบบที่ใช่ สำหรับคุณ", { size: 50, color: TOPIC, x: W / 2, y: 440 }), S7, DUR); rise(oq, S7, 0);
var oi = span(image("Inverter.png", W / 2, 610, 600 / 2792 * 100), S7, DUR); pop(oi, S7);
var ot = span(text("ใช้นาน ใช้บ่อย  →  INVERTER", { size: 54, color: CYAN, x: W / 2, y: 812 }), S7, DUR); rise(ot, S7, 3);
var on = span(image("non-inverter.png", W / 2, 1200, 640 / 2441 * 100), S7, DUR); pop(on, S7);
var ob = span(text("ใช้เป็นช่วง ๆ  →  NON-INVERTER", { size: 54, color: SILVER, x: W / 2, y: 1395 }), S7, DUR); rise(ob, S7, 3);

// Persistent INVERTER / NON-INVERTER labels (scenes 1-6)
var li = span(text("INVERTER", { size: 40, color: CYAN, tracking: 200, x: W / 2, y: 862 }), 0, S7); rise(li, 0, 4);
var ln = span(text("NON-INVERTER", { size: 40, color: SILVER, tracking: 200, x: W / 2, y: 1090 }), 0, S7); rise(ln, 0, 4);

// Silver divider with a pulsing glow, then the VS badge on top of everything
var dv = solid("Silver Divider", hex("#F0F4F8"), W, 4, W / 2, H / 2);
tr(dv, "ADBE Opacity").expression = "75 + 25 * Math.sin(time * 4)";
dv.property("ADBE Effect Parade").addProperty("ADBE Glo2");
var vs = image("vs.png", W / 2, H / 2, 50); pop(vs, 0);

app.endUndoGroup();

// Check every content layer against the safe box (backgrounds, divider and VS badge may bleed).
var bad = [];
for (var i = 1; i <= comp.numLayers; i++) {
  var L = comp.layer(i);
  if (/^BG |^Silver Divider$|^vs\.png$/.test(L.name)) continue;
  var t = L.inPoint + 0.5, r = L.sourceRectAtTime(t, false), p = tr(L, "ADBE Position").valueAtTime(t, false),
      sc = tr(L, "ADBE Scale").valueAtTime(t, false), an = tr(L, "ADBE Anchor Point").valueAtTime(t, false);
  var x0 = p[0] + (r.left - an[0]) * sc[0] / 100, y0 = p[1] + (r.top - an[1]) * sc[1] / 100;
  var x1 = x0 + r.width * sc[0] / 100, y1 = y0 + r.height * sc[1] / 100;
  if (x0 < SAFE.l || x1 > SAFE.r || y0 < SAFE.t || y1 > SAFE.b)
    bad.push(L.name + " [" + [x0, y0, x1, y1].map(Math.round).join(",") + "]");
}
comp.name + ": " + comp.numLayers + " layers; outside safe box: " + (bad.length ? bad.join("; ") : "none");
