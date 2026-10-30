import test from 'node:test';
import assert from 'node:assert/strict';
import { sceneBands, sceneBrief } from '../lib/sceneBrief.js';

const story = { size: [1080, 1920], crops: [{ name: '4x5', rect: [0, 285, 1080, 1350] }, { name: '1x1', rect: [0, 420, 1080, 1080] }] };

test('bands put the whole subject inside the 1:1 square and leave the sky for the headline', () => {
  const b = sceneBands(story);
  assert.equal(b.top, 420);
  assert.equal(b.bottom, 1500);
  assert.deepEqual(b.skyClear, [430, 690]);
  assert.deepEqual(b.panels, [700, 790]);
  assert.deepEqual(b.shop, [850, 1480]);
  assert.deepEqual(b.acZone, [335, 860, 745, 1090]);
  assert.ok(b.peopleHeadY > b.acZone[3] && b.floor < b.bottom);
});

test('the brief carries the scene and the pixel bands', () => {
  const t = sceneBrief(story, 'ร้านซักอบรีด');
  assert.match(t, /ฉาก: ร้านซักอบรีด/);
  assert.match(t, /y 700–1490/);
  assert.match(t, /x 335–745, y 860–1090/);
  assert.match(t, /ปิดสนิท/);
});

import { genSize } from '../lib/sceneBrief.js';
test('image_gen size keeps the exact ratio, multiples of 16, not smaller than the master', () => {
  assert.deepEqual(genSize([1080, 1920]), [1152, 2048]);
  assert.deepEqual(genSize([1080, 1350]), [1088, 1360]);
  for (const s of [[1080, 1920], [1080, 1350]]) {
    const [w, h] = genSize(s);
    assert.equal(w % 16, 0); assert.equal(h % 16, 0);
    assert.ok(Math.abs(w / h - s[0] / s[1]) < 1e-9 && w >= s[0] && h >= s[1]);
  }
});

import { acRect } from '../lib/adRecipe.js';
test('the AC hangs from the same top edge, any aspect', () => {
  const [x, y, w, h] = acRect([1034, 258]);
  assert.equal(y, 872); assert.ok(w > 250 && h < 100);
  assert.ok(Math.abs(x + w / 2 - 552) <= 1);
  const [, , w2, h2] = acRect([1967, 1411]);
  assert.ok(h2 <= 150 && w2 / h2 > 1.3);
});

test('a wall unit is drawn smaller than a ceiling-hung one, in real proportion', () => {
  const wall = acRect([1000, 300], 'FWCE-I-AF1M Solar Hybrid');
  const hung = acRect([1000, 300], 'FUNE-I-AF2 Solar Hybrid');
  assert.ok(wall[2] <= 235 && hung[2] > wall[2] && hung[2] <= 305);
});
