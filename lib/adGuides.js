// Check-only layers every ad file starts with (her rule, 2026-10-28): crop lines
// and a Story/Reel UI simulation, both hidden (eye off), locked and
// non-printing, so nothing leaks into an export but she can switch them on
// to see what the crops cut and what the app UI covers.

const RED = '#FF2B2B';
const FONT = { font: 'Frutiger Neue LT Pro', style: 'Bold' };

const rect = (x, y, width, height, radius) => ['shape.rectangle', { x, y, width, height, ...(radius ? { radius } : {}) }];
const ellipse = (x, y, width, height) => ['shape.ellipse', { x, y, width, height }];
const fill = (color) => ['paint.setFill', color ? { color } : { none: true }];
const stroke = (color, weight) => (color
  ? [['paint.setStroke', { color }], ['stroke.set', { weight }]]
  : [['paint.setStroke', { none: true }]]);
const opacity = (value) => ['transparency.set', { opacity: value }];
const lock = () => ['layer.setProps', { visible: false, locked: true, printable: false }];

// A shape with its paint, opacity and optional outline.
function shape(make, { color, outline, alpha, dash }) {
  return [
    make,
    fill(color),
    ...stroke(outline, outline ? 3 : 0),
    ...(dash ? [['stroke.set', { dash }]] : []),
    ...(alpha ? [opacity(alpha)] : []),
  ];
}

function cropLines(frame) {
  const colors = ['#00E5FF', '#FF2BD6'];
  const steps = [];
  (frame.crops || []).forEach((c, i) => {
    const [x, y, w, h] = c.rect;
    const color = colors[i % colors.length];
    steps.push(
      ...shape(rect(x + 4, y, w - 8, h), { outline: color, dash: [14, 8] }),
      ['text.create', { x: x + 24, y: y + 52, text: c.name.replace('x', ':'), size: 40, ...FONT, color }],
    );
  });
  return steps;
}

// Approximate Meta Story/Reel chrome on a 1080x1920 canvas.
function storyReel(frame) {
  const [w, h] = frame.size;
  if (w !== 1080 || h !== 1920) return [];
  const zone = { color: RED, alpha: 22 };
  const mark = { color: RED, outline: '#FFFFFF', alpha: 65 };
  const rail = [1088, 1248, 1408, 1568];
  return [
    ...shape(rect(0, 0, 1080, 250), zone),
    ...shape(ellipse(30, 128, 88, 88), mark),
    ...shape(rect(132, 152, 220, 40, 20), { color: RED, alpha: 50 }),
    ...shape(ellipse(980, 142, 60, 60), mark),
    ...shape(rect(0, 1670, 1080, 250), zone),
    ...shape(rect(330, 1745, 420, 96, 48), mark),
    ...shape(rect(920, 1060, 160, 740), { color: RED, alpha: 18 }),
    ...shape(rect(30, 1560, 800, 110, 16), { color: RED, alpha: 18 }),
    ...rail.flatMap((y) => shape(ellipse(943, y, 84, 84), mark)),
    ...shape(rect(950, 1700, 70, 70, 14), mark),
    ['text.create', { x: 380, y: 150, text: 'Story/Reel: โปรไฟล์ ปุ่มปิด (หลบ)', size: 30, ...FONT, color: '#FFFFFF' }],
    ['text.create', { x: 345, y: 1866, text: 'ปุ่ม CTA / แคปชัน (หลบ)', size: 30, ...FONT, color: '#FFFFFF' }],
  ];
}

// Steps to append to an ad document: each guide on its own layer, on top.
export function guideSteps(frame) {
  const out = [];
  const crops = cropLines(frame);
  if (crops.length) out.push(['layer.new', { name: 'เส้นครอป (ไม่พิมพ์)', top: true }], ...crops, lock());
  const sim = storyReel(frame);
  if (sim.length) out.push(['layer.new', { name: 'จำลอง Story/Reel UI (ไม่พิมพ์)', top: true }], ...sim, lock());
  return out;
}
