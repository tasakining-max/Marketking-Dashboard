import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { validateVectorCommands } from './vectorTeaching.js';
import { materializeStep } from './vectorKit.js';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// VectorCraft's CLI speaks newline-delimited MCP JSON-RPC over stdio. An
// explicit --connect fails when the GUI is absent; it never renders headlessly.
export class VectorMcpClient {
  constructor(bin, address, spawnProcess = spawn) {
    this.child = spawnProcess(bin, ['mcp', '--connect', address], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.pending = new Map(); this.nextId = 0; this.buffer = ''; this.stderr = '';
    this.child.stdout.on('data', (chunk) => {
      this.buffer += chunk.toString();
      let end;
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        clearTimeout(pending.timer); this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
      }
    });
    this.child.stderr.on('data', (chunk) => { this.stderr = (this.stderr + chunk).slice(-2000); });
    this.child.on('error', (error) => this.fail(error));
    this.child.on('close', () => this.fail(new Error(this.stderr || 'การเชื่อมต่อ VectorCraft ปิดลง')));
    this.child.stdin.on('error', (error) => this.fail(error));
  }
  fail(error) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
  }
  request(method, params) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('VectorCraft ไม่ตอบกลับ หยุดเพื่อไม่ส่งคำสั่งซ้ำ')); }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async init() {
    await this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'tasaki-live-vector', version: '1' } });
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    // This is a GUI-only tool: a headless backend must not count as realtime.
    await this.call('ui_inspect', {});
    return this;
  }
  async call(name, args) {
    const result = await this.request('tools/call', { name, arguments: args });
    const text = result.content?.filter((c) => c.type === 'text').map((c) => c.text).join('\n') || '';
    if (result.isError) throw new Error(text || 'VectorCraft ปฏิเสธคำสั่ง');
    try { return JSON.parse(text); } catch { return text; }
  }
  close() {
    this.fail(new Error('จบการแสดงสด'));
    this.child.stdin.end(); this.child.kill();
  }
}

function isListening(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const finish = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(500, () => finish(false));
    socket.on('connect', () => finish(true)); socket.on('error', () => finish(false));
  });
}

export function createLiveVector({ root, cli, runProcess, onProgress = async () => {}, clientFactory, wait = pause, stepDelay = 650 }) {
  const port = 17979;
  let busy = false, cancelled = false;
  let state = { status: 'idle', step: 0, total: 0 };
  const status = () => ({ ...state });
  const withinRoot = (file, exists = true) => {
    const resolved = exists ? fs.realpathSync(file) : path.join(fs.realpathSync(path.dirname(file)), path.basename(file));
    if (!resolved.startsWith(fs.realpathSync(root) + path.sep)) throw new Error('แสดงสดได้เฉพาะสำเนาในพื้นที่งานของทีม');
    return resolved;
  };
  async function connect() {
    if (clientFactory) return clientFactory();
    if (!(await isListening(port))) {
      const opened = await runProcess('/usr/bin/open', ['-na', '/Applications/VectorCraft.app', '--args', '--control', String(port), '--automation-read-root', root, '--automation-write-root', root], { cwd: root });
      if (opened.code !== 0) throw new Error('เปิดหน้าต่าง VectorCraft ไม่สำเร็จ');
      for (let i = 0; i < 25 && !(await isListening(port)); i++) await wait(200);
    }
    return new VectorMcpClient(cli(), `127.0.0.1:${port}`).init();
  }
  async function play({ file, output, preview, commands, taskId }) {
    if (busy) throw new Error('VectorCraft กำลังแสดงงานอื่นอยู่ กรุณารอให้จบก่อน');
    const steps = validateVectorCommands(commands);
    file = withinRoot(file); output = withinRoot(output, false);
    if (preview) preview = withinRoot(preview, false);
    busy = true; cancelled = false;
    state = { status: 'connecting', step: 0, total: steps.length, taskId, file: output };
    let client;
    const assertDocument = async (expectedRevision) => {
      if (cancelled) throw new Error('หยุดการแสดงสดตามคำสั่ง');
      const doc = await client.call('doc_inspect', {});
      if (doc.path !== output || (expectedRevision !== undefined && doc.revision !== expectedRevision)) {
        throw new Error('หยุดการแสดงสด เพราะเอกสารถูกสลับหรือมีการแก้แทรก');
      }
      return doc.revision;
    };
    try {
      // Same project file: keep working in the window that already has it.
      if (file !== output) fs.copyFileSync(file, output);
      client = await connect();
      const active = await client.call('doc_inspect', {}).catch(() => null);
      if (active?.path !== output) {
        await client.call('open_file', { path: output });
        await client.call('open_panel', { panel: 'layers' });
        // Fit via the app's actual UI command when available.
        const views = await client.call('command_list', { filter: 'fit' });
        const fit = Array.isArray(views) && views.find((c) => /view\..*fit/i.test(c.id) && /artboard|window/i.test(c.id + c.label));
        if (fit) await client.call('command_run', { id: fit.id, params: {} });
      }
      let revision = await assertDocument();
      state.status = 'playing';
      await onProgress({ ...state, command: 'เปิดสำเนาใน VectorCraft แล้ว' });
      for (const [index, step] of steps.entries()) {
        await wait(stepDelay);
        await assertDocument(revision);
        const real = materializeStep(step, path.dirname(output));
        await client.call('command_run', { id: real.command, params: real.params });
        revision = await assertDocument();
        state.step = index + 1;
        await onProgress({ ...state, command: step.command });
      }
      await assertDocument(revision);
      await client.call('save_file', { path: output });
      if (preview) await client.call('export', { path: preview, format: 'png' });
      state.status = 'done'; await onProgress({ ...state, command: 'แสดงและบันทึกครบแล้ว' });
      return status();
    } catch (error) {
      state.status = cancelled ? 'stopped' : 'failed'; state.error = error.message;
      await onProgress({ ...state, command: error.message });
      throw error;
    } finally { client?.close(); busy = false; }
  }
  // Read the open document without changing it (unsaved edits included):
  // only inspection commands and a PNG export, never a save.
  const READ_ONLY = new Set(['document.inspect', 'document.node', 'text.fonts']);
  async function readOnly(fn) {
    if (busy) throw new Error('VectorCraft กำลังแสดงงานอื่นอยู่ กรุณารอให้จบก่อน');
    busy = true;
    let client;
    try {
      client = await connect();
      const doc = await client.call('doc_inspect', {});
      if (!doc?.path) throw new Error('ยังไม่มีไฟล์เปิดอยู่ใน VectorCraft');
      const exec = async (commands) => {
        const rows = [];
        for (const c of commands) {
          if (!READ_ONLY.has(c.command)) throw new Error(`โหมดเรียนรู้อ่านได้อย่างเดียว ไม่รองรับ ${c.command}`);
          rows.push({ command: c.command, result: await client.call('command_run', { id: c.command, params: c.params }) });
        }
        return rows;
      };
      const exportPng = (file) => client.call('export', { path: withinRoot(file, false), format: 'png' });
      return await fn({ doc, exec, exportPng });
    } finally { client?.close(); busy = false; }
  }
  return { play, readOnly, status, stop() { cancelled = true; return status(); } };
}
