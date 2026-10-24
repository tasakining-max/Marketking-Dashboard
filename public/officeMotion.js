// Animate real handoffs once, keeping the walking character across office polls.
(function (root) {
  'use strict';
  root.createOfficeWalker = function () {
    const seen = new Set();
    const queue = [];
    let initialized = false, svg = null, active = null, frame = null;
    const ns = 'http://www.w3.org/2000/svg';
    const reduced = () => root.matchMedia('(prefers-reduced-motion: reduce)').matches;
    function node(tag, attrs, text) {
      const el = document.createElementNS(ns, tag);
      for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
      if (text) el.textContent = text;
      return el;
    }
    function hideSeat(id, hidden) {
      if (!svg) return;
      const seat = svg.querySelector(`[data-agent="${id}"]`);
      seat?.classList.toggle('office-away', hidden);
      for (const el of svg.querySelectorAll(`[data-office-label="${id}"], [data-gear="${id}"], [data-review="${id}"]`)) el.style.visibility = hidden ? 'hidden' : '';
    }
    function syncThoughts() {
      if (!svg) return;
      const waiting = new Set(reduced() ? [] : queue.map((item) => item.to.id));
      if (active && !active.arrived && !reduced()) waiting.add(active.to.id);
      for (const thought of svg.querySelectorAll('[data-office-thought]')) {
        thought.style.visibility = waiting.has(thought.getAttribute('data-office-thought')) ? 'hidden' : '';
      }
    }
    function start() {
      if (active || !svg || !queue.length || document.hidden) return;
      const item = queue.shift();
      const route = root.officeWalkRoute(item.from.id, item.to.id);
      if (!route || reduced()) { start(); return; }
      const legs = route.slice(1).map((p, i) => ({ a: route[i], b: p, distance: Math.hypot(p[0] - route[i][0], p[1] - route[i][1]) }));
      const length = legs.reduce((n, p) => n + p.distance, 0);
      const duration = Math.max(2200, length / 150 * 1000);
      const group = node('g', { class: 'office-walker', 'pointer-events': 'none', role: 'img', 'aria-label': `${item.from.name} ส่งงานให้ ${item.to.name}` });
      group.append(node('ellipse', { cy: 0, rx: 36, ry: 12, fill: '#2f80ed', 'fill-opacity': '.12', stroke: '#2f80ed', 'stroke-width': 2 }));
      const sprite = node('g', { class: 'office-walk-sprite' });
      sprite.append(node('image', { href: item.from.avatar, x: -50, y: -92, width: 100, height: 100, preserveAspectRatio: 'xMidYMid meet' }));
      group.append(sprite);
      group.append(node('rect', { x: -100, y: -124, width: 200, height: 25, rx: 9, fill: '#fff', stroke: '#94bde9' }));
      const label = node('text', { y: -107, 'text-anchor': 'middle', 'font-size': 13, 'font-weight': 700, fill: '#24527e' }, `${item.from.name} → ${item.to.name}`);
      group.append(label);
      active = { ...item, group, sprite, label, legs, length, duration, start: performance.now(), arrived: false };
      hideSeat(item.from.id, true);
      syncThoughts();
      svg.append(group);
      frame = requestAnimationFrame(tick);
    }
    function position(distance) {
      for (const leg of active.legs) {
        if (distance <= leg.distance) {
          const t = leg.distance ? distance / leg.distance : 0;
          return [leg.a[0] + (leg.b[0] - leg.a[0]) * t, leg.a[1] + (leg.b[1] - leg.a[1]) * t];
        }
        distance -= leg.distance;
      }
      return active.legs.at(-1).b;
    }
    function tick(now) {
      if (!active) return;
      const elapsed = now - active.start;
      if (!active.arrived && elapsed >= active.duration) {
        active.arrived = true;
        syncThoughts();
      }
      const returning = elapsed > active.duration + 1300;
      const progress = returning ? Math.max(0, 1 - (elapsed - active.duration - 1300) / active.duration) : Math.min(1, elapsed / active.duration);
      const [x, y] = position(progress * active.length);
      active.group.setAttribute('transform', `translate(${x},${y})`);
      const waiting = elapsed >= active.duration && !returning;
      active.sprite.setAttribute('transform', waiting || reduced() ? '' : `translate(0,${Math.sin(elapsed / 95) * 3}) rotate(${Math.sin(elapsed / 140) * 2},0,-30)`);
      active.label.textContent = waiting ? `ส่งงานให้ ${active.to.name}` : returning ? `${active.from.name} กลับโต๊ะ` : `${active.from.name} → ${active.to.name}`;
      if (elapsed >= active.duration * 2 + 1300 || reduced()) {
        hideSeat(active.from.id, false);
        active.group.remove(); active = null; frame = null; start(); syncThoughts(); return;
      }
      frame = requestAnimationFrame(tick);
    }
    return {
      observe(events, agents) {
        const byId = new Map(agents.map((a) => [a.id, a]));
        const fresh = [...(events || [])].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
        for (const event of fresh) {
          if (!event.id || seen.has(event.id)) continue;
          seen.add(event.id);
          if (!initialized || reduced() || event.kind !== 'handoff' || event.agent === event.toAgent
            || Date.now() - new Date(event.createdAt).getTime() > 20000) continue;
          const from = byId.get(event.agent), to = byId.get(event.toAgent);
          if (from && to && root.officeWalkRoute(from.id, to.id)) queue.push({ from, to });
        }
        initialized = true;
        while (seen.size > 1000) seen.delete(seen.values().next().value);
        if (queue.length > 20) queue.splice(0, queue.length - 20);
        start();
        syncThoughts();
      },
      mount(next) {
        svg = next;
        if (active) { hideSeat(active.from.id, true); svg.append(active.group); }
        else start();
        syncThoughts();
      },
    };
  };
})(window);
