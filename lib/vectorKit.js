// Her approved building blocks for ads: the vector kit (Tasaki blades,
// badges, logos) and the text-style templates. Both the image pipeline and
// ประกอบ's edits place them from here instead of drawing their own.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const KIT_DIR = path.join(ROOT, 'design-assets', 'vector-kit');
const KIT_FOLDERS = ['shapes', 'badges', 'logos', 'labels', 'icons'];
// Group-company logos are not Tasaki ad material (vector-kit README).
const NOT_FOR_ADS = /^logos\/bitwise-/;

// The templates in ad-text-styles (her picks, 2026-10-27). The two marked
// "✗ ไม่ผ่าน" there are left out on purpose.
export const TEXT_STYLE_LIBRARY = path.join(ROOT, 'public', 'uploads', 'agent-images', 'ad-text-styles', 'style-01-crisp-extrude.vectorcraft');
export const TEXT_LIBRARY_NAME = 'Tasaki Text';
export const TEXT_STYLES = {
  'glow-web': { name: 'Tasaki Glow – น้ำเงินหน้าเว็บ', note: 'น้ำเงินไล่ฟ้า เรืองแสงอ่อน (อนุมัติแล้ว) พื้นสว่าง' },
  'glow-navy': { name: 'Tasaki Glow – น้ำเงินเข้ม', note: 'น้ำเงินเข้ม เรืองแสงอ่อน พื้นสว่าง' },
  'extrude-white-silver': { name: 'Tasaki Extrude – ขาวเงิน', note: 'ขาวเงิน มีความหนาน้ำเงิน ขอบขาว บนฟ้า/ภาพ' },
  'extrude-silver': { name: 'Tasaki Extrude – เงินล้วน', note: 'เงินล้วน มีความหนา บนฟ้า/ภาพ' },
  'extrude-cyan': { name: 'Tasaki Extrude – ฟ้าซีอัน', note: 'ฟ้าซีอัน มีความหนา ขอบขาว' },
  'chrome': { name: 'Tasaki Chrome – สมจริง', note: 'โครเมียมสมจริง เหมาะพื้นเข้ม/กลางคืน' },
  'frost-ice': { name: 'Tasaki Frost – ขาวน้ำแข็ง', note: 'ขาวน้ำแข็ง ขอบน้ำเงิน สื่อความเย็น' },
  'frost-cyan': { name: 'Tasaki Frost – ฟ้าซีอัน', note: 'ฟ้าซีอันแบบน้ำแข็ง' },
  'sticker-blue': { name: 'Tasaki Sticker – ไล่ฟ้า (เล็ก)', note: 'สติกเกอร์ไล่ฟ้า สำหรับข้อความรองตัวเล็ก' },
  'extrude-orange': { name: 'Tasaki Extrude – ส้ม', note: 'ส้ม ไม่ใช่สีแบรนด์ ใช้เฉพาะคำที่ต้องเรียกความสนใจจริงๆ' },
};

const PNG_SIZE = (buf) => [buf.readUInt32BE(16), buf.readUInt32BE(20)];
function naturalSize(file) {
  if (file.endsWith('.svg')) {
    const m = /viewBox="\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)/.exec(fs.readFileSync(file, 'utf8').slice(0, 4000));
    return m ? [Number(m[1]), Number(m[2])] : null;
  }
  if (file.endsWith('.png')) return PNG_SIZE(fs.readFileSync(file));
  return null;
}

// Every placeable piece: "shapes/tasaki-blade-kit/blade-gradient.svg" with its natural size.
export function kitCatalog() {
  const out = [];
  const walk = (rel) => {
    const dir = path.join(KIT_DIR, rel);
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(r);
      else if (/\.(svg|png)$/.test(e.name) && !NOT_FOR_ADS.test(r)) {
        const size = naturalSize(path.join(KIT_DIR, r));
        if (size) out.push({ file: r, w: size[0], h: size[1] });
      }
    }
  };
  KIT_FOLDERS.forEach(walk);
  // A piece that also has an .svg is offered once, as the vector.
  return out.filter((p) => !(p.file.endsWith('.png') && out.some((q) => q.file === p.file.replace(/\.png$/, '.svg'))));
}

// "shapes/x.svg" → absolute path, only inside the kit.
export function kitFile(rel) {
  if (typeof rel !== 'string' || !/^[a-z0-9][\w./-]*\.(svg|png)$/i.test(rel) || rel.includes('..')) throw new Error(`ไม่มีชิ้น ${rel} ในคลัง`);
  const file = path.join(KIT_DIR, rel);
  if (!fs.existsSync(file) || !fs.realpathSync(file).startsWith(fs.realpathSync(KIT_DIR) + path.sep) || NOT_FOR_ADS.test(rel)) throw new Error(`ไม่มีชิ้น ${rel} ในคลัง`);
  return file;
}

// Kit pieces never get stretched: the height follows the width.
export function fitRect(rel, rect) {
  const size = naturalSize(kitFile(rel));
  const [x, y, w] = rect.map(Number);
  return [Math.round(x), Math.round(y), Math.round(w), Math.round(w * (size[1] / size[0]))];
}

// Steps that style the type object just created (it is the selection):
// group it, then give the group the template's graphic style, as in the
// template file (on the bare type only the top fill shows).
export function textStyleSteps(key) {
  const style = TEXT_STYLES[key];
  if (!style) return null;
  return [['object.group', {}], ['graphicStyle.addFromLibrary', { library: TEXT_LIBRARY_NAME, name: style.name, apply: true }]];
}
export const loadTextStylesStep = (file = TEXT_STYLE_LIBRARY) => ['graphicStyle.loadLibrary', { path: file, name: TEXT_LIBRARY_NAME }];

// For a model-written edit: {kit} / {library: "tasaki-text"} become real
// paths, copied next to the document so the live window (which may only read
// the team's folder) can open them.
export function materializeStep(step, workDir) {
  const copy = (src) => {
    const dest = path.join(workDir, 'kit', path.basename(src));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (!fs.existsSync(dest)) fs.copyFileSync(src, dest);
    return dest;
  };
  if (step.command === 'file.place' && step.params.kit) {
    const { kit, ...rest } = step.params;
    return { ...step, params: { link: false, ...rest, path: copy(kitFile(kit)), ...(rest.rect ? { rect: fitRect(kit, rest.rect) } : {}) } };
  }
  if (step.command === 'graphicStyle.loadLibrary' && step.params.library === 'tasaki-text') {
    return { ...step, params: { path: copy(TEXT_STYLE_LIBRARY), name: TEXT_LIBRARY_NAME } };
  }
  return step;
}

// What a planner needs to choose from, in one block of text.
export function kitNote() {
  const pieces = kitCatalog().map((p) => `${p.file} (${p.w}x${p.h})`).join(', ');
  const styles = Object.entries(TEXT_STYLES).map(([k, s]) => `${k} = ${s.note}`).join(' · ');
  return `ชิ้นจากคลังของหนิง (วางจริงได้ สัดส่วนคงเดิม ความสูงคิดจากความกว้างให้เอง): ${pieces}\nสไตล์ตัวอักษรแม่แบบที่หนิงอนุมัติ: ${styles}`;
}
