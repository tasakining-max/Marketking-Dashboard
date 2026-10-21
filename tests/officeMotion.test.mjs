import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function setup(reduced = false) {
  class Element {
    attrs = {}; children = []; style = {}; hidden = false;
    classList = { toggle: (name, value) => { this.hidden = value; } };
    setAttribute(key, value) { this.attrs[key] = value; }
    append(child) { child.remove(); this.children.push(child); child.parent = this; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); }
    querySelector() { return this.seat ||= new Element(); }
    querySelectorAll() { return [this.label ||= new Element()]; }
  }
  let callback;
  const context = vm.createContext({ Intl, Map, Set, Math, Date, performance: { now: () => 0 },
    document: { hidden: false, createElementNS: () => new Element() },
    requestAnimationFrame: (fn) => { callback = fn; return 1; },
    matchMedia: () => ({ matches: reduced }),
  });
  context.window = context;
  for (const file of ['office.js', 'officeMotion.js']) vm.runInContext(fs.readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8'), context);
  return { context, walker: context.createOfficeWalker(), svg: new Element(), nextSVG: () => new Element(), tick: (time) => callback(time) };
}
const agents = [{ id: 'productvideo', name: 'VDO', avatar: 'vdo.png' }, { id: 'motion', name: 'EFF', avatar: 'eff.png' }];
const event = (id, overrides = {}) => ({ id, agent: 'productvideo', toAgent: 'motion', kind: 'handoff', createdAt: new Date().toISOString(), ...overrides });

test('walks a new real handoff once and keeps the same character across office refreshes', () => {
  const s = setup();
  s.walker.mount(s.svg);
  s.walker.observe([event('old')], agents);
  assert.equal(s.svg.children.length, 0, 'does not replay history on load');
  s.walker.observe([event('new')], agents);
  const character = s.svg.children[0];
  assert.ok(character);
  assert.equal(s.svg.seat.hidden, true);
  s.tick(1000);
  assert.match(character.attrs.transform, /translate/);
  const replacement = s.nextSVG();
  s.walker.mount(replacement);
  assert.equal(replacement.children[0], character);
  s.walker.observe([event('new')], agents);
  s.tick(1000000);
  assert.equal(replacement.children.length, 0, 'returns without replaying the event');
  assert.equal(replacement.seat.hidden, false);
  assert.equal(replacement.label.style.visibility, '');
});

test('ignores user messages, expired events, and self handoffs', () => {
  const s = setup(); s.walker.mount(s.svg); s.walker.observe([], agents);
  s.walker.observe([
    event('user', { agent: 'you' }), event('self', { toAgent: 'productvideo' }),
    event('expired', { createdAt: new Date(Date.now() - 60000).toISOString() }),
  ], agents);
  assert.equal(s.svg.children.length, 0);
});

test('respects reduced motion and routes cross-room visits through the corridor', () => {
  const s = setup(true); s.walker.mount(s.svg); s.walker.observe([], agents); s.walker.observe([event('new')], agents);
  assert.equal(s.svg.children.length, 0);
  const route = s.context.officeWalkRoute('layout', 'motion');
  assert.ok(route.length > s.context.officeWalkRoute('productvideo', 'motion').length);
  assert.ok(route.every((p) => p.every(Number.isFinite)));
  assert.equal(s.context.officeWalkRoute('you', 'motion'), null);
  assert.equal(s.context.officeWalkRoute('motion', 'motion'), null);
});
