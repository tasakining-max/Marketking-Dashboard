import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLiveVector } from '../lib/vectorLive.js';

function fixture(t, { interfere = false, stopOnStep = false, transportFailure = false, openDoc = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tasaki-live-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'before.vectorcraft'), output = path.join(root, 'live.vectorcraft');
  fs.writeFileSync(file, 'original');
  const calls = [];
  let revision = 1, active = openDoc ?? path.join(fs.realpathSync(root), 'live.vectorcraft'), closed = false, live;
  const client = {
    call: async (name, args) => {
      calls.push([name, args]);
      if (name === 'open_file') active = args.path;
      if (name === 'doc_inspect') return { path: active, revision };
      if (name === 'command_list') return [];
      if (name === 'command_run') {
        if (transportFailure) throw new Error('connection lost');
        revision++;
      }
      return {};
    },
    close: () => { closed = true; },
  };
  let waits = 0;
  live = createLiveVector({ root, clientFactory: async () => client, wait: async () => {
    waits++;
    if (interfere && waits === 2) revision++;
  }, onProgress: async (event) => { if (stopOnStep && event.step === 1) live.stop(); } });
  return { live, file, output, calls, closed: () => closed };
}
const commands = [{ command: 'select.set', params: { ids: [1] } }, { command: 'object.move', params: { dx: 40, dy: 0 } }];

test('live edits open a copy, execute sequentially, then save without touching the source', async (t) => {
  const f = fixture(t, { openDoc: '/elsewhere.vectorcraft' });
  const result = await f.live.play({ file: f.file, output: f.output, commands, taskId: 'test' });
  assert.equal(result.status, 'done');
  assert.equal(result.step, 2);
  assert.equal(fs.readFileSync(f.file, 'utf8'), 'original');
  assert.equal(f.calls.find(([name]) => name !== 'doc_inspect')[0], 'open_file');
  assert.deepEqual(f.calls.filter(([name]) => name === 'command_run').map(([, args]) => args.id), ['select.set', 'object.move']);
  assert.equal(f.calls.at(-1)[0], 'save_file');
  assert.ok(f.closed());
});

test('live edits stop when the user modifies the document between steps', async (t) => {
  const f = fixture(t, { interfere: true });
  await assert.rejects(f.live.play({ file: f.file, output: f.output, commands }), /แก้แทรก/);
  assert.equal(f.calls.filter(([name]) => name === 'command_run').length, 1);
  assert.equal(f.live.status().status, 'failed');
  assert.ok(!f.calls.some(([name]) => name === 'save_file'));
});

test('stop prevents remaining edits; interrupted commands are never retried', async (t) => {
  const stopped = fixture(t, { stopOnStep: true });
  await assert.rejects(stopped.live.play({ file: stopped.file, output: stopped.output, commands }), /หยุด/);
  assert.equal(stopped.live.status().status, 'stopped');
  assert.equal(stopped.calls.filter(([name]) => name === 'command_run').length, 1);
  const broken = fixture(t, { transportFailure: true });
  await assert.rejects(broken.live.play({ file: broken.file, output: broken.output, commands }), /connection lost/);
  assert.equal(broken.calls.filter(([name]) => name === 'command_run').length, 1);
});

test('the project file is edited in place in the window that already has it', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.output, 'project');
  const result = await f.live.play({ file: f.output, output: f.output, commands });
  assert.equal(result.status, 'done');
  assert.ok(!f.calls.some(([name]) => name === 'open_file'));
  assert.equal(f.calls.at(-1)[0], 'save_file');
});

test('live playback rejects unsafe commands', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.live.play({ file: f.file, output: f.output, commands: [{ command: 'file.open', params: {} }] }), /ไม่รองรับ/);
  assert.equal(f.calls.length, 0);
});

test('only one live edit can own the window at a time', async (t) => {
  const f = fixture(t);
  const first = f.live.play({ file: f.file, output: f.output, commands });
  await assert.rejects(f.live.play({ file: f.file, output: f.output, commands }), /งานอื่น/);
  await first;
});
