// The AI team's office: an isometric room drawn as one SVG. Pure function of
// the team's live state (no DOM, no fetch), so the page just swaps the SVG in
// and the same code can be rendered offline to check how it looks.
(function (root) {
  'use strict';

  const U = 48;          // px per grid unit along x
  const ROOM = 18;       // room is ROOM x ROOM grid units
  const WALL = 275;      // wall height in px
  const OX = 900;        // screen position of grid (0,0): the back corner
  const OY = 315;
  const W = 1800;
  const H = 1310;

  // grid -> screen (isometric 2:1); z lifts a point straight up
  const P = (gx, gy, gz = 0) => [OX + (gx - gy) * U, OY + ((gx + gy) * U) / 2 - gz];
  const pt = (p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`;
  const poly = (pts, attrs = '') => `<polygon points="${pts.map(pt).join(' ')}" ${attrs}/>`;
  const esc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // Opposing seats share a room; front seats face back across the table group.
  const SEATS = {
    adideas: [1.4, 2.2], caption: [1.4, 5.0],
    layout: [10.8, 2.2], image: [14.1, 2.2], assemble: [12.4, 5.0],
    productvideo: [10.8, 11.4], motion: [10.8, 14.2],
    catalog: [4.7, 11.4], rival: [1.4, 11.4], website: [1.4, 14.2], ads: [4.7, 14.2],
  };
  const FRONT_SEATS = new Set(['ads', 'caption', 'assemble', 'motion', 'website']);
  const ZONES = [
    { label: 'ไอเดีย · เนื้อหา', x0: 0.4, x1: 7.6, y0: 0.8, y1: 8.0, fill: '#EDF6FC' },
    { label: 'สตูดิโอภาพ', x0: 9.8, x1: 17.5, y0: 0.8, y1: 8.0, fill: '#CBE7F8' },
    { label: 'ผู้ช่วย · ดึง วิเคราะห์ Data', x0: 0.4, x1: 7.6, y0: 10.0, y1: 17.5, fill: '#D8E2EF' },
    { label: 'วิดีโอ · แอนิเมชัน', x0: 9.8, x1: 17.5, y0: 10.0, y1: 17.5, fill: '#B9D4ED' },
  ];
  const FLOW = ['layout', 'image', 'assemble', 'motion'];
  const clockFormatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const officeClockText = (now = new Date()) => clockFormatter.format(now);

  function officeWalkRoute(from, to) {
    if (!SEATS[from] || !SEATS[to] || from === to) return null;
    const exit = (id) => {
      const [x, y] = SEATS[id];
      const room = ZONES.find((z) => x >= z.x0 && x < z.x1 && y >= z.y0 && y < z.y1);
      const seatY = FRONT_SEATS.has(id) ? y + 1.75 : y - .55;
      const middle = (room.x0 + room.x1) / 2;
      return { room, middle, corridor: room.y1 < 10 ? 9 : 17.85,
        points: [[x + .95, seatY], [x - .5, seatY], [x - .5, room.y1 - .45], [middle, room.y1 - .45], [middle, room.y1 + .25]] };
    };
    const a = exit(from), b = exit(to);
    let grid;
    if (a.room === b.room) {
      grid = [...a.points.slice(0, 3), ...b.points.slice(0, 3).reverse()];
    } else {
      grid = [...a.points, [a.middle, a.corridor], [8.7, a.corridor], [8.7, b.corridor], [b.middle, b.corridor], ...b.points.slice().reverse()];
    }
    return grid.filter((p, i) => !i || p[0] !== grid[i - 1][0] || p[1] !== grid[i - 1][1])
      .map(([x, y]) => { const p = P(x, y); return [p[0], p[1] - 36]; });
  }

  // a box from grid (gx,gy) with size (w,d) between heights z0..z1.
  // front faces: A faces lower-left (gy+d), B faces lower-right (gx+w).
  function box(gx, gy, w, d, z0, z1, c, faceA) {
    const top = [P(gx, gy, z1), P(gx + w, gy, z1), P(gx + w, gy + d, z1), P(gx, gy + d, z1)];
    const A = [P(gx, gy + d, z1), P(gx + w, gy + d, z1), P(gx + w, gy + d, z0), P(gx, gy + d, z0)];
    const B = [P(gx + w, gy, z1), P(gx + w, gy + d, z1), P(gx + w, gy + d, z0), P(gx + w, gy, z0)];
    return poly(A, faceA || `fill="${c.a}"`) + poly(B, `fill="${c.b}"`) + poly(top, `fill="${c.t}"`);
  }

  function plant(gx, gy, scale = 1) {
    const [x, y] = P(gx, gy);
    return `<g transform="translate(${x},${y}) scale(${scale})" aria-label="ต้นไม้">`
      + '<ellipse cy="3" rx="18" ry="6" fill="#25483e" opacity=".1"/>'
      + '<path d="M-13,-23 L13,-23 L10,0 Q0,6 -10,0 Z" fill="#e5d8c5" stroke="#cbbba4"/>'
      + '<ellipse cy="-23" rx="13" ry="5" fill="#8b7962"/>'
      + '<path d="M0,-23 Q-5,-44 2,-65 M0,-30 Q-19,-43 -19,-54 M0,-35 Q20,-48 19,-59" fill="none" stroke="#42876c" stroke-width="3"/>'
      + '<ellipse cx="-13" cy="-46" rx="8" ry="17" transform="rotate(-38 -13 -46)" fill="#58a47f"/>'
      + '<ellipse cx="13" cy="-49" rx="8" ry="18" transform="rotate(37 13 -49)" fill="#78b693"/>'
      + '<ellipse cx="2" cy="-62" rx="8" ry="16" fill="#39876a"/></g>';
  }

  // Thai has no spaces: break on word boundaries when the browser can tell us
  // where they are, else fall back to a plain character count.
  const seg = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('th', { granularity: 'word' }) : null;
  function wrap(text, n = 16, lines = 3) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    const words = seg ? [...seg.segment(s)].map((x) => x.segment) : s.match(/.{1,4}/g) || [];
    const out = [];
    let cur = '';
    let cut = false;
    for (const w of words) {
      if ((cur + w).length > n && cur) {
        out.push(cur.trim());
        cur = '';
        if (out.length >= lines) { cut = true; break; }
      }
      cur += w;
    }
    if (!cut && cur.trim()) out.push(cur.trim());
    if (cut && out.length) out[out.length - 1] = `${out[out.length - 1].slice(0, n - 1)}…`;
    return out.slice(0, lines);
  }

  function cloud(cx, cy, text, live) {
    const lines = wrap(text);
    if (!lines.length) return '';
    const w = Math.max(...lines.map((l) => l.length)) * 11 + 22;
    const h = lines.length * 17 + 14;
    const x = cx - w / 2;
    const y = cy - h;
    return `<g class="office-cloud${live ? ' live' : ''}">`
      + `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w}" height="${h}" rx="12" fill="#fff" stroke="#c9d3de"/>`
      + `<polygon points="${cx - 7},${cy} ${cx + 7},${cy} ${cx},${cy + 9}" fill="#fff" stroke="#c9d3de"/>`
      + `<polygon points="${cx - 6},${cy - 1} ${cx + 6},${cy - 1} ${cx},${cy + 7}" fill="#fff"/>`
      + lines.map((l, i) => `<text x="${cx}" y="${(y + 21 + i * 17).toFixed(1)}" text-anchor="middle" font-size="13" fill="#27323f">${esc(l)}</text>`).join('')
      + '</g>';
  }

  function buildOfficeSVG(data) {
    const { agents = [], meta = {}, avatarUrl = (a) => a.avatar, flowActive = false } = data;
    const byId = new Map(agents.map((a) => [a.id, a]));
    const out = [];
    const over = []; // clouds, badges: drawn last so nothing covers them

    // ── room shell
    out.push(`<defs>
      <filter id="of-aura-glow" x="-50%" y="-100%" width="200%" height="300%"><feGaussianBlur stdDeviation="3"/></filter>
      <linearGradient id="of-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#159fe8" stop-opacity=".23"/><stop offset=".5" stop-color="#159fe8" stop-opacity=".07"/><stop offset="1" stop-color="#159fe8" stop-opacity="0"/></linearGradient>
    </defs>`);
    out.push(poly([P(0, 0), P(ROOM, 0), P(ROOM, ROOM), P(0, ROOM)], 'fill="#D5E0EA" stroke="#b7cbdc"'));
    for (let i = 1; i < ROOM; i++) {
      out.push(`<line x1="${P(i, 0)[0]}" y1="${P(i, 0)[1]}" x2="${P(i, ROOM)[0]}" y2="${P(i, ROOM)[1]}" stroke="rgba(0,0,0,.05)"/>`);
      out.push(`<line x1="${P(0, i)[0]}" y1="${P(0, i)[1]}" x2="${P(ROOM, i)[0]}" y2="${P(ROOM, i)[1]}" stroke="rgba(0,0,0,.05)"/>`);
    }
    for (const z of ZONES) {
      out.push(poly([P(z.x0, z.y0), P(z.x1, z.y0), P(z.x1, z.y1), P(z.x0, z.y1)], `fill="${z.fill}" stroke="#159FE8" stroke-opacity=".3" stroke-width="1"`));
    }
    // the picture line on the floor
    const seatPt = (id) => P(SEATS[id][0] + 0.95, SEATS[id][1] + 1.35);
    const flowPts = FLOW.map(seatPt);
    out.push(`<polyline points="${flowPts.map(pt).join(' ')}" fill="none" stroke="${flowActive ? '#2f80ed' : '#9bb0c6'}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" class="office-flow${flowActive ? ' on' : ''}"/>`);
    // Video planning and animation also share a collaboration route.
    out.push(`<polyline points="${['productvideo', 'motion'].map((id) => pt(seatPt(id))).join(' ')}" fill="none" stroke="#9b87be" stroke-width="4" stroke-dasharray="8 7" opacity=".7"/>`);
    // Floor-to-ceiling glazing replaces the solid outer walls and windows.
    out.push(poly([P(0, 0, WALL), P(0, ROOM, WALL), P(0, ROOM), P(0, 0)], 'fill="url(#of-sky)" stroke="#68bbed" stroke-opacity=".6" stroke-width="1.5"'));
    out.push(poly([P(0, 0, WALL), P(ROOM, 0, WALL), P(ROOM, 0), P(0, 0)], 'fill="url(#of-sky)" stroke="#68bbed" stroke-opacity=".6" stroke-width="1.5"'));
    for (let i = 0; i <= ROOM; i += 3) {
      for (const [x, y] of [[0, i], [i, 0]]) {
        out.push(`<polyline points="${[P(x, y, 0), P(x, y, WALL)].map(pt).join(' ')}" fill="none" stroke="#78c5ef" stroke-opacity=".5" stroke-width="1.5"/>`);
      }
      if (i < ROOM) {
        out.push(poly([P(0, i + .25, WALL - 12), P(0, i + .55, WALL - 12), P(0, i + 2.5, 16), P(0, i + 2.2, 16)], 'fill="#ffffff" opacity=".2" pointer-events="none"'));
        out.push(poly([P(i + .25, 0, WALL - 12), P(i + .55, 0, WALL - 12), P(i + 2.5, 0, 16), P(i + 2.2, 0, 16)], 'fill="#ffffff" opacity=".16" pointer-events="none"'));
      }
    }
    const glassRim = [P(0, ROOM, WALL), P(0, 0, WALL), P(ROOM, 0, WALL)].map(pt).join(' ');
    out.push(`<polyline points="${glassRim}" fill="none" stroke="#159fe8" stroke-width="6" stroke-opacity=".3" filter="url(#of-aura-glow)"/>`
      + `<polyline points="${glassRim}" fill="none" stroke="#62c8ff" stroke-width="2" stroke-opacity=".85"/>`);

    // A luminous wall dashboard, drawn in the wall's own coordinate plane.
    const wallDisplayTop = WALL - 34;
    const wallDisplayScale = .9;
    const wallDisplayMatrix = `${wallDisplayScale},${wallDisplayScale / 2},0,${wallDisplayScale}`;
    const [hudX, hudY] = P(2.0, 0, wallDisplayTop);
    const hudColor = meta.paused ? '#ffbd75' : meta.working ? '#64c8ff' : '#9baec4';
    const hudStatus = meta.paused ? 'หยุดอยู่' : meta.working ? 'กำลังเข้างาน' : 'นอกเวลางาน';
    const metrics = [
      { label: 'วันนี้ทำไป', value: meta.today ?? 0, color: '#64c8ff' },
      { label: 'ทำอยู่', value: meta.running ?? 0, color: '#7bcaff' },
      { label: 'รอคิว', value: meta.queued ?? 0, color: '#ffd28b' },
      { label: 'รอตัดสิน', value: meta.review ?? 0, color: '#c4b4ff' },
    ];
    out.push(`<g class="office-hud" transform="matrix(${wallDisplayMatrix},${hudX},${hudY})" aria-label="ภาพรวมสถานะทีม AI">
      <defs><linearGradient id="of-hud-bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#123655"/><stop offset=".55" stop-color="#0b2038"/><stop offset="1" stop-color="#10192c"/></linearGradient></defs>
      <rect x="-5" y="-5" width="394" height="159" rx="13" fill="none" stroke="#159fe8" stroke-width="4" opacity=".3" filter="url(#of-aura-glow)"/>
      <rect width="384" height="149" rx="10" fill="url(#of-hud-bg)" stroke="#377fbc" stroke-width="2"/>
      <path d="M12,30 V12 H37 M347,12 H372 V30 M12,119 V137 H37 M347,137 H372 V119" fill="none" stroke="#8bd6ff" stroke-width="2"/>
      <path d="M16,47 H368" stroke="#64c8ff" stroke-opacity=".2"/>
      <g fill="#64c8ff"><rect x="23" y="21" width="6" height="6" rx="1"/><rect x="32" y="21" width="6" height="6" rx="1"/><rect x="23" y="30" width="6" height="6" rx="1"/><rect x="32" y="30" width="6" height="6" rx="1"/></g>
      <text x="49" y="35" font-size="22" font-weight="700" fill="#eff8ff">ทีม AI</text>
      <rect x="229" y="16" width="133" height="25" rx="12" fill="${hudColor}" fill-opacity=".08" stroke="${hudColor}" stroke-opacity=".3"/>
      <circle class="office-hud-signal" cx="243" cy="28" r="3" fill="${hudColor}"/>
      <text x="255" y="33" font-size="12" font-weight="600" fill="${hudColor}">${hudStatus}</text>`);
    for (const [i, metric] of metrics.entries()) {
      const x = 21 + i * 88;
      out.push(`<g><rect x="${x}" y="58" width="78" height="65" rx="7" fill="${metric.color}" fill-opacity=".045" stroke="${metric.color}" stroke-opacity=".17"/>
        <text x="${x + 11}" y="76" font-size="12" fill="#b2cad8">${metric.label}</text>
        <text x="${x + 11}" y="108" font-size="29" font-weight="700" fill="${metric.color}" font-family="ui-monospace,monospace">${esc(metric.value)}</text>
        <path d="M${x + 11},116 H${x + 33}" stroke="${metric.color}" stroke-width="2" opacity=".6"/></g>`);
    }
    out.push('<path d="M160,136 H224" stroke="#64c8ff" stroke-width="2" stroke-linecap="round" opacity=".5"/></g>');

    // plants
    for (const [gx, gy] of [[12.4, 0.7], [0.5, 12.4]]) {
      const [x, y] = P(gx, gy);
      out.push(`<ellipse cx="${x}" cy="${y + 4}" rx="20" ry="8" fill="rgba(0,0,0,.12)"/><rect x="${x - 12}" y="${y - 26}" width="24" height="28" rx="4" fill="#b5651d"/>`
        + `<circle cx="${x}" cy="${y - 46}" r="22" fill="#3b9d54"/><circle cx="${x - 14}" cy="${y - 38}" r="14" fill="#2f8a47"/><circle cx="${x + 14}" cy="${y - 40}" r="15" fill="#4cb868"/>`);
    }

    // Glass room partitions with open doorways onto the central cross aisle.
    for (const z of ZONES) {
      const glass = (x0, y0, x1, y1) => {
        out.push(poly([P(x0, y0, 0), P(x1, y1, 0), P(x1, y1, 92), P(x0, y0, 92)], 'fill="url(#of-sky)" stroke="#68bbed" stroke-opacity=".55" stroke-width="1.5"'));
        const rim = [P(x0, y0, 92), P(x1, y1, 92)].map(pt).join(' ');
        out.push(`<polyline points="${rim}" fill="none" stroke="#159fe8" stroke-opacity=".22" stroke-width="5" filter="url(#of-aura-glow)"/>`
          + `<polyline points="${rim}" fill="none" stroke="#62c8ff" stroke-opacity=".75" stroke-width="1.5"/>`);
      };
      out.push(`<g class="office-room" aria-label="${esc(z.label)}">`);
      glass(z.x0, z.y0, z.x1, z.y0);
      glass(z.x0, z.y0, z.x0, z.y1);
      // Transparent side panels and doorway openings keep each room distinct.
      const mid = (z.x0 + z.x1) / 2;
      for (const [x0, x1] of [[z.x0, mid - .7], [mid + .7, z.x1]]) {
        glass(x0, z.y1, x1, z.y1);
      }
      glass(z.x1, z.y0, z.x1, z.y1);
      const [lx, ly] = P(z.x0, z.y1 - .55, 64);
      out.push(`<text transform="matrix(1,-0.5,0,1,${lx.toFixed(1)},${ly.toFixed(1)})" font-size="18" font-weight="700" fill="#415568">${esc(z.label)}</text></g>`);
    }

    // Shared comforts sit inside the rooms, clear of the central walkways.
    out.push('<g class="office-decor" aria-label="มุมกาแฟ ชั้นหนังสือ และมุมพักผ่อน" pointer-events="none">');
    // A compact bookcase in the content room.
    const shelf = { t: '#cdbfa8', a: '#e5d9c6', b: '#baaa91' };
    out.push(box(5.4, 1.25, 1.5, .48, 0, 66, shelf));
    for (const z of [8, 31, 54]) {
      out.push(box(5.5, 1.74, 1.3, .05, z, z + 3, { t: '#f4ebdf', a: '#bfae95', b: '#aa987e' }));
      for (const [i, color] of ['#5eaaa3', '#e0ac75', '#859bb5', '#b494ae', '#8fa884'].entries()) {
        out.push(box(5.56 + i * .22, 1.7, .14, .1, z + 3, z + 17 + i % 2 * 3, { t: color, a: color, b: color }));
      }
    }
    out.push(plant(6.45, 1.48, .42));
    // Coffee counter: machine, cups and a small plant.
    out.push(box(.95, 10.6, 1.8, .7, 0, 39, { t: '#e4ded4', a: '#b4c5bc', b: '#90a99b' }));
    out.push(box(1.12, 10.72, .58, .4, 39, 67, { t: '#56616a', a: '#37434e', b: '#25323b' }));
    out.push(box(1.24, 11.13, .26, .04, 45, 55, { t: '#b9d8d5', a: '#a4ceca', b: '#80b7b2' }));
    out.push(plant(2.5, 10.9, .32));
    const [coffeeX, coffeeY] = P(1.99, 11.0, 42);
    out.push(`<ellipse cx="${coffeeX}" cy="${coffeeY + 3}" rx="9" ry="4" fill="#f8f6f0"/><rect x="${coffeeX - 5}" y="${coffeeY - 10}" width="10" height="12" rx="3" fill="#fff"/><ellipse cx="${coffeeX}" cy="${coffeeY - 9}" rx="5" ry="2" fill="#8c644c"/>`);
    // A quiet lounge beside the video team.
    out.push(poly([P(14, 11.3), P(17, 11.3), P(17, 16.2), P(14, 16.2)], 'fill="#cbdcd9" opacity=".65"'));
    const sofa = { t: '#2678b9', a: '#1d5e96', b: '#164b79' };
    out.push(box(14.5, 11.7, 2.0, .95, 8, 29, sofa));
    out.push(box(14.5, 11.7, 2.0, .18, 28, 54, sofa));
    for (const x of [14.5, 16.3]) out.push(box(x, 11.7, .2, .95, 26, 43, sofa));
    for (const x of [14.8, 15.6]) out.push(box(x, 11.95, .65, .52, 29, 33, { t: '#4b94cc', a: '#347bb3', b: '#28679a' }));
    out.push(box(14.9, 14.0, 1.2, .85, 0, 21, { t: '#e8dcc9', a: '#c4b59e', b: '#b3a28a' }));
    out.push(box(15.1, 14.2, .48, .34, 21, 24, { t: '#f5efe4', a: '#d6cab6', b: '#abbea9' }));
    for (const [x, y] of [[6.7, 6.8], [16.8, 6.8], [6.7, 16.5], [16.7, 16.0]]) out.push(plant(x, y, .65));
    // Digital wall clock; its text updates independently of office polling.
    const [clockX, clockY] = P(14.0, 0, wallDisplayTop);
    out.push(`<g class="office-clock" transform="matrix(${wallDisplayMatrix},${clockX},${clockY})" role="timer" aria-label="เวลาประเทศไทย">
      <rect x="-3" y="-3" width="154" height="67" rx="10" fill="none" stroke="#159fe8" stroke-width="4" opacity=".3" filter="url(#of-aura-glow)"/>
      <rect width="148" height="61" rx="8" fill="#0b2038" stroke="#159fe8" stroke-width="2"/>
      <text x="74" y="17" text-anchor="middle" font-size="10" fill="#a2c4df">เวลาไทย · ICT</text>
      <text data-office-clock="true" x="74" y="44" text-anchor="middle" font-family="ui-monospace,monospace" font-size="24" font-weight="700" fill="#7ed0ff">${officeClockText()}</text>
      <path d="M52,53 H96" stroke="#159fe8" stroke-width="2" stroke-linecap="round"/></g>`);
    out.push('</g>');

    // ── seats, painted back to front
    const items = Object.entries(SEATS).map(([id, [gx, gy]]) => ({ id, gx, gy, depth: gx + gy })).sort((a, b) => a.depth - b.depth);
    const desk = { t: '#c9cdd2', a: '#979da5', b: '#777f89' };
    for (const it of items) {
      const a = byId.get(it.id);
      if (!a) continue;
      const { gx, gy } = it;
      const w = 1.9;
      const d = 1.1;
      const h = 26;
      const status = a.status || 'idle';
      const working = status === 'working';
      const cx = gx + w / 2;
      const front = FRONT_SEATS.has(it.id);
      const seatY = front ? gy + d + .65 : gy - .55;
      const [ax, ay] = P(cx, seatY, h - 8);
      const g = [];
      const R = 44;                 // half the character image height
      const ty = ay - 62;           // character centre
      const ring = working ? '#2f80ed' : status === 'review' ? '#2b8a3e' : status === 'queued' ? '#e67700' : '#aab6c3';
      const aura = status === 'idle' ? '#36b9b0' : ring;
      const groundY = ay - 18;
      g.push(`<g class="office-aura${working ? ' working' : ''}" pointer-events="none">`
        + `<ellipse cx="${ax}" cy="${groundY}" rx="40" ry="14" fill="${aura}" opacity=".25" filter="url(#of-aura-glow)"/>`
        + `<ellipse cx="${ax}" cy="${groundY}" rx="36" ry="12" fill="${aura}" fill-opacity=".08" stroke="${aura}" stroke-width="2" stroke-opacity=".8"/>`
        + `<ellipse cx="${ax}" cy="${groundY}" rx="29" ry="9" fill="none" stroke="${aura}" stroke-width="1" stroke-opacity=".3"/></g>`);
      const avatar = `<g class="office-avatar${working ? ' working' : ''}${status === 'idle' ? ' idle' : ''}">`
        + `<image href="${esc(avatarUrl(a))}" x="${(ax - R - 6).toFixed(1)}" y="${(ty - R - 4).toFixed(1)}" width="${(R + 6) * 2}" height="${(R + 6) * 2}" preserveAspectRatio="xMidYMid meet"/></g>`;
      if (!front) g.push(avatar);
      // desk, monitor (screen faces the viewer), papers when jobs are queued
      g.push(box(gx, gy, w, d, 0, h, desk));
      const screen = working ? 'class="office-screen on" fill="#74e4ff"' : status === 'review' ? 'fill="#9be08f"' : 'fill="#2a3949"';
      const monitorY = front ? gy + .16 : gy + .78;
      g.push(box(gx + 0.55, monitorY, 0.85, 0.08, h, h + 34, { t: '#26313d', a: '#26313d', b: '#1b242d' }, screen));
      g.push(box(gx + 0.85, monitorY, 0.25, 0.1, h, h + 6, { t: '#444', a: '#3a3a3a', b: '#2f2f2f' }));
      const keyboardY = front ? gy + .7 : gy + .25;
      g.push(box(gx + .65, keyboardY, .65, .22, h, h + 2, { t: '#e7ebef', a: '#b7c0c9', b: '#a4aeb8' }));
      const [mugX, mugY] = P(gx + .24, gy + .52, h + 3);
      g.push(`<path d="M${mugX + 5},${mugY - 9} q8,0 5,7 h-5" fill="none" stroke="#80b9b2" stroke-width="2"/><rect x="${mugX - 5}" y="${mugY - 12}" width="11" height="13" rx="3" fill="#c6e3dd"/><ellipse cx="${mugX + .5}" cy="${mugY - 11}" rx="5" ry="2" fill="#80614d"/>`);
      if (front) g.push(avatar);
      const pile = Math.min(a.queued || 0, 3);
      for (let p = 0; p < pile; p++) g.push(box(gx + 1.45, gy + 0.55, 0.38, 0.3, h + p * 3, h + p * 3 + 3, { t: '#ffffff', a: '#e9edf2', b: '#dfe5ec' }));
      // Name and status stay above the character and clear of the furniture.
      const nx = ax;
      const ny = ty - R - 66;
      const label = a.name || a.id;
      const sub = working ? (a.doing || 'กำลังทำงาน…') : status === 'review' ? 'รอคุณตัดสิน' : status === 'queued' ? `รอคิว ${a.queued}` : 'ว่าง';
      const displaySub = sub.length > 22 ? `${sub.slice(0, 21)}…` : sub;
      const nw = Math.max(label.length * 9, displaySub.length * 7) + 22;
      over.push(`<g class="office-plate" data-office-label="${esc(a.id)}"><rect x="${(nx - nw / 2).toFixed(1)}" y="${(ny + 8).toFixed(1)}" width="${nw}" height="40" rx="9" fill="#fff" stroke="${ring}"/>`
        + `<text x="${nx.toFixed(1)}" y="${(ny + 26).toFixed(1)}" text-anchor="middle" font-size="15" font-weight="700" fill="#1f2a37">${esc(label)}</text>`
        + `<text x="${nx.toFixed(1)}" y="${(ny + 42).toFixed(1)}" text-anchor="middle" font-size="12" fill="${working ? '#1c7ed6' : status === 'review' ? '#2b8a3e' : '#6b7785'}">${esc(displaySub)}</text></g>`);
      out.push(`<g class="office-seat" data-agent="${esc(a.id)}">${g.join('')}</g>`);

      // overlays: speech cloud, review badge, settings gear
      const headY = ty - R - 78;
      if (a.say && (working || status === 'review')) over.push(`<g data-office-thought="${esc(a.id)}">${cloud(ax, headY, a.say, working)}</g>`);
      if (a.review) over.push(`<g class="office-badge office-hit" data-review="${esc(a.id)}" role="button" tabindex="0" aria-label="${esc(label)} มีงานรอตัดสิน ${a.review} งาน"><circle cx="${(ax - 40).toFixed(1)}" cy="${(ty - R + 8).toFixed(1)}" r="15" fill="#2b8a3e" stroke="#fff" stroke-width="3"/><text x="${(ax - 40).toFixed(1)}" y="${(ty - R + 13).toFixed(1)}" text-anchor="middle" font-size="15" font-weight="800" fill="#fff">${a.review}</text></g>`);
      over.push(`<g class="office-gear office-hit" data-gear="${esc(a.id)}" role="button" tabindex="0" aria-label="ตั้งค่า${esc(label)}"><circle cx="${(ax + 42).toFixed(1)}" cy="${(ty - R + 8).toFixed(1)}" r="13" fill="#fff" stroke="#cfd8e3"/><text x="${(ax + 42).toFixed(1)}" y="${(ty - R + 14).toFixed(1)}" text-anchor="middle" font-size="15">⚙️</text></g>`);
    }

    // after hours the room is dim
    if (!meta.working) {
      out.push(poly([P(0, 0, WALL), P(ROOM, 0, WALL), P(ROOM, 0), P(ROOM, ROOM), P(0, ROOM), P(0, ROOM, WALL)], 'fill="#0b1d3a" opacity=".28" pointer-events="none"'));
    }
    return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="ห้องทำงานทีม AI" font-family="'Sukhumvit Set','Thonburi','Noto Sans Thai',sans-serif">${out.join('')}${over.join('')}</svg>`;
  }

  const api = { buildOfficeSVG, officeWalkRoute, officeClockText };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.buildOfficeSVG = buildOfficeSVG;
  root.officeWalkRoute = officeWalkRoute;
  root.officeClockText = officeClockText;
})(typeof window !== 'undefined' ? window : globalThis);
