import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createVectorTeaching, validateVectorCommands, resolveVectorFile, diffVectorSnapshots } from '../lib/vectorTeaching.js';

test('vector edits accept object operations but reject scripts and external file access', () => {
  assert.deepEqual(validateVectorCommands([{ command: 'object.transform', params: '{"ids":[10],"matrix":[0.5,0,0,0.5,0,0]}' }])[0].params.ids, [10]);
  for (const command of ['file.open', 'file.saveAs', 'script.run']) assert.throws(() => validateVectorCommands([{ command, params: '{}' }]));
  assert.throws(() => validateVectorCommands([{ command: 'object.setProps', params: { path: '/tmp/other' } }]));
  assert.throws(() => validateVectorCommands([{ command: 'effect.apply', params: { effect: 'plugin.some-script' } }]));
  assert.equal(validateVectorCommands([
    { command: 'layer.new', params: { name: 'ลมเวกเตอร์', top: true } },
    { command: 'path.create', params: { d: 'M 400 280 C 400 320 430 350 420 400' } },
  ]).length, 2);
  assert.throws(() => validateVectorCommands([{ command: 'path.create', params: {} }]));
  assert.throws(() => validateVectorCommands([{ command: 'path.create', params: { path: '/tmp/asset.svg' } }]));
});

test('snapshots detect typography, transforms and removed objects', () => {
  const before = { artboards: [], nodes: [{ id: 1, name: 'พาดหัว', details: { size: 100 } }, { id: 2, name: 'โลโก้' }] };
  const after = { artboards: [], nodes: [{ id: 1, name: 'พาดหัว', details: { size: 80 } }] };
  assert.equal(diffVectorSnapshots(before, after).length, 2);
  assert.deepEqual(diffVectorSnapshots(before, structuredClone(before)), []);
  assert.equal(diffVectorSnapshots({ artboards: [], nodes: [{ id: 1, order: 0 }] }, { artboards: [], nodes: [{ id: 1, order: 1 }] }).length, 1, 'stacking order changes are learnable');
});

test('teaching preserves originals, rejects unsaved examples, and learns only approved work', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tasaki-vector-test-'));
  const base = path.join(root, 'public', 'uploads', 'agent-images');
  fs.mkdirSync(path.join(base, 'source'), { recursive: true });
  const sourceFile = path.join(base, 'source', 'original.vectorcraft');
  fs.writeFileSync(sourceFile, JSON.stringify({ x: 20 }));
  const tasks = new Map([['source', { id: 'source', status: 'review', result: { document: '/uploads/agent-images/source/original.vectorcraft' } }]]);
  let serial = 0;
  const capturedPrompts = [];
  let nothingToDo = false;
  const prisma = { agentTask: {
    findUnique: async ({ where }) => structuredClone(tasks.get(where.id)),
    findMany: async ({ where }) => [...tasks.values()].filter((t) => t.agent === where.agent && t.status === where.status),
    create: async ({ data }) => { const task = { id: `test-${++serial}`, rounds: 0, ...data }; tasks.set(task.id, task); return structuredClone(task); },
    update: async ({ where, data }) => { Object.assign(tasks.get(where.id), data); return structuredClone(tasks.get(where.id)); },
    updateMany: async ({ where, data }) => {
      const t = tasks.get(where.id);
      if (t.status !== where.status || t.result.stage !== where.result.equals) return { count: 0 };
      Object.assign(t, data); return { count: 1 };
    },
  } };
  const runProcess = async (_bin, args) => {
    if (args[0] === 'commands') return { code: 0, stdout: JSON.stringify([{ id: 'object.transform', params: 'matrix, ids' }]) };
    const file = args[args.indexOf('--in') + 1];
    const doc = JSON.parse(fs.readFileSync(file));
    const lines = [];
    for (let i = 0; i < args.length; i++) if (args[i] === '--cmd') {
      const command = args[++i]; i++;
      const params = JSON.parse(args[++i]);
      if (command === 'object.transform') doc.x = params.matrix[4];
      if (command === 'file.saveAs') fs.writeFileSync(params.path, JSON.stringify(doc));
      let result = {};
      if (command === 'document.inspect') result = { artboards: [], layers: [{ id: 1, kind: 'Image', name: 'โลโก้', bounds: { x: doc.x } }] };
      if (command === 'text.fonts') result = [];
      lines.push(JSON.stringify({ command, result }));
    }
    if (args.includes('--export')) fs.writeFileSync(args[args.indexOf('--export') + 1], 'preview');
    return { code: 0, stdout: lines.join('\n') };
  };
  const service = createVectorTeaching({ root, prisma, runProcess, cli: () => 'fake-vectorcraft', logEvent: async () => {},
    runModel: async (agent) => { capturedPrompts.push(await agent.buildPrompt()); return { result: nothingToDo ? { summary: 'ไม่มีสีส้มเหลือแล้ว', commands: [], lesson: { title: '', condition: '', rule: '' } } : {
      summary: 'ย้ายโลโก้', commands: [{ command: 'object.transform', params: '{"ids":[1],"matrix":[1,0,0,1,50,0]}' }],
      lesson: { title: 'เว้นสินค้า', condition: 'เมื่อโลโก้บังสินค้า', rule: 'ย้ายโลโก้ให้พ้นสินค้าโดยคงสัดส่วน' },
    } }; },
  });
  try {
    assert.equal(resolveVectorFile(path.join(root, 'public'), '/uploads/agent-images/source/original.vectorcraft'), sourceFile);
    fs.symlinkSync('/etc/hosts', path.join(base, 'outside.vectorcraft'));
    assert.throws(() => resolveVectorFile(path.join(root, 'public'), '/uploads/agent-images/outside.vectorcraft'));
    assert.throws(() => resolveVectorFile(path.join(root, 'public'), '/uploads/agent-images/../../../etc/hosts.vectorcraft'));
    fs.copyFileSync(sourceFile, path.join(base, 'source', 'dealer-promo.ai'));
    assert.equal(resolveVectorFile(path.join(root, 'public'), '/uploads/agent-images/source/dealer-promo.ai'), path.join(base, 'source', 'dealer-promo.ai'));
    assert.throws(() => resolveVectorFile(path.join(root, 'public'), '/uploads/agent-images/source/original.png'));
    const manual = await service.start('source', 'ย้ายโลโก้');
    await assert.rejects(service.capture(manual.id), /ยังไม่พบการเปลี่ยนแปลง/);
    fs.writeFileSync(resolveVectorFile(path.join(root, 'public'), manual.result.document), JSON.stringify({ x: 55 }));
    await service.capture(manual.id);
    assert.equal(tasks.get(manual.id).status, 'queued');
    const learned = await service.learn(tasks.get(manual.id));
    assert.equal(learned.result.diff.length, 1);
    Object.assign(tasks.get(manual.id), { result: learned.result, status: 'review' });
    assert.equal((await service.lessons()).length, 0);
    await service.approve(tasks.get(manual.id), { rule: 'ย้ายโลโก้ให้พ้นสินค้า', condition: 'เมื่อบังสินค้า' });
    assert.equal((await service.lessons()).length, 0, 'approval route must finish marking the task done first');
    tasks.get(manual.id).status = 'done';
    assert.equal((await service.lessons()).length, 1);
    const editTask = await prisma.agentTask.create({ data: { agent: 'assemble', status: 'running', prompt: 'แก้โลโก้', input: { sourceTaskId: 'source' } } });
    const edited = await service.edit(editTask);
    assert.equal(edited.result.diff.length, 1);
    assert.ok(capturedPrompts.some((p) => p.includes('ย้ายโลโก้ให้พ้นสินค้า')), 'approved lessons reach the edit plan');
    assert.equal(JSON.parse(fs.readFileSync(sourceFile)).x, 20, 'source is never overwritten');
    assert.equal(JSON.parse(fs.readFileSync(resolveVectorFile(path.join(root, 'public'), edited.result.document))).x, 50);
    nothingToDo = true;
    const idle = await service.edit(Object.assign(editTask, { rounds: 1, feedback: 'สีส้มไม่ใช่สี Tasaki', result: edited.result }));
    nothingToDo = false;
    assert.equal(idle.result.noChange, true, 'nothing to change comes back for review, not as a failure');
    assert.equal(idle.result.summary, 'ไม่มีสีส้มเหลือแล้ว');
    assert.equal(JSON.parse(fs.readFileSync(resolveVectorFile(path.join(root, 'public'), idle.result.document))).x, 50, 'file untouched');
    assert.match(await service.approve({ result: idle.result }, {}), /ไม่ได้แก้ไฟล์/);
    const fresh = path.join(base, 'source', 'fresh.vectorcraft');
    fs.copyFileSync(sourceFile, fresh);
    const freshPreview = path.join(base, 'source', 'fresh.png');
    fs.writeFileSync(freshPreview, 'preview');
    await service.applyLessons(fresh, freshPreview, { id: 'image-task', agent: 'assemble' });
    assert.equal(JSON.parse(fs.readFileSync(fresh)).x, 50, 'approved lessons apply to newly assembled documents');
    assert.equal(JSON.parse(fs.readFileSync(fresh.replace('.vectorcraft', '-before-lessons.vectorcraft'))).x, 20);
    const rejected = await prisma.agentTask.create({ data: { agent: 'assemble', status: 'rejected', result: { lesson: { rule: 'do not learn' } } } });
    assert.ok(!(await service.lessons()).some((l) => l.taskId === rejected.id));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
