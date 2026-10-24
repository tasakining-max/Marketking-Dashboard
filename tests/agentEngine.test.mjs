import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { effectiveEngine, enginePreferences, saveEngine, codexSchema, claudeSession } from '../lib/agentEngine.js';

test('engine selection preserves Claude default and supports per-agent overrides', () => {
  assert.equal(effectiveEngine({}, 'layout'), 'claude');
  assert.equal(effectiveEngine({ all: 'codex' }, 'layout'), 'codex');
  assert.equal(effectiveEngine({ all: 'codex', layout: 'claude' }, 'layout'), 'claude');
});

test('engine preferences remain separate from rules and can return to inheritance', async () => {
  const rows = new Map([['layout', { agent: 'layout', rules: 'keep my rules' }]]);
  const prisma = { agentSetting: {
    findMany: async () => [...rows.values()],
    upsert: async ({ where, create }) => rows.set(where.agent, create),
    deleteMany: async ({ where }) => rows.delete(where.agent),
  } };
  await saveEngine(prisma, 'all', 'codex');
  await saveEngine(prisma, 'layout', 'claude');
  assert.deepEqual(await enginePreferences(prisma), { all: 'codex', layout: 'claude' });
  await saveEngine(prisma, 'layout', 'default');
  assert.equal(effectiveEngine(await enginePreferences(prisma), 'layout'), 'codex');
  assert.equal(rows.get('layout').rules, 'keep my rules');
  await assert.rejects(saveEngine(prisma, 'layout', 'unknown'));
});

test('Codex schema closes nested objects without changing the Claude schema', () => {
  const schema = { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' } } } } } };
  const strict = codexSchema(schema);
  assert.equal(strict.additionalProperties, false);
  assert.deepEqual(strict.required, ['items']);
  assert.equal(strict.properties.items.items.additionalProperties, false);
  assert.deepEqual(strict.properties.items.items.required, ['name']);
  assert.equal(schema.additionalProperties, undefined);
});

test('Claude sessions accept legacy IDs but never Codex IDs', () => {
  assert.equal(claudeSession('legacy-id'), 'legacy-id');
  assert.equal(claudeSession('claude:session-id'), 'session-id');
  assert.equal(claudeSession('codex:session-id'), null);
});

test('provider runners preserve schema, review context, images, and Claude resume', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasaki-engine-test-'));
  const bin = path.join(dir, 'fake-cli');
  const trace = path.join(dir, 'trace.json');
  fs.writeFileSync(bin, `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
let prompt = '';
process.stdin.on('data', d => prompt += d);
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(trace)}, JSON.stringify({args, prompt}));
  if (args[0] === 'exec') {
    if (prompt.includes('FAIL_CODEX')) { process.stderr.write('Codex quota exhausted'); process.exit(1); }
    const schema = JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema')+1]));
    if (!schema.additionalProperties && schema.required.includes('answer')) {
      fs.writeFileSync(args[args.indexOf('--output-last-message')+1], JSON.stringify({answer:'Codex draft', rationale:'summary'}));
    } else process.exit(2);
  } else console.log(JSON.stringify({structured_output:{answer:'Claude draft', rationale:'summary'},session_id:'new-session'}));
});`);
  fs.chmodSync(bin, 0o755);
  const old = { CODEX_BIN: process.env.CODEX_BIN, CLAUDE_BIN: process.env.CLAUDE_BIN };
  process.env.CODEX_BIN = bin;
  process.env.CLAUDE_BIN = bin;
  const { runLanguageAgent } = await import('../lib/agentTeam.js');
  let provider = 'codex';
  const prisma = {
    agentSetting: { findMany: async () => [{ agent: '__engine:all', rules: provider }], findUnique: async () => null },
    agentTask: { findMany: async () => [] }, agentEvent: { create: async () => {} },
  };
  const agent = { model: 'sonnet', exactEdit: true, tools: [], images: ['/tmp/example.png'], schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] }, buildPrompt: async () => 'Original brief' };
  const task = { id: 'test', agent: 'catalog', result: { summary: 'previous draft' }, feedback: 'make it shorter', sessionId: 'claude:old-session' };
  try {
    await t.test('switching to Codex rebuilds context and sends image attachments read-only', async () => {
      const out = await runLanguageAgent(agent, task, prisma, {});
      assert.deepEqual(out, { result: { answer: 'Codex draft' }, sessionId: null });
      const invocation = JSON.parse(fs.readFileSync(trace));
      assert.ok(invocation.args.includes('read-only'));
      assert.ok(invocation.args.includes('--image=/tmp/example.png'));
      assert.ok(!invocation.args.includes('--resume'));
      assert.match(invocation.prompt, /Original brief/);
      assert.match(invocation.prompt, /previous draft/);
      assert.match(invocation.prompt, /make it shorter/);
      assert.match(invocation.prompt, /ห้ามนำค่าเริ่มต้นมาทับ/);
      assert.ok(!fs.existsSync(invocation.args[invocation.args.indexOf('--output-schema') + 1]));
    });
    await t.test('switching back to Claude retains its original CLI and session support', async () => {
      provider = 'claude';
      const out = await runLanguageAgent(agent, task, prisma, {});
      assert.equal(out.result.answer, 'Claude draft');
      assert.equal(out.sessionId, 'claude:new-session');
      const invocation = JSON.parse(fs.readFileSync(trace));
      assert.ok(invocation.args.includes('--json-schema'));
      assert.equal(invocation.args[invocation.args.indexOf('--resume') + 1], 'old-session');
    });
    await t.test('Codex failures surface without silently changing providers', async () => {
      provider = 'codex';
      await assert.rejects(runLanguageAgent({ ...agent, buildPrompt: async () => 'FAIL_CODEX' }, task, prisma, {}), /Codex quota exhausted/);
    });
  } finally {
    for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
