import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { kitCatalog, kitFile, fitRect, materializeStep, textStyleSteps, TEXT_STYLES } from '../lib/vectorKit.js';
import { validateVectorCommands } from '../lib/vectorTeaching.js';

test('kit pieces come only from her kit and keep their proportions', () => {
  const pieces = kitCatalog();
  assert.ok(pieces.some((p) => p.file === 'shapes/tasaki-corner-shape.svg'), 'the Tasaki blade is offered');
  assert.ok(!pieces.some((p) => p.file.startsWith('logos/bitwise-')), 'group-company logos are not ad material');
  assert.ok(!pieces.some((p) => p.file === 'shapes/tasaki-corner-shape.png'), 'a piece with an .svg is offered as the vector');
  assert.deepEqual(fitRect('shapes/tasaki-corner-shape.svg', [10, 20, 340, 999]), [10, 20, 340, 310]);
  for (const bad of ['../../.env', '/etc/hosts', 'shapes/missing.svg', 'logos/bitwise-group.png']) assert.throws(() => kitFile(bad));
});

test('edits place kit pieces and her text templates, nothing else', () => {
  assert.equal(validateVectorCommands([{ command: 'file.place', params: { kit: 'shapes/tasaki-blade-kit/blade-gradient.svg', rect: [0, 0, 300, 0] } }]).length, 1);
  assert.throws(() => validateVectorCommands([{ command: 'file.place', params: { path: '/etc/hosts', rect: [0, 0, 1, 1] } }]));
  assert.throws(() => validateVectorCommands([{ command: 'file.place', params: { kit: '../../.env', rect: [0, 0, 1, 1] } }]));
  assert.throws(() => validateVectorCommands([{ command: 'graphicStyle.loadLibrary', params: { library: 'other' } }]));
  assert.throws(() => validateVectorCommands([{ command: 'graphicStyle.addFromLibrary', params: { library: 'Tasaki Text', name: 'Tasaki Extrude – น้ำเงินเข้ม', apply: true } }]), 'a template she failed is not offered');
  assert.equal(validateVectorCommands([{ command: 'graphicStyle.addFromLibrary', params: { library: 'Tasaki Text', name: TEXT_STYLES['glow-web'].name, apply: true } }]).length, 1);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-'));
  const placed = materializeStep({ command: 'file.place', params: { kit: 'shapes/tasaki-corner-shape.svg', rect: [0, 0, 680, 1] } }, work);
  assert.equal(placed.params.path, path.join(work, 'kit', 'tasaki-corner-shape.svg'), 'copied next to the document');
  assert.ok(fs.existsSync(placed.params.path));
  assert.deepEqual(placed.params.rect, [0, 0, 680, 620]);
  assert.equal(placed.params.kit, undefined);
  const lib = materializeStep({ command: 'graphicStyle.loadLibrary', params: { library: 'tasaki-text' } }, work);
  assert.ok(fs.existsSync(lib.params.path));
  assert.deepEqual(textStyleSteps('glow-web').map(([id]) => id), ['object.group', 'graphicStyle.addFromLibrary']);
  assert.equal(textStyleSteps('nope'), null);
});
