// Ads page: the two tabs and the campaign prep checklist.
(function () {
  const tabs = [...document.querySelectorAll('.ads-tab')];
  function showTab(name) {
    for (const t of tabs) {
      const on = t.dataset.tab === name;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    document.getElementById('adsPanelCampaign').hidden = name !== 'campaign';
    document.getElementById('adsPanelResults').hidden = name !== 'results';
    try { localStorage.setItem('adsTab', name); } catch {}
    if (name === 'campaign') loadCampaign();
  }
  for (const t of tabs) t.addEventListener('click', () => showTab(t.dataset.tab));

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
    return el;
  }

  const select = document.getElementById('campaignSelect');
  const body = document.getElementById('campaignBody');
  const COLUMN_LABEL = { idea: 'ไอเดีย', clip: 'กำลังตัดต่อ', youtube: 'YouTube', published: 'โพสต์แล้ว', todo: 'รอทำ', in_progress: 'กำลังทำ', done: 'พร้อมใช้' };
  let current = null;

  async function call(url, opts) {
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  const mark = (ok, unknown) => h('span', { class: `campaign-mark ${ok ? 'ok' : unknown ? 'unknown' : 'no'}`, 'aria-hidden': 'true' }, ok ? '✓' : unknown ? '?' : '✗');
  const badge = (ready, text) => h('span', { class: `campaign-badge ${ready ? 'ok' : ''}` }, text);

  // Click a picture to see it big.
  function zoom(node) {
    const box = h('div', { class: 'campaign-lightbox', role: 'dialog', 'aria-label': 'ดูภาพขนาดใหญ่', onclick: () => box.remove() }, node);
    document.body.append(box);
  }

  function section(title, count, ok, ...kids) {
    return h('section', { class: 'campaign-section' },
      h('div', { class: 'campaign-section-head' }, h('h3', {}, title), h('span', { class: `campaign-count ${ok ? 'ok' : ''}` }, count)),
      ...kids);
  }

  // Crop guides on a 1080x1920 ad: 4:5 keeps y 285-1635, 1:1 keeps y 420-1500.
  const CROP = { r45: [285 / 1920, 1635 / 1920], r11: [420 / 1920, 1500 / 1920] };
  const pct = (v) => `${(v * 100).toFixed(3)}%`;
  function guides() {
    const line = (y, label, cls) => h('div', { class: `campaign-cropline ${cls}`, style: `top:${pct(y)}` }, h('span', {}, label));
    return h('div', { class: 'campaign-guides', 'aria-hidden': 'true' },
      line(CROP.r45[0], '4:5', 'r45'), line(CROP.r45[1], '4:5', 'r45'),
      line(CROP.r11[0], '1:1', 'r11'), line(CROP.r11[1], '1:1', 'r11'));
  }

  // The three sizes side by side, each as it will really be posted.
  function showSizes(item) {
    const one = (src, label, note) => src ? h('figure', { class: 'campaign-size' }, h('img', { src, alt: `${item.title} ${label}` }), h('figcaption', {}, h('b', {}, label), h('span', {}, note))) : null;
    const panel = h('div', { class: 'campaign-sizes', onclick: (ev) => ev.stopPropagation() },
      h('h4', {}, item.title),
      h('div', { class: 'campaign-sizes-row' },
        one(item.sizes.r916, '9:16', 'Stories / Reels · 1080×1920'),
        one(item.sizes.r45, '4:5', 'ฟีด Facebook / Instagram · 1080×1350'),
        one(item.sizes.r11, '1:1', 'สี่เหลี่ยมจัตุรัส · 1080×1080')));
    const box = h('div', { class: 'campaign-lightbox campaign-lightbox-wide', role: 'dialog', 'aria-label': 'ภาพแอดทั้ง 3 ขนาด', onclick: () => box.remove() }, panel);
    document.body.append(box);
  }

  // The ad as a tall 9:16 picture with lines showing what survives each crop.
  function feedAd(item, n) {
    const src = item && ((item.sizes && item.sizes.r916) || item.imageUrl);
    const tall = item && item.sizes && item.sizes.r916;
    const open = () => (item.sizes ? showSizes(item) : zoom(h('img', { src: item.imageUrl, alt: item.title })));
    const media = src
      ? h('div', { class: 'campaign-ad-media', role: 'button', tabindex: '0', title: item.sizes ? 'คลิกเพื่อดูทั้ง 3 ขนาด' : 'คลิกเพื่อดูภาพใหญ่', onclick: open, onkeydown: (ev) => { if (ev.key === 'Enter') open(); } },
        h('img', { src, alt: item.title, class: 'campaign-ad-img' }), tall ? guides() : null)
      : h('div', { class: 'campaign-empty campaign-ad-media' }, item ? [h('b', {}, '🎨 ยังไม่มีภาพ'), h('span', {}, item.brief || item.title)] : [h('b', {}, `ภาพแอดที่ ${n}`), h('span', {}, 'ยังไม่ได้ทำ')]);
    return h('figure', { class: `campaign-feed${item && item.ready ? ' ready' : ''}` },
      media,
      tall ? h('div', { class: 'campaign-legend' }, h('span', { class: 'r45' }, '┄ 4:5 เห็นเฉพาะในเส้นนี้'), h('span', { class: 'r11' }, '┄ 1:1 เห็นเฉพาะในเส้นนี้')) : null,
      h('figcaption', {}, item ? [badge(item.ready, COLUMN_LABEL[item.column] || item.column), item.title, item.sizes ? h('small', {}, 'คลิกดูทั้ง 3 ขนาด') : null] : ''));
  }

  function videoTile(item, n) {
    let media;
    if (item && item.videoUrl) media = h('video', { src: item.videoUrl, controls: true, preload: 'metadata', poster: item.imageUrl || null, class: 'campaign-reel-media' });
    else if (item && item.imageUrl) media = h('div', { class: 'campaign-reel-media campaign-reel-poster', onclick: () => zoom(h('img', { src: item.imageUrl, alt: item.title })) }, h('img', { src: item.imageUrl, alt: item.title }), h('span', { class: 'campaign-play' }, '▶'));
    else media = h('div', { class: 'campaign-empty campaign-reel-media' }, h('b', {}, item ? '🎬 ยังไม่มีไฟล์' : `วิดีโอที่ ${n}`), h('span', {}, item ? item.title : 'ยังไม่ได้ทำ'));
    return h('figure', { class: `campaign-reel${item && item.ready ? ' ready' : ''}` }, media,
      h('figcaption', {}, item ? [badge(item.ready, COLUMN_LABEL[item.column] || item.column), item.title,
        item.postUrl ? h('a', { href: item.postUrl, target: '_blank', rel: 'noopener' }, `ดูโพสต์จริง ↗${item.views != null ? ` · ${item.views.toLocaleString('th-TH')} วิว` : ''}`) : null,
        h('button', { type: 'button', class: 'campaign-link-btn', onclick: async () => {
          if (!confirm('ไม่ใช้วิดีโอนี้กับแคมเปญนี้ใช่ไหม')) return;
          try { await call(`/api/campaigns/${encodeURIComponent(current)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ excludeCard: item.id }) }); loadCampaign(); }
          catch (e) { alert(e.message); }
        } }, 'ไม่เหมาะกับแคมเปญนี้')] : ''));
  }

  function coverTile(c, kind, other) {
    const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', hidden: true });
    file.addEventListener('change', () => {
      const f = file.files[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = async () => {
        try { await call(`/api/campaigns/${encodeURIComponent(current)}/manual/${c.key}/image`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataUrl: r.result }) }); loadCampaign(); }
        catch (e) { alert(e.message); }
      };
      r.readAsDataURL(f);
    });
    const inner = c.image
      ? h('img', { src: c.image, alt: c.title, class: 'campaign-cover-img' })
      : h('div', { class: 'campaign-empty campaign-cover-img' }, h('b', {}, '＋ วางภาพที่นี่'), h('span', {}, 'คลิกเพื่อเลือกไฟล์ จะเห็นว่าขึ้นหน้าจริงแล้วเป็นอย่างไร'),
        other && other.image ? h('button', { type: 'button', class: 'campaign-link-btn', onclick: async (ev) => {
          ev.stopPropagation();
          try { await call(`/api/campaigns/${encodeURIComponent(current)}/manual/${c.key}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: other.image }) }); loadCampaign(); }
          catch (e) { alert(e.message); }
        } }, 'ใช้ภาพเดียวกับอีกอัน') : null);
    const frame = kind === 'fb'
      ? h('div', { class: 'campaign-fbpage' }, h('div', { class: 'campaign-fbcover' }, inner), h('div', { class: 'campaign-fbbar' }, h('span', { class: 'campaign-fbavatar' }, 'T'), h('b', {}, 'Tasaki Air'), h('small', {}, 'เพจ · เครื่องปรับอากาศ')))
      : h('div', { class: 'campaign-webpage' }, h('div', { class: 'campaign-webnav' }, h('b', {}, 'Tasaki'), h('span', {}, 'สินค้า'), h('span', {}, 'ตัวแทน'), h('span', {}, 'ติดต่อ')), h('div', { class: 'campaign-webhero' }, inner));
    frame.addEventListener('click', () => (c.image ? zoom(h('img', { src: c.image, alt: c.title })) : file.click()));
    const box = h('input', { type: 'checkbox', checked: c.done, 'aria-label': `${c.title} เสร็จแล้ว` });
    const note = h('input', { type: 'text', class: 'campaign-note', placeholder: 'โน้ต (ไม่บังคับ)', value: c.note, 'aria-label': `โน้ต ${c.title}` });
    const save = async () => { try { await call(`/api/campaigns/${encodeURIComponent(current)}/manual/${c.key}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ done: box.checked, note: note.value }) }); } catch (e) { alert(e.message); } };
    box.addEventListener('change', async () => { await save(); loadCampaign(); });
    note.addEventListener('change', save);
    return h('figure', { class: `campaign-cover ${kind}${c.done ? ' ready' : ''}` }, frame, file,
      h('figcaption', {}, h('label', { class: 'campaign-cover-label' }, box, c.title), c.image ? h('button', { type: 'button', class: 'campaign-link-btn', onclick: () => file.click() }, 'เปลี่ยนภาพ') : null, note));
  }

  // One line to paste: label, the value, a copy button. Nothing here is typed in.
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise((resolve, reject) => {
      const ta = h('textarea', { style: 'position:fixed;opacity:0' }, text);
      document.body.append(ta); ta.select();
      try { document.execCommand('copy') ? resolve() : reject(new Error('copy failed')); } catch (e) { reject(e); } finally { ta.remove(); }
    });
  }
  function copyBtn(text, label = 'คัดลอก') {
    const b = h('button', { type: 'button', class: 'campaign-copy' }, label);
    b.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      try { await copyText(text); b.textContent = '✓ คัดลอกแล้ว'; b.classList.add('done'); setTimeout(() => { b.textContent = label; b.classList.remove('done'); }, 1500); }
      catch { b.textContent = 'คัดลอกไม่ได้'; }
    });
    return b;
  }
  const copyRow = (label, value, mono) => h('div', { class: 'campaign-copy-row' }, h('span', { class: 'campaign-copy-label' }, label), h('code', { class: mono ? 'mono' : '' }, value), copyBtn(value));

  function planBlock(data) {
    const plan = data.campaign.plan;
    if (!plan) return null;
    const c = plan.campaign;
    const allText = [
      `Campaign: ${c.name}`, `Objective: ${c.objective}`, `Budget: ${c.budget}`, '',
      ...plan.adSetSettings.map((x) => `${x.label}: ${x.value}`), '',
      ...plan.adSets.map((x) => `Ad set: ${x.name}${x.detailed ? ` · Detailed targeting: ${x.detailed}` : ''}`), '',
      ...plan.ads.map((a) => `[${a.adSet}] ${a.name}\n  URL: ${a.fullUrl}`),
    ].join('\n');
    const box = h('input', { type: 'checkbox', checked: data.audience.done, 'aria-label': 'ตั้งใน Ads Manager แล้ว' });
    box.addEventListener('change', async () => {
      try { await call(`/api/campaigns/${encodeURIComponent(current)}/manual/audience`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ done: box.checked }) }); } catch (e) { alert(e.message); }
      loadCampaign();
    });
    return h('div', { class: 'campaign-plan' },
      h('div', { class: 'campaign-plan-top' }, h('span', { class: 'campaign-muted' }, `กลุ่มเป้าหมาย: ${data.campaign.audience || '-'}`), copyBtn(allText, 'คัดลอกทั้งแผน')),
      h('h4', {}, '1 · Campaign'),
      copyRow('ชื่อแคมเปญ', c.name, true), copyRow('Objective', c.objective), copyRow('งบ', c.budget),
      h('h4', {}, '2 · Ad set (ตั้งค่าทั่วไปเหมือนกันทุกชุด)'),
      plan.adSetSettings.map((x) => copyRow(x.label, x.value)),
      h('h4', {}, '2.1 · ชื่อชุดโฆษณา + Detailed targeting (ใส่ในช่อง include เดียวกัน ไม่ใช่ narrow)'),
      plan.adSets.map((x) => h('div', { class: 'campaign-plan-ad' }, copyRow('ชื่อชุดโฆษณา', x.name, true), x.detailed ? copyRow('Detailed targeting', x.detailed) : null)),
      h('h4', {}, '3 · โฆษณา + ลิงก์ติด UTM'),
      plan.ads.map((a) => h('div', { class: 'campaign-plan-ad' },
        h('div', { class: 'campaign-plan-ad-head' }, h('b', {}, a.adSet), h('span', { class: 'campaign-muted' }, `utm_content = ${a.utmContent}`)),
        copyRow('ชื่อโฆษณา', a.name, true),
        copyRow('Website URL', a.landing, true),
        copyRow('URL parameters', a.urlParams, true),
        copyRow('ลิงก์เต็ม (ทดสอบ)', a.fullUrl, true))),
      h('label', { class: 'campaign-cover-label campaign-plan-done' }, box, 'ตั้งใน Ads Manager แล้ว'));
  }

  // Readiness as a power bar: five equal cells, each filled by how far that part is.
  function powerBar(parts) {
    const total = Math.round((parts.reduce((n, x) => n + x.frac, 0) / parts.length) * 100);
    const tone = total >= 100 ? 'full' : total >= 60 ? 'high' : total >= 30 ? 'mid' : 'low';
    return h('div', { class: `campaign-power ${tone}`, role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(total), 'aria-label': 'ความพร้อมยิง' },
      h('div', { class: 'campaign-power-top' }, h('span', {}, total >= 100 ? '⚡ พร้อมยิงจริง' : 'ความพร้อมยิง'), h('b', {}, `${total}%`)),
      h('div', { class: 'campaign-power-cells' }, parts.map((x) => h('div', { class: `campaign-power-cell${x.frac >= 1 ? ' done' : ''}`, title: `${x.label} ${x.detail}` },
        h('div', { class: 'campaign-power-fill', style: `width:${Math.round(x.frac * 100)}%` }),
        h('span', {}, x.label)))));
  }

  function pill(label, ok, detail) {
    return h('div', { class: `campaign-pill ${ok ? 'ok' : ''}` }, mark(ok), h('b', {}, label), h('span', {}, detail));
  }

  function render(data) {
    const p = data.progress;
    const slots = (step) => Math.min(Math.max(step.min, step.items.length), step.max);
    // Only ads that have a picture get a tile; the rest are just counted in a line.
    const ads = data.adImages.items.filter((i) => i.imageUrl || (i.sizes && (i.sizes.r916 || i.sizes.r45 || i.sizes.r11)));
    const adsPending = data.adImages.items.length - ads.length + Math.max(0, data.adImages.min - data.adImages.items.length);
    const vids = Array.from({ length: slots(data.videos) }, (_, i) => data.videos.items[i] || null);
    const web = data.web;
    const webLeft = web.products.filter((x) => !x.ready).length;
    const frac = (a, b) => (b > 0 ? Math.min(a / b, 1) : 0);
    const covers = data.covers;
    const parts = [
      { label: 'ตั้งแคมเปญ', frac: data.audience.who && data.audience.done ? 1 : 0, detail: '' },
      { label: 'เว็บ/Catalog', frac: frac(web.readyCount, web.total), detail: `${web.readyCount}/${web.total} รุ่น` },
      { label: 'ภาพแอด', frac: frac(data.adImages.ready, data.adImages.min), detail: `${data.adImages.ready}/${data.adImages.min}` },
      { label: 'วิดีโอ', frac: frac(data.videos.ready, data.videos.min), detail: `${data.videos.ready}/${data.videos.min}` },
      { label: 'Cover', frac: frac(covers.filter((c) => c.done).length, covers.length), detail: `${covers.filter((c) => c.done).length}/${covers.length}` },
    ];
    body.replaceChildren(
      powerBar(parts),
      h('details', { class: 'campaign-section campaign-plan-fold' },
        h('summary', { class: 'campaign-section-head' }, h('h3', {}, '🚀 แผนตั้งแคมเปญ (กดคัดลอกไปวางใน Ads Manager)'), h('span', { class: `campaign-count ${data.audience.who && data.audience.done ? 'ok' : ''}` }, data.audience.who && data.audience.done ? 'ตั้งแล้ว' : 'ยังไม่ได้ตั้ง'), h('span', { class: 'campaign-muted' }, '(กดเพื่อขยาย)')),
        planBlock(data) || h('p', { class: 'key-messages-hint' }, 'แคมเปญนี้ยังไม่มีแผน')),
      section('🖼️ ภาพแอด (9:16 พร้อมเส้นครอป)', `พร้อม ${data.adImages.ready} · ต้องการ ${data.adImages.min}–${data.adImages.max}`, data.adImages.done,
        ads.length ? h('div', { class: 'campaign-feed-grid' }, ads.map((it, i) => feedAd(it, i + 1))) : null,
        adsPending ? h('p', { class: 'campaign-pending' }, `ยังไม่มีภาพอีก ${adsPending} ภาพ`) : null),
      section('🎬 วิดีโอ', `พร้อม ${data.videos.ready} · ต้องการ ${data.videos.min}–${data.videos.max}`, data.videos.done,
        h('div', { class: 'campaign-reel-grid' }, vids.map((it, i) => videoTile(it, i + 1)))),
      section('🌐 Cover และหน้าแรก', `${data.covers.filter((c) => c.done).length}/${data.covers.length} (ติ๊กเอง)`, data.covers.every((c) => c.done),
        h('div', { class: 'campaign-cover-grid' }, data.covers.map((c) => coverTile(c, c.key === 'fbCover' ? 'fb' : 'web', data.covers.find((o) => o !== c))))),
      h('details', { class: 'campaign-web' },
        h('summary', {}, mark(web.done), `ตรวจเว็บ + Catalog — ${web.total ? `ผ่านครบ ${web.readyCount}/${web.total} รุ่น` : 'ยังไม่พบสินค้า'}`, webLeft ? h('span', { class: 'campaign-muted' }, ' (กดดูรายละเอียด)') : null),
        web.products.map((x) => h('div', { class: 'campaign-product' },
          h('div', { class: 'campaign-product-head' }, mark(x.ready), h('b', {}, x.model)),
          h('div', { class: 'campaign-checks' }, x.checks.map((c) => h('span', { class: `campaign-check ${c.ok ? 'ok' : c.unknown ? 'unknown' : 'no'}` }, mark(c.ok, c.unknown), c.label)))))));
  }

  async function loadCampaign() {
    if (!current) return;
    try { render(await call(`/api/campaigns/${encodeURIComponent(current)}`)); }
    catch (e) { body.replaceChildren(h('p', { class: 'key-messages-hint' }, `โหลดไม่ได้: ${e.message}`)); }
  }

  async function loadList(pick) {
    const { campaigns } = await call('/api/campaigns');
    select.replaceChildren(...campaigns.map((c) => h('option', { value: c.id }, c.name)));
    current = pick || current || campaigns[0].id;
    select.value = current;
  }

  select.addEventListener('change', () => { current = select.value; loadCampaign(); });
  document.getElementById('campaignRefreshBtn').addEventListener('click', loadCampaign);
  document.getElementById('campaignAddBtn').addEventListener('click', async () => {
    const name = (prompt('ชื่อแคมเปญใหม่ (เช่น Inverter ฤดูร้อน)') || '').trim();
    if (!name) return;
    const keywords = (prompt('คำที่ใช้หาภาพแอด/วิดีโอ/สินค้าของแคมเปญนี้ (คั่นด้วยจุลภาค)', name) || name).trim();
    try { const r = await call('/api/campaigns', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, keywords }) }); await loadList(r.id); loadCampaign(); }
    catch (e) { alert(e.message); }
  });

  (async () => {
    let tab = 'campaign';
    try { tab = localStorage.getItem('adsTab') || 'campaign'; } catch {}
    try { await loadList(); } catch (e) { body.textContent = `โหลดไม่ได้: ${e.message}`; }
    showTab(tab === 'results' ? 'results' : 'campaign');
  })();
})();
