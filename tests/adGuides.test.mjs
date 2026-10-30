import test from 'node:test';
import assert from 'node:assert/strict';
import { guideSteps } from '../lib/adGuides.js';

const story = { size: [1080, 1920], crops: [{ name: '4x5', rect: [0, 285, 1080, 1350] }, { name: '1x1', rect: [0, 420, 1080, 1080] }] };

test('story frame gets crop lines and the Story/Reel simulation, each hidden, locked and non-printing', () => {
  const steps = guideSteps(story);
  const layers = steps.filter(([id]) => id === 'layer.new').map(([, p]) => p.name);
  assert.deepEqual(layers, ['เส้นครอป (ไม่พิมพ์)', 'จำลอง Story/Reel UI (ไม่พิมพ์)']);
  const locks = steps.filter(([id]) => id === 'layer.setProps').map(([, p]) => p);
  assert.equal(locks.length, 2);
  for (const p of locks) assert.deepEqual(p, { visible: false, locked: true, printable: false });
  assert.ok(steps.some(([id, p]) => id === 'text.create' && p.text === '1:1'));
});

test('feed frame has neither guide', () => {
  assert.deepEqual(guideSteps({ size: [1080, 1350], crops: [] }), []);
});
