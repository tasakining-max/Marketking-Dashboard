import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function setup(reduced = false) {
  class Element {
    attrs = {}; children = []; style = {}; hidden = false;
    classList = { toggle: (name, value) => { this.hidden = value; } };
    setAttribute(key, value) { this.attrs[key] = value; }
    getAttribute(key) { return this.attrs[key]; }
    append(child) { child.remove(); this.children.push(child); child.parent = this; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); }
    querySelector() { return this.seat ||= new Element(); }
    querySelectorAll(selector) { return selector === '[data-office-thought]' ? this.thoughts || [] : [this.label ||= new Element()]; }
  }
  let callback;
  const context = vm.createContext({ Intl, Map, Set, Math, Date, performance: { now: () => 0 },
    document: { hidden: false, createElementNS: () => new Element() },
    requestAnimationFrame: (fn) => { callback = fn; return 1; },
    matchMedia: () => ({ matches: reduced }),
  });
  context.window = context;
  for (const file of ['office.js', 'officeMotion.js']) vm.runInContext(fs.readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8'), context);
  return { context, walker: context.createOfficeWalker(), svg: new Element(), nextSVG: () => new Element(), tick: (time) => callback(time),
    thought(svg, id) { const el = new Element(); el.setAttribute('data-office-thought', id); (svg.thoughts ||= []).push(el); return el; },
  };
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

test('shows the recipient thought only on arrival and preserves timing across redraws', () => {
  const s = setup();
  const thought = s.thought(s.svg, 'motion');
  s.walker.mount(s.svg); s.walker.observe([], agents);
  s.walker.observe([event('delivery')], agents);
  assert.equal(thought.style.visibility, 'hidden');
  s.tick(1000);
  assert.equal(thought.style.visibility, 'hidden');
  const replacement = s.nextSVG();
  const newThought = s.thought(replacement, 'motion');
  s.walker.mount(replacement);
  assert.equal(newThought.style.visibility, 'hidden');
  const route = s.context.officeWalkRoute('productvideo', 'motion');
  const length = route.slice(1).reduce((n, p, i) => n + Math.hypot(p[0] - route[i][0], p[1] - route[i][1]), 0);
  const arrival = Math.max(2200, length / 150 * 1000);
  s.tick(arrival - 1);
  assert.equal(newThought.style.visibility, 'hidden');
  s.tick(arrival);
  assert.equal(newThought.style.visibility, '');
  const afterArrival = s.nextSVG();
  const finalThought = s.thought(afterArrival, 'motion');
  s.walker.mount(afterArrival);
  assert.equal(finalThought.style.visibility, '', 'stays visible when sender returns');
});

test('waits for queued visitors too and keeps other agents thoughts visible', () => {
  const s = setup();
  const recipient = s.thought(s.svg, 'motion');
  const unrelated = s.thought(s.svg, 'caption');
  s.walker.mount(s.svg); s.walker.observe([], agents);
  s.context.document.hidden = true;
  s.walker.observe([event('queued-delivery')], agents);
  assert.equal(recipient.style.visibility, 'hidden');
  assert.equal(unrelated.style.visibility, '');
});
