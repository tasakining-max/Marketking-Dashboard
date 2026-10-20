import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { conversationNote, recentNote } from './agentEngine.js';

// The model (Claude or Codex) proposes editing commands; the server executes only this catalogue on
// a private copy. File operations and scripts are never model-controlled.
export const VECTOR_EDIT_COMMANDS = new Set([
  'select.set', 'select.none', 'object.transform', 'object.move', 'object.scale',
  'object.rotate', 'object.setProps', 'object.raise', 'object.lower',
  'layer.setProps', 'paint.setFill', 'paint.setStroke', 'stroke.set',
  'text.setText', 'text.setRangeStyle', 'text.setParagraphStyle',
  'effect.remove', 'effect.setParams', 'effect.apply',
  'object.arrange.bringToFront', 'object.arrange.bringForward',
  'object.arrange.sendBackward', 'object.arrange.sendToBack',
  'layer.new', 'path.create',
]);

export function validateVectorCommands(commands) {
  if (!Array.isArray(commands) || commands.length > 60) throw new Error('แผนแก้ต้องมีไม่เกิน 60 คำสั่ง');
  return commands.map((step) => {
    if (!VECTOR_EDIT_COMMANDS.has(step?.command)) throw new Error(`ไม่รองรับคำสั่ง ${step?.command}`);
    let params;
    try { params = typeof step.params === 'string' ? JSON.parse(step.params) : step.params; }
    catch { throw new Error('พารามิเตอร์คำสั่งไม่ใช่ JSON'); }
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('พารามิเตอร์คำสั่งต้องเป็น object');
    const check = (value) => {
      if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('ค่าตัวเลขไม่ถูกต้อง');
      if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
        if (['path', 'file', 'url', 'script', '__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('คำสั่งนี้รับเฉพาะการแก้วัตถุในเอกสาร');
        check(item);
      }
    };
    check(params);
    if (step.command === 'path.create' && !params.d && !Array.isArray(params.anchors)) throw new Error('ระบุเส้นโค้งเวกเตอร์ด้วย d หรือ anchors');
    if (step.command === 'effect.apply' && !['stylize.dropShadow', 'stylize.outerGlow', 'stylize.innerGlow', 'blur.gaussianBlur'].includes(params.effect)) throw new Error('เอฟเฟกต์นี้ยังไม่รองรับ');
    return { command: step.command, params };
  });
}

export function resolveVectorFile(root, url) {
  if (typeof url !== 'string' || !url.startsWith('/uploads/agent-images/') || !url.split('?')[0].endsWith('.vectorcraft')) throw new Error('เลือกไฟล์ VectorCraft จากงานของทีมก่อน');
  const file = path.resolve(root, url.split('?')[0].replace(/^\/+/, ''));
  const allowed = fs.realpathSync(path.join(root, 'uploads', 'agent-images')) + path.sep;
  if (!fs.realpathSync(file).startsWith(allowed)) throw new Error('ไฟล์อยู่นอกพื้นที่งานของทีม');
  return file;
}

export function diffVectorSnapshots(before, after) {
  const a = new Map(before.nodes.map((n) => [n.id, n]));
  const b = new Map(after.nodes.map((n) => [n.id, n]));
  const changes = [];
  for (const id of new Set([...a.keys(), ...b.keys()])) {
    const old = a.get(id), next = b.get(id);
    if (JSON.stringify(old) !== JSON.stringify(next)) changes.push({ id, name: next?.name || old?.name, before: old || null, after: next || null });
  }
  if (JSON.stringify(before.artboards) !== JSON.stringify(after.artboards)) changes.push({ name: 'พื้นที่งาน', before: before.artboards, after: after.artboards });
  return changes;
}

function parseSteps(stdout) {
  const rows = stdout.split('\n').filter((s) => s.trim().startsWith('{')).map((s) => JSON.parse(s));
  const failed = rows.find((r) => r.error || r.ok === false || r.result?.error);
  if (failed) throw new Error(`VectorCraft: ${JSON.stringify(failed.error || failed.result.error)}`);
  return rows;
}

const MAX_SELF_CHECKS = 2;

export function createVectorTeaching({ root, prisma, runProcess, cli, runModel, logEvent, live }) {
  const publicRoot = path.join(root, 'public');
  const taskDir = (id) => {
    if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error('รหัสงานไม่ถูกต้อง');
    return path.join(publicRoot, 'uploads', 'agent-images', id);
  };
  const url = (id, name) => `/uploads/agent-images/${id}/${name}`;
  const fileFor = (src) => resolveVectorFile(publicRoot, src);

  async function run(file, commands, output, preview) {
    const args = ['run', '--in', file, ...commands.flatMap((c) => ['--cmd', c.command, '--params', JSON.stringify(c.params)])];
    if (output) args.push('--cmd', 'file.saveAs', '--params', JSON.stringify({ path: output }));
    if (preview) args.push('--export', preview);
    const result = await runProcess(cli(), args, { cwd: path.dirname(file) });
    if (result.code !== 0) throw new Error(`VectorCraft ทำงานไม่สำเร็จ: ${(result.stderr || result.stdout).slice(-700)}`);
    return parseSteps(result.stdout);
  }

  async function snapshot(file) {
    return snapshotWith((commands) => run(file, commands));
  }

  // Same reading, from any source: the CLI on a saved file or the live window.
  async function snapshotWith(read) {
    const rows = await read([{ command: 'document.inspect', params: {} }, { command: 'text.fonts', params: {} }]);
    const tree = rows.find((r) => r.command === 'document.inspect')?.result;
    if (!tree?.layers) throw new Error('อ่านโครงสร้างเอกสารไม่ได้');
    const nodes = [];
    const walk = (items, parent = null) => {
      for (const [order, item] of items.entries()) {
        const { children, ...node } = item;
        nodes.push({ ...node, parent, order });
        if (children) walk(children, node.id);
      }
    };
    walk(tree.layers);
    // Native image nodes contain resource keys, not bitmap bytes. Strip nested
    // children because every child already has its own entry and parent/order.
    const details = nodes;
    if (nodes.length > 500) throw new Error('เอกสารใหญ่เกินโหมดสอน กรุณาใช้ไฟล์ที่มีไม่เกิน 500 วัตถุ');
    if (details.length) {
      const full = await read(details.map((n) => ({ command: 'document.node', params: { id: n.id } })));
      for (const r of full.filter((r) => r.command === 'document.node')) {
        const node = nodes.find((n) => n.id === r.result?.id);
        if (node) {
          const { children, ...kind } = r.result.kind || {};
          node.details = { ...r.result, kind };
        }
      }
    }
    return { artboards: tree.artboards, nodes: nodes.sort((a, b) => a.id - b.id), fonts: rows.find((r) => r.command === 'text.fonts')?.result || [] };
  }

  async function lessons() {
    const tasks = await prisma.agentTask.findMany({ where: { agent: 'assemble', status: 'done' }, orderBy: { decidedAt: 'desc' }, take: 30 });
    return tasks.filter((t) => t.result?.lesson?.rule).map((t) => ({ taskId: t.id, date: t.decidedAt, ...t.result.lesson }));
  }

  async function sourceFile(sourceTaskId) {
    const source = await prisma.agentTask.findUnique({ where: { id: sourceTaskId } });
    if (!source?.result?.document || ['queued', 'running'].includes(source.status)) throw new Error('เลือกงานที่มีไฟล์ VectorCraft และทำเสร็จแล้ว');
    return { source, file: fileFor(source.result.document) };
  }

  // One working file per project: VEC edits it in place round after round
  // and only starts a new one when she picks a different source picture.
  const toUrl = (file) => `/${path.relative(publicRoot, file).split(path.sep).join('/')}`;
  async function projectFile(task) {
    if (task.input?.projectFile) return fileFor(task.input.projectFile);
    // A fix on a job made before projects existed: carry on from its last file.
    if (task.feedback && task.result?.document) {
      const project = fileFor(task.result.document);
      const input = { ...(task.input || {}), projectFile: toUrl(project), sourceRoot: task.input?.sourceTaskId };
      await prisma.agentTask.update({ where: { id: task.id }, data: { input } });
      task.input = input;
      return project;
    }
    // Same source picture as an earlier VEC job: keep using that project
    // (works even after the original source files are gone).
    const existing = (await prisma.agentTask.findMany({ where: { agent: 'assemble' }, orderBy: { createdAt: 'desc' }, take: 50 }))
      .find((t) => t.id !== task.id && t.input?.projectFile && (t.input.sourceRoot === task.input.sourceTaskId || t.id === task.input.sourceTaskId));
    if (existing) {
      const input = { ...(task.input || {}), projectFile: existing.input.projectFile, sourceRoot: existing.input.sourceRoot };
      await prisma.agentTask.update({ where: { id: task.id }, data: { input } });
      task.input = input;
      return fileFor(existing.input.projectFile);
    }
    const { source, file } = await sourceFile(task.input.sourceTaskId);
    let project;
    let sourceRoot = source.id;
    if (source.agent === 'assemble') {
      // Continuing from VEC's own result: that is already the project.
      project = source.input?.projectFile ? fileFor(source.input.projectFile) : file;
      sourceRoot = source.input?.sourceRoot || source.input?.sourceTaskId || source.id;
    } else {
      const earlier = (await prisma.agentTask.findMany({ where: { agent: 'assemble' }, orderBy: { createdAt: 'desc' }, take: 50 }))
        .find((t) => t.id !== task.id && t.input?.sourceRoot === source.id && t.input?.projectFile);
      if (earlier) project = fileFor(earlier.input.projectFile);
      else {
        project = path.join(taskDir(task.id), 'project.vectorcraft');
        fs.copyFileSync(file, project);
      }
    }
    const input = { ...(task.input || {}), projectFile: toUrl(project), sourceRoot };
    await prisma.agentTask.update({ where: { id: task.id }, data: { input } });
    task.input = input;
    return project;
  }

  async function plan(task, before, beforeImage, memory, instructions) {
    if (!before.nodes.length) throw new Error('ไม่พบวัตถุที่แก้ไขได้ในเอกสาร');
    const catalogue = await runProcess(cli(), ['commands'], { cwd: root });
    if (catalogue.code !== 0) throw new Error('อ่านคำสั่ง VectorCraft ไม่ได้');
    const supported = JSON.parse(catalogue.stdout).filter((c) => VECTOR_EDIT_COMMANDS.has(c.id)).map(({ id, params }) => ({ id, params }));
    const agent = {
      speaker: 'assemble', rulesAgent: 'assemble', exactEdit: true, tools: [], images: [beforeImage],
      schema: { type: 'object', properties: {
        summary: { type: 'string' },
        commands: { type: 'array', items: { type: 'object', properties: { command: { type: 'string' }, params: { type: 'string' } }, required: ['command', 'params'] } },
        lesson: { type: 'object', properties: { title: { type: 'string' }, condition: { type: 'string' }, rule: { type: 'string' } }, required: ['title', 'condition', 'rule'] },
      }, required: ['summary', 'commands', 'lesson'] },
      async buildPrompt() { return `คุณคือประกอบ ผู้วางแผนแก้ไฟล์ VectorCraft ตอบภาษาไทย\nเซิร์ฟเวอร์ได้เปิดสำเนาและอ่านโครงสร้างเรียบร้อยแล้ว ข้อมูลด้านล่างเป็นวัตถุจริงของสำเนาที่จะใช้คำสั่งของคุณ ไม่ต้องเปิดไฟล์หรือเรียกเครื่องมือเพิ่ม คุณเพียงคืน commands ใน JSON แล้วเซิร์ฟเวอร์จะดำเนินการบนสำเนาเอง\nคำสั่งผู้สอน: ${instructions}\nดัชนีวัตถุที่ใช้สั่งได้ทันที:\n${JSON.stringify(before.nodes.map(({ id, name, kind, parent, bounds }) => ({ id, name, kind, parent, bounds })))}\nภาพก่อนแก้แนบมาแล้ว รายละเอียดฟอนต์และเอฟเฟกต์ของวัตถุจริง:\n${JSON.stringify(before)}\nบทเรียนที่ผู้ใช้เคยตรวจผ่าน (ใช้เมื่อเงื่อนไขตรง อย่าทำซ้ำจนขนาดสะสม):\n${JSON.stringify(memory)}\nคำสั่งที่ใช้ได้:\n${JSON.stringify(supported)}\nสร้างแผนคำสั่งแก้เฉพาะที่ขอ ห้ามใช้ image_gen หรือสร้างบิตแมปใหม่ แต่สร้าง/แก้เส้นกราฟิกเวกเตอร์ได้ด้วย layer.new และ path.create (d เป็น SVG path data หรือ anchors พร้อม Bézier handles) ไม่แปลงตัวหนังสือเป็นภาพ ไม่เปลี่ยนภาพสินค้าหรือข้อความที่ไม่ได้สั่ง ห้ามใช้ id จากบทเรียนเก่า ให้จับคู่วัตถุจากชื่อและโครงสร้างไฟล์นี้ params เป็น string JSON object ตามคู่มือ ก่อนแก้วัตถุเดิมให้ใช้ select.set ระบุ id แต่ layer.new และ path.create จะเลือกวัตถุใหม่ให้อัตโนมัติ หลังสร้างให้ใช้ paint.setFill/paint.setStroke/stroke.set/object.setProps กับ selection นั้นได้ทันที ห้ามเดา id ของวัตถุใหม่ ห้าม file/script/network commands ถ้าผู้สอนขอเปลี่ยนรูปทรงกราฟิกที่เดิมเป็นบิตแมป เช่น ลมแอร์ ให้เก็บชิ้นเดิมไว้โดย object.setProps visible:false แล้ววาดเวกเตอร์ทดแทนในเลเยอร์ชื่อชัดเจน ห้ามซ่อนเลเยอร์แม่ที่มีวัตถุอื่น กฎของหนิงสำหรับรูปทรงจากภาพอ้างอิง: ห้ามเปลี่ยนสัดส่วนหรือหน้าตารูปทรง ย่อหรือขยายได้ (เท่ากันทั้งสองแกน) หมุนได้ และให้ล้นขอบภาพได้ วางให้อยู่ในพื้นที่ว่างเดิมของชิ้นที่ถูกแทน ห้ามทับสินค้า พาดหัว ชื่อรุ่น หรือหน้าคนเด็ดขาด ถ้าต้องทำรูปทรงให้เหมือนภาพอ้างอิง ให้ไล่พิกัดจุดมุมและจุดกลางของแต่ละขอบจากภาพอ้างอิง ปรับสเกลไปยังกรอบปลายทางในเอกสาร แล้วสร้างด้วย path.create d เป็นเส้นโค้ง C ปิดรูป มุมมนตามภาพ เติมสีตามโทนภาพอ้างอิงด้วย paint.setFill {gradient:{kind,angle,stops}} และเงาด้วย effect.apply stylize.dropShadow ซ่อนรูปทรงเดิมที่ถูกแทนด้วย object.setProps visible:false ลมแอร์ควรเป็นเส้นโค้ง Bézier เปิดหลายสาย เบาบาง โปร่งใส ปลายมน เริ่มกระจายจากช่องจ่ายลมบริเวณกลางสินค้า ไหลลงอย่างนุ่มนวล หลีกเลี่ยงรูปร่างหางปลา การแตกสองแฉก และเส้นพาดหน้า/ข้อความ ถ้าคำสั่งยังทำไม่ได้จริงให้ commands ว่างและบอกเหตุผลใน summary\nlesson เป็นข้อเสนอวิธีทำที่ใช้ซ้ำได้ อธิบายเงื่อนไขและเป้าหมาย ไม่จำ id เฉพาะไฟล์ และยังไม่ถือว่าเรียนรู้จนผู้สอนอนุมัติ`; },
    };
    return (await runModel(agent, { ...task, sessionId: null, feedback: '' })).result;
  }

  // Models guess coordinates badly from pictures, so each attached reference
  // is measured here (outline, gradient, shadow) and handed over as numbers.
  async function measuredShapes(task) {
    const notes = [];
    for (const [i, u] of (task.input?.attachments || []).entries()) {
      const file = path.join(publicRoot, String(u).split('?')[0]);
      if (!file.startsWith(path.join(publicRoot, 'uploads', 'agent-images', 'inputs') + path.sep) || !fs.existsSync(file)) continue;
      try {
        const out = await runProcess('python3', [path.join(root, 'lib', 'traceShape.py'), file], { cwd: root });
        if (out.code !== 0) continue;
        const shape = JSON.parse(out.stdout);
        notes.push(`ภาพอ้างอิงที่ ${i + 1}: รูปทรงวัดจริง กว้าง ${shape.width} สูง ${shape.height} (สัดส่วน ${(shape.width / shape.height).toFixed(2)}:1)\nd = "${shape.d}"\ngradient = ${JSON.stringify(shape.gradient)}${shape.shadow ? '\nมีเงาตกนุ่มด้านล่าง-ขวา' : ''}`);
      } catch { /* a picture that isn't a clean shape just gets no measurements */ }
    }
    if (!notes.length) return '';
    return `\n\nค่าที่ระบบวัดจากภาพอ้างอิงแล้ว (แม่นกว่าการกะด้วยตา ใช้ค่านี้ อย่าวาดรูปทรงเอง):\n${notes.join('\n\n')}\nวิธีใช้: path.create {d: d ข้างบนตามตัวอักษร ห้ามแก้ตัวเลขใน d} แล้ว object.transform {matrix: [s·cosθ, s·sinθ, −s·sinθ, s·cosθ, X, Y]} โดย s = ขนาดที่ต้องการ ÷ ขนาดที่วัดได้ (s เดียวกันทั้งสองแกนเสมอ ห้ามยืดหรือบีบ) θ = มุมหมุน (ไม่หมุนใช้ 0 → [s, 0, 0, s, X, Y]) X, Y = ตำแหน่งปลายทางของจุด (0,0) ของรูปทรง ล้นขอบเอกสารได้ จากนั้น paint.setFill ด้วย gradient ข้างบน (ปรับ start/end ให้คลุมกรอบใหม่ หรือไม่ใส่ start/end ให้พอดีวัตถุเอง)\n`;
  }

  async function check(task, beforeImage, afterImage, instructions) {
    const agent = {
      speaker: 'assemble', rulesAgent: 'assemble', tools: [], images: [beforeImage, afterImage],
      schema: { type: 'object', properties: { pass: { type: 'boolean' }, problems: { type: 'array', items: { type: 'string' } } }, required: ['pass', 'problems'] },
      async buildPrompt() { return `คุณคือประกอบ ตรวจงานแก้ไฟล์ VectorCraft ของตัวเองก่อนส่งให้หนิง ตอบภาษาไทย\nภาพแนบภาพที่ 1 = ก่อนแก้ ภาพที่ 2 = หลังแก้ ภาพถัดไป (ถ้ามี) = ภาพอ้างอิงที่หนิงแนบมา\nคำสั่ง:\n${instructions}\nเทียบภาพหลังแก้กับคำสั่งและภาพอ้างอิงอย่างเข้มงวดเหมือนหนิงดูเอง: ลักษณะรูปทรง ความโค้ง สี gradient เงา และไม่ไปแก้สิ่งที่ไม่ได้สั่ง รูปทรงจากภาพอ้างอิงต้องคงสัดส่วนเดิมเป๊ะ (ย่อ/ขยายได้แต่ต้องเท่ากันทั้งสองแกน หมุนได้ ล้นขอบภาพได้) ถ้ารูปทรงถูกยืด บีบ หรือเปลี่ยนหน้าตาให้ไม่ผ่าน ข้อสำคัญที่สุด: ห้ามทับสินค้า (แอร์) พาดหัว ชื่อรุ่น หรือหน้าคน ถ้าทับให้ไม่ผ่าน และบอกให้ย่อ/ขยับออก\npass = true เฉพาะเมื่อพร้อมส่งจริง problems = สิ่งที่ยังไม่ตรง แต่ละข้อบอกให้ชัดว่าต้องเปลี่ยนอะไรเท่าไร (เช่น "ปลายขวาต้องแหลมกว่านี้ ขอบล่างโค้งเว้าเข้ามากกว่านี้") ไม่เกิน 4 ข้อ`; },
    };
    const { result } = await runModel(agent, { ...task, sessionId: null, feedback: '' });
    return { pass: Boolean(result.pass), problems: (result.problems || []).map(String).slice(0, 4) };
  }

  async function edit(task) {
    const dir = taskDir(task.id);
    fs.mkdirSync(dir, { recursive: true });
    const tag = `r${task.rounds + 1}-${crypto.randomUUID().slice(0, 8)}`;
    const project = await projectFile(task);
    // A quiet backup (never opened) so ✕ can put the project back.
    fs.mkdirSync(path.join(dir, '.history'), { recursive: true });
    const baseline = path.join(dir, '.history', `${tag}.vectorcraft`);
    const beforeImage = path.join(dir, `${tag}-before.png`);
    const afterImage = path.join(dir, `${tag}-after.png`);
    fs.copyFileSync(project, baseline);
    await run(project, [], null, beforeImage);
    const before = await snapshot(project);
    fs.writeFileSync(path.join(dir, `${tag}-inspection.json`), JSON.stringify(before, null, 2));
    const memory = await lessons();
    await logEvent(prisma, 'assemble', `อ่านไฟล์จริงและบทเรียนที่ผ่าน ${memory.length} เรื่อง`, task.id);
    const instructions = recentNote(task) + (task.feedback
      ? `${conversationNote(task)}${task.result?.summary ? `\nรอบก่อนประกอบสรุปว่าทำไปแล้ว: ${task.result.summary}` : ''}\nไฟล์ที่เปิดอยู่คือผลจากรอบก่อน แก้ต่อจากนี้`
      : `คำสั่งล่าสุดของหนิง: ${task.prompt}${task.input?.attachments?.length ? `\nหนิงแนบภาพอ้างอิงไว้ (ภาพท้ายสุดในรายการภาพแนบ) ถ้าคำสั่งพูดถึง "แบบนี้" "อันนี้" ให้ทำตามภาพอ้างอิงนั้น` : ''}`);
    const measured = await measuredShapes(task);
    if (measured) await logEvent(prisma, 'assemble', 'วัดรูปทรงและสีจากภาพอ้างอิงแล้ว', task.id);
    const proposal = await plan(task, before, beforeImage, memory, instructions + measured);
    fs.writeFileSync(path.join(dir, `${tag}-proposal.json`), JSON.stringify(proposal, null, 2));
    const commands = validateVectorCommands(proposal.commands);
    if (!commands.length) throw new Error(proposal.summary || 'ยังไม่มีคำสั่งแก้ที่ทำได้');
    const apply = async (file, steps, output, preview) => {
      if (task.input?.live) {
        if (!live) throw new Error('ยังไม่ได้เชื่อมต่อโหมดแสดงสด');
        await live.play({ file, output, preview, commands: steps, taskId: task.id });
      } else await run(file, steps, output, preview);
    };
    await apply(project, commands, project, afterImage);
    // Like a designer: look at the result next to the request (and her
    // reference picture), fix what's off, up to MAX_SELF_CHECKS times.
    let currentImage = afterImage;
    let summary = proposal.summary;
    const allCommands = [...commands];
    for (let round = 1; round <= MAX_SELF_CHECKS; round += 1) {
      const verdict = await check(task, beforeImage, currentImage, instructions + measured);
      await logEvent(prisma, 'assemble', verdict.pass ? `ตรวจเองรอบ ${round}: ตรงคำสั่งแล้ว` : `ตรวจเองรอบ ${round}: ยังไม่ตรง — ${verdict.problems.join(' / ')}`, task.id, { image: url(task.id, path.basename(currentImage)) });
      if (verdict.pass) break;
      const fix = await plan(task, await snapshot(project), currentImage, memory, `${instructions}${measured}\n\nผลรอบก่อน (ภาพแนบภาพแรก) ยังไม่ตรง: ${verdict.problems.join(' / ')}\nแก้ต่อจากไฟล์ปัจจุบันให้ตรงคำสั่ง อย่าเริ่มใหม่ถ้าไม่จำเป็น`);
      let fixCommands;
      try { fixCommands = validateVectorCommands(fix.commands); } catch { break; }
      if (!fixCommands.length) break;
      const nextImage = path.join(dir, `${tag}-after${round + 1}.png`);
      await apply(project, fixCommands, project, nextImage);
      currentImage = nextImage;
      summary = fix.summary || summary;
      allCommands.push(...fixCommands);
    }
    const afterState = await snapshot(project);
    const diff = diffVectorSnapshots(before, afterState);
    if (!diff.length) throw new Error('คำสั่งไม่ทำให้เอกสารเปลี่ยน จึงยังส่งเป็นงานที่แก้เสร็จไม่ได้');
    fs.writeFileSync(path.join(dir, `${tag}-changes.json`), JSON.stringify({ commands: allCommands, diff }, null, 2));
    await logEvent(prisma, 'assemble', `แก้จริง ${allCommands.length} คำสั่ง เปลี่ยน ${diff.length} วัตถุ ส่งให้ผู้สอนตรวจ`, task.id);
    return { result: { stage: 'done', document: toUrl(project), beforeDocument: toUrl(baseline), beforeImage: url(task.id, path.basename(beforeImage)), images: [url(task.id, path.basename(currentImage))], summary, lesson: proposal.lesson, diff, commands: allCommands, mode: 'edit' }, sessionId: null };
  }

  async function start(sourceTaskId, prompt) {
    const { file } = await sourceFile(sourceTaskId);
    const task = await prisma.agentTask.create({ data: { agent: 'assemble', prompt: prompt || 'เรียนรู้จากตัวอย่างที่ฉันแก้ใน VectorCraft', status: 'review', input: { sourceTaskId, mode: 'demonstration' }, result: { stage: 'teaching' } } });
    try {
      const dir = taskDir(task.id);
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(file, path.join(dir, 'before.vectorcraft'));
      fs.copyFileSync(file, path.join(dir, 'practice.vectorcraft'));
      await run(path.join(dir, 'before.vectorcraft'), [], null, path.join(dir, 'before.png'));
      const result = { stage: 'teaching', mode: 'demonstration', beforeImage: url(task.id, 'before.png'), images: [url(task.id, 'before.png')], document: url(task.id, 'practice.vectorcraft'), beforeDocument: url(task.id, 'before.vectorcraft') };
      await prisma.agentTask.update({ where: { id: task.id }, data: { result } });
      await logEvent(prisma, 'assemble', 'เตรียมสำเนาสำหรับสอนแล้ว เปิดไฟล์ แก้ และบันทึกก่อนกดให้เปรียบเทียบ', task.id);
      return { ...task, result };
    } catch (e) {
      await prisma.agentTask.update({ where: { id: task.id }, data: { status: 'failed', error: e.message } });
      throw e;
    }
  }

  async function capture(id) {
    const task = await prisma.agentTask.findUnique({ where: { id } });
    if (task?.agent !== 'assemble' || task.status !== 'review' || task.result?.stage !== 'teaching') throw new Error('งานนี้ไม่ได้รอรับตัวอย่างการสอน');
    const dir = taskDir(id);
    // Capture a stable saved version; the original and editable practice stay intact.
    const captured = path.join(dir, `example-${crypto.randomUUID()}.vectorcraft`);
    fs.copyFileSync(fileFor(task.result.document), captured);
    const before = await snapshot(fileFor(task.result.beforeDocument));
    const after = await snapshot(captured);
    const diff = diffVectorSnapshots(before, after);
    if (!diff.length) { fs.unlinkSync(captured); throw new Error('ยังไม่พบการเปลี่ยนแปลง กรุณาบันทึกไฟล์ใน VectorCraft ก่อน'); }
    const image = captured.replace('.vectorcraft', '.png');
    await run(captured, [], null, image);
    const result = { ...task.result, stage: 'learning', document: url(id, path.basename(captured)), images: [url(id, path.basename(image))], diff };
    const updated = await prisma.agentTask.updateMany({ where: { id, status: 'review', result: { path: ['stage'], equals: 'teaching' } }, data: { status: 'queued', result, error: '' } });
    if (!updated.count) throw new Error('งานนี้ถูกส่งไปแล้ว กรุณาโหลดใหม่');
    return { ok: true };
  }

  // 📖 Study: she edited a file herself; VEC reads it as it stands (live from
  // the open window when possible, so unsaved edits count), changes nothing,
  // tells her in the chat what it learned and drafts a lesson for approval.
  async function study(task) {
    const dir = taskDir(task.id);
    fs.mkdirSync(dir, { recursive: true });
    const image = path.join(dir, 'study.png');
    let state;
    let source;
    if (live) {
      try {
        ({ state, source } = await live.readOnly(async ({ doc, exec, exportPng }) => {
          await exportPng(image);
          return { state: await snapshotWith(exec), source: doc.path };
        }));
      } catch (e) {
        await logEvent(prisma, 'assemble', `อ่านจากหน้าต่าง VectorCraft ไม่ได้ (${e.message.slice(0, 100)}) จะอ่านไฟล์ที่บันทึกไว้แทน`, task.id);
      }
    }
    if (!state) {
      const file = await projectFile(task);
      await run(file, [], null, image);
      state = await snapshot(file);
      source = file;
    }
    await logEvent(prisma, 'assemble', `กำลังเรียนรู้ ${path.basename(source)} (${state.nodes.length} วัตถุ) ไม่แก้อะไรในไฟล์`, task.id, { image: url(task.id, 'study.png') });
    const agent = {
      speaker: 'assemble', rulesAgent: 'assemble', tools: [], images: [image],
      schema: { type: 'object', properties: {
        reply: { type: 'string' },
        lesson: { type: 'object', properties: { title: { type: 'string' }, condition: { type: 'string' }, rule: { type: 'string' } }, required: ['title', 'condition', 'rule'] },
      }, required: ['reply', 'lesson'] },
      async buildPrompt() { return `คุณคือ VEC ผู้ประกอบเลเยอร์ใน VectorCraft หนิงแก้ไฟล์นี้ด้วยตัวเองล่าสุด และขอให้คุณเรียนรู้จากมัน ห้ามแก้ไฟล์ (งานนี้อ่านอย่างเดียว)\nคำสั่งของหนิง: ${task.prompt}\nภาพที่แนบคือหน้าตาไฟล์ตอนนี้ ข้อมูลจริงของวัตถุทุกชิ้น:\n${JSON.stringify(state)}\n\nreply: ตอบหนิงในแชทเหมือนเพื่อนร่วมทีม ภาษาไทยกันเอง สั้น 3–6 บรรทัด บอกสิ่งที่เห็นว่าหนิงตั้งใจทำ (ตำแหน่ง ขนาด รูปทรง ฟอนต์ สี เงา ลำดับเลเยอร์) เป็นตัวเลขจริงจากข้อมูล และบอกว่าจะเอาไปใช้ยังไงในงานถัดไป\nlesson: สรุปเป็นบทเรียนที่ใช้ซ้ำได้ condition = ใช้เมื่อไร rule = ทำอย่างไร อ้างชื่อเลเยอร์และสัดส่วนต่อขนาดภาพ ไม่ผูกกับ id ของไฟล์นี้ ห้ามเดาสิ่งที่ไม่มีในข้อมูล บทเรียนจะใช้ได้เมื่อหนิงกดยืนยัน`; },
    };
    const { result } = await runModel(agent, { ...task, sessionId: null, feedback: '' });
    return { result: { stage: 'done', mode: 'study', images: [url(task.id, 'study.png')], summary: result.reply, lesson: result.lesson, studied: path.basename(source) }, sessionId: null };
  }

  async function learn(task) {
    const before = await snapshot(fileFor(task.result.beforeDocument));
    const after = await snapshot(fileFor(task.result.document));
    const agent = {
      speaker: 'assemble', rulesAgent: 'assemble', tools: [],
      images: [path.join(publicRoot, task.result.beforeImage), path.join(publicRoot, task.result.images[0])],
      schema: { type: 'object', properties: { summary: { type: 'string' }, lesson: { type: 'object', properties: { title: { type: 'string' }, condition: { type: 'string' }, rule: { type: 'string' } }, required: ['title', 'condition', 'rule'] } }, required: ['summary', 'lesson'] },
      async buildPrompt() { return `ผู้สอนแก้ไฟล์ VectorCraft ให้ดูแล้ว อ่านภาพก่อนและหลังที่แนบมา พร้อมค่าจริงต่อไปนี้\nโจทย์: ${task.feedback || task.prompt}\nก่อน: ${JSON.stringify(before)}\nหลัง: ${JSON.stringify(after)}\nความต่าง: ${JSON.stringify(task.result.diff)}\nสรุปภาษาไทยว่าเปลี่ยนอะไรจริง และเสนอ lesson ที่ใช้กับงานถัดไปได้ condition ระบุเมื่อใดควรใช้ rule บอกวิธีทำจากชื่อเลเยอร์และสัดส่วน ห้ามผูกกับ id เฉพาะไฟล์ ห้ามอ้างว่าเห็นการคลิกเมาส์หรือขั้นตอนที่ไม่มีหลักฐาน ห้ามเพิ่มสิ่งที่ไม่พบในการเปรียบเทียบ บทเรียนยังเป็นร่างรอผู้สอนยืนยัน`; },
    };
    const { result } = await runModel(agent, { ...task, sessionId: null, feedback: '' });
    return { result: { ...task.result, ...result, stage: 'done', mode: 'demonstration' }, sessionId: null };
  }

  async function approve(task, body) {
    if (task.result?.stage !== 'done' || (!task.result?.diff?.length && task.result?.mode !== 'study')) throw new Error('ต้องเปรียบเทียบงานก่อนจึงบันทึกบทเรียนได้');
    const lesson = {
      title: String(task.result.lesson?.title || '').slice(0, 200),
      condition: String(body.condition ?? task.result.lesson?.condition ?? '').trim().slice(0, 1500),
      rule: String(body.rule ?? task.result.lesson?.rule ?? '').trim().slice(0, 4000),
    };
    if (!lesson.rule || !lesson.condition) throw new Error('ระบุวิธีทำและเงื่อนไขการใช้บทเรียนก่อน');
    await prisma.agentTask.update({ where: { id: task.id }, data: { result: { ...task.result, lesson } } });
    return 'เก็บไฟล์ที่แก้และบทเรียนที่ตรวจผ่านแล้ว ประกอบจะอ่านเมื่องานถัดไป';
  }

  async function applyLessons(file, preview, task) {
    const memory = await lessons();
    if (!memory.length) return;
    const before = await snapshot(file);
    const proposal = await plan(task, before, preview, memory,
      'นี่คือภาพที่ประกอบขึ้นใหม่ ใช้เฉพาะบทเรียนที่ผู้ใช้ตรวจผ่านและเงื่อนไขตรงกับภาพนี้ ปรับไฟล์ตามบทเรียนให้ครบโดยคงสินค้าจริงและข้อความเดิม ไม่ปรับเรื่องอื่น หากไม่มีบทเรียนตรงเงื่อนไขให้ commands ว่าง');
    const commands = validateVectorCommands(proposal.commands);
    if (!commands.length) return;
    const backup = file.replace(/\.vectorcraft$/, '-before-lessons.vectorcraft');
    const output = file.replace(/\.vectorcraft$/, '-lessons.vectorcraft');
    const image = preview.replace(/\.png$/, '-lessons.png');
    fs.copyFileSync(file, backup);
    await run(backup, commands, output, image);
    const diff = diffVectorSnapshots(before, await snapshot(output));
    if (!diff.length) throw new Error('ประกอบใช้บทเรียนแล้วแต่ไม่มีวัตถุเปลี่ยน กรุณาตรวจวิธีทำ');
    fs.copyFileSync(output, file);
    fs.copyFileSync(image, preview);
    await logEvent(prisma, 'assemble', `ใช้บทเรียนที่ตรวจผ่านกับภาพใหม่ แก้จริง ${diff.length} วัตถุ ก่อนส่งให้ผังตรวจ`, task.id);
  }

  // ✕ on VEC's latest round puts the project file back to before that round.
  async function rollback(task) {
    if (task.agent !== 'assemble' || task.input?.mode !== 'edit' || !task.input?.projectFile || !task.result?.beforeDocument?.includes('/.history/')) return false;
    const later = await prisma.agentTask.findFirst({ where: { agent: 'assemble', id: { not: task.id }, createdAt: { gt: task.createdAt }, status: { in: ['queued', 'running', 'review', 'done'] } } });
    if (later?.input?.projectFile === task.input.projectFile) return false;
    fs.copyFileSync(fileFor(task.result.beforeDocument), fileFor(task.input.projectFile));
    return true;
  }

  return { edit, learn, study, start, capture, approve, sourceFile, lessons, snapshot, run, applyLessons, rollback };
}
