// The "shop blueprint" ad built from her final barbershop file (2026-10-28).
// Instead of re-drawing the headline, sun, airflow, badges, bill and label for
// every ad, the approved file is the template: a copy is opened headless and
// only what changes per ad is swapped — the scene, the real AC photo, the
// model name, and the glass reflection cut from the new scene. Everything she
// approved (split headline with the slash, sun, vector airflow, pills with
// icons, bill, No.5 label, blades, logo, hidden guide layers) stays as made.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const PY = '/usr/bin/python3';
// Where the AC sits in the template, the same as the scene brief reserves.
// Real size, not a fixed 37%: a wall unit is about 0.9 m wide and the shop front
// about 5-6 m, so on this canvas it is roughly 230 px; a ceiling-hung unit is longer.
const AC = { centerX: 552, top: 872, minH: 50, maxH: 130, templateVent: 946, headSafeY: 1040 };
const widthFor = (model) => (/^FWCE|^FWDE/.test(model) ? 230 : /^FUNE|^FFSE/.test(model) ? 300 : 270);
const GLASS = [355, 842, 393, 318];
const MULLION_Y = [842, 1600];
const TEMPLATE_MODEL = 'FUNE-I-AF2 Solar Hybrid';

// The headline stays exactly as approved. These change the composition around
// it so ads of one campaign don't look copied (her words, 2026-10-28):
// where the sun, the bill and the No.5 label sit, and which way the blades go.
// to: [centre x, centre y]; every spot keeps clear of the Story/Reel UI zones.
const SUN_DISC = [855, 450];
export const VARIANTS = [
  { key: 'sun-left', sun: { to: [190, 380] }, bill: { to: [265, 1330], rotate: 12 }, label: { to: [800, 1390] }, mirrorBlades: true },
  { key: 'sun-right-low', sun: { to: [905, 330], scale: 110 }, bill: { to: [215, 1310], rotate: -10, scale: 92 }, label: { to: [455, 1470] }, tiltBlade: 9 },
];

export const templateDoc = (root) => path.join(root, 'public', 'uploads', 'agent-images', 'barber-solar-ad', 'barber-solar.vectorcraft');

const py = (code, ...args) => execFileSync(PY, ['-c', code, ...args.map(String)], { cwd: '/' }).toString();

// The real product photo cropped to its visible pixels → [width, height].
export function trimProduct(src, out) {
  return JSON.parse(py(`import sys,json
from PIL import Image
im=Image.open(sys.argv[1]).convert('RGBA')
bb=im.getchannel('A').getbbox() or (0,0,im.width,im.height)
im=im.crop(bb);im.save(sys.argv[2]);print(json.dumps([im.width,im.height]))`, src, out));
}

// Where the AC goes: the template's width, top edge and centre, any aspect.
// A taller unit hangs lower, so the airflow moves down with its vent.
export function acRect([w, h], model = '') {
  const height = Math.min(AC.maxH, Math.max(AC.minH, widthFor(model) / (w / h)));
  const width = height * (w / h);
  return [Math.round(AC.centerX - width / 2), AC.top, Math.round(width), Math.round(height)];
}

// The reflection laid over the AC is cut from the new scene itself, and the
// door frame down the middle is found as the strongest vertical edge pair.
export function glassAssets(bg, dir) {
  const crop = path.join(dir, 'glass-over-ac.png');
  const mullion = path.join(dir, 'door-mullion.png');
  const found = JSON.parse(py(`import sys,json
import numpy as np
from PIL import Image
im=Image.open(sys.argv[1]).convert('RGB')
x,y,w,h=map(int,sys.argv[3:7]); y0,y1=int(sys.argv[7]),int(sys.argv[8])
im.crop((x,y,x+w,y+h)).save(sys.argv[2])
g=np.asarray(im.convert('L')).astype(float)
edge=np.abs(np.diff(g[900:1400,380:720],axis=1)).mean(axis=0)
k=np.ones(12); score=np.convolve(edge,k,mode='valid')
c=int(score.argmax()); conf=float(score.max()/(np.median(score)+1e-6))
cx=380+c+6
if conf>=3.0:
    im.crop((cx-5,y0,cx+6,y1)).save(sys.argv[9])
print(json.dumps({'x':cx,'confidence':round(conf,2),'ok':conf>=3.0}))`, bg, crop, ...GLASS, ...MULLION_Y, mullion));
  return { crop, mullion: found.ok ? mullion : null, mullionX: found.x, confidence: found.confidence };
}

const lines = (stdout) => stdout.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const find = (name, kind) => ['document.find', { name, ...(kind ? { kind } : {}), limit: 5 }];
const cli = (bin, template, steps, extra = []) => ['run', '--in', template, ...steps.flatMap(([id, p]) => ['--cmd', id, '--params', JSON.stringify(p || {})]), ...extra];

// The new ad's document + PNG from the template. runProcess is the caller's
// (so it logs and times out like every other child process there).
// inPlace: the job's own document already exists, so it is opened and edited and
// saved back to the same path (never rebuilt, never a new name); the airflow and
// composition are left as they are so repeated runs don't compound.
export async function buildFromTemplate({ bin, runProcess, template, doc, png, bg, product, model, dir, variant = null, inPlace = false }) {
  if (inPlace) { template = doc; variant = null; }
  if (!fs.existsSync(template)) throw new Error('ไม่พบไฟล์แบบอ้างอิง (barber-solar.vectorcraft)');
  const trimmed = path.join(dir, 'ac-trimmed.png');
  const acBox = acRect(trimProduct(product, trimmed), model);
  const glass = glassAssets(bg, dir);

  // Phase 1: ids by name (they are stable in the file but not assumed).
  const names = [find('scene.png'), find('ac-front.png'), find('glass-over-ac.png'), find('door-mullion.png'), find(TEMPLATE_MODEL, 'Type'), find('ไม่พิมพ์'), find('ลมเย็นฟุ้ง (เวกเตอร์)', 'Layer'), find('tasaki-blue-0074A2.png'), find('sun.svg'), find('bill.png'), find('label-no5.png'), find('blade-gradient.svg'), find('blade-cyan-fade.svg')];
  const p1 = await runProcess(bin, cli(bin, template, names), { cwd: dir });
  const got = lines(p1.stdout).filter((l) => l.command === 'document.find').map((l) => l.result?.matches || []);
  const one = (i) => got[i]?.[0];
  const [scene, ac, glassImg, door, modelText] = [0, 1, 2, 3, 4].map(one);
  if (!scene || !ac || !modelText) throw new Error('แบบอ้างอิงขาดชิ้นส่วนที่ต้องเปลี่ยน (ฉาก/แอร์/ชื่อรุ่น)');
  const guides = (got[5] || []).filter((m) => m.kind === 'Layer').map((m) => m.id);
  const airflow = (got[6] || []).find((m) => m.kind === 'Layer');
  const acLogo = (got[7] || [])[0]; // the logo printed on the template's own AC photo
  const part = { sun: got[8]?.[0], bill: got[9]?.[0], label: (got[10] || []).find((m) => m.path?.[0] === 8) || got[10]?.[0], blade: got[11]?.[0], fade: got[12]?.[0] };
  const compose = [];
  if (variant && part.sun) {
    // Current centres, so every move is relative whatever the template was left like.
    const pn = await runProcess(bin, cli(bin, template, ['sun', 'bill', 'label'].map((k) => ['document.node', { id: part[k].id, summary: true, depth: 0 }])), { cwd: dir });
    const nodes = lines(pn.stdout).filter((l) => l.command === 'document.node').map((l) => l.result);
    const at = { sun: nodes[0], bill: nodes[1], label: nodes[2] };
    const centre = (n) => [n.bounds.x + n.bounds.width / 2, n.bounds.y + n.bounds.height / 2];
    for (const k of ['sun', 'bill', 'label']) {
      const v = variant[k]; if (!v || !at[k]?.bounds) continue;
      // The sun's bounds include its long rays, so the disc is located by its known spot.
      const [cx, cy] = k === 'sun' ? SUN_DISC : centre(at[k]);
      compose.push(['select.set', { ids: [part[k].id] }]);
      if (v.scale) compose.push(['object.scale', { sx: v.scale, sy: v.scale, origin: [cx, cy] }]);
      if (v.rotate) compose.push(['object.rotate', { angle: v.rotate, origin: [cx, cy] }]);
      compose.push(['object.move', { dx: Math.round(v.to[0] - cx), dy: Math.round(v.to[1] - cy) }]);
    }
    if (variant.mirrorBlades) for (const k of ['blade', 'fade']) if (part[k]) compose.push(['select.set', { ids: [part[k].id] }], ['object.scale', { sx: -100, sy: 100, origin: [540, 1700] }]);
    if (variant.tiltBlade && part.fade) compose.push(['select.set', { ids: [part.fade.id] }], ['object.rotate', { angle: variant.tiltBlade, origin: [540, 1700] }]);
    compose.push(['select.none', {}]);
  }

  // Phase 2: swap what changes, hide the guides, save, export.
  const steps = [];
  for (const id of guides) steps.push(['layer.setProps', { id, visible: false, locked: true, printable: false }]);
  steps.push(
    ['layer.setProps', { id: scene.path[0], locked: false }], ['edit.clear', { ids: [scene.id] }], ['layer.setCurrent', { id: scene.path[0] }],
    ['file.place', { path: bg, link: false, rect: [0, 0, 1080, 1920] }], ['layer.setProps', { id: scene.path[0], locked: true }],
    ['edit.clear', { ids: [ac.id, ...(acLogo ? [acLogo.id] : [])] }], ['layer.setCurrent', { id: ac.path[0] }],
    ['file.place', { path: trimmed, link: false, rect: acBox }],
    ['effect.apply', { effect: 'adjust.temperatureTint', params: { temperature: 6, tint: 0 } }],
    ['effect.apply', { effect: 'adjust.brightnessContrast', params: { brightness: -6, contrast: -8 } }],
    ['effect.apply', { effect: 'stylize.dropShadow', params: { mode: 'multiply', opacity: 28, x: 0, y: 7, blur: 9, color: '#4A4744' } }],
  );
  // The airflow starts at this unit's vent and stops above the heads: it is
  // moved to the vent and squashed so it never reaches a face.
  const vent = acBox[1] + acBox[3];
  const flowTop = AC.templateVent;
  const keep = Math.max(0.35, Math.min(1, (AC.headSafeY - vent) / 175));
  if (airflow && !inPlace) {
    steps.push(['layer.selectAll', { id: airflow.id }]);
    if (Math.abs(vent - flowTop) > 2) steps.push(['object.move', { dx: 0, dy: vent - flowTop }]);
    if (keep < 1) steps.push(['object.scale', { sx: 100, sy: Math.round(keep * 100), origin: [552, vent] }]);
    steps.push(['select.none', {}]);
  }
  if (glassImg) {
    steps.push(['edit.clear', { ids: [glassImg.id, ...(door ? [door.id] : [])] }], ['layer.setCurrent', { id: glassImg.path[0] }],
      ['file.place', { path: glass.crop, link: false, rect: GLASS }], ['transparency.set', { opacity: 18 }],
      ['effect.apply', { effect: 'stylize.feather', params: { radius: 25 } }]);
    if (glass.mullion) steps.push(['file.place', { path: glass.mullion, link: false, rect: [glass.mullionX - 5, MULLION_Y[0], 11, MULLION_Y[1] - MULLION_Y[0]] }]);
  }
  steps.push(...compose, ['text.setText', { id: modelText.id, text: model }], ['file.saveAs', { path: doc }]);
  const p2 = await runProcess(bin, cli(bin, template, steps, ['--export', png]), { cwd: dir });
  if (p2.code !== 0 || !fs.existsSync(doc) || !fs.existsSync(png)) throw new Error(`ประกอบจากแบบอ้างอิงไม่สำเร็จ ${String(p2.stderr || p2.stdout).slice(-300)}`);
  return { acBox, mullion: glass.mullion ? glass.mullionX : null, confidence: glass.confidence, variant: variant?.key || null };
}
