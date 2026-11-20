// App shell: turns the plain header nav into a responsive app navigation.
// Large screen = navy sidebar, Fold unfolded = icon rail, Fold folded = bottom tab bar + "More" sheet.
// Runs synchronously right after </header> so the nav never flashes in its old form.
(function () {
  const nav = document.querySelector('header .top-nav');
  if (!nav || nav.dataset.shell) return;
  nav.dataset.shell = '1';
  document.documentElement.classList.add('has-shell');

  const svg = (d) => `<svg class="nav-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICONS = {
    '/index.html': '<rect x="2.5" y="6" width="13" height="12" rx="2.5"/><path d="m15.5 10.5 5.2-3a.6.6 0 0 1 .8.5v8a.6.6 0 0 1-.8.5l-5.2-3"/>',
    '/graphic-design.html': '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.6-3.6a1.8 1.8 0 0 0-2.6 0L6 20.5"/>',
    '/report.html': '<rect x="3" y="4.5" width="18" height="17" rx="3"/><path d="M16 2.5v4M8 2.5v4M3 10h18"/>',
    '/ads.html': '<path d="M3.5 10.5v3a1 1 0 0 0 1 1H7l7 4.5V5L7 9.5H4.5a1 1 0 0 0-1 1z"/><path d="M18 9a4 4 0 0 1 0 6"/>',
    '/insights.html': '<path d="M3.5 3.5v17h17"/><path d="M8 16v-4M12.5 16V8M17 16v-6"/>',
    '/website.html': '<circle cx="12" cy="12" r="9.5"/><path d="M2.5 12h19M12 2.5c2.6 2.7 3.8 6 3.8 9.5s-1.2 6.8-3.8 9.5c-2.6-2.7-3.8-6-3.8-9.5S9.4 5.2 12 2.5z"/>',
    '/competitors.html': '<circle cx="11" cy="11" r="7.5"/><path d="m20.5 20.5-4.2-4.2"/>',
    '/agents.html': '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V4.5M9.5 4.5h5"/><circle cx="9.3" cy="13.5" r="1.1"/><circle cx="14.7" cy="13.5" r="1.1"/><path d="M1.5 13v3M22.5 13v3"/>',
    more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
  };
  const SHORT = { '/graphic-design.html': 'Graphic', '/competitors.html': 'คู่แข่ง' };
  const PRIMARY = 4; // first N links stay in the bottom bar; the rest go to "More"

  const links = [...nav.querySelectorAll('a.nav-link')];
  links.forEach((a, i) => {
    const href = a.getAttribute('href');
    const label = a.textContent.replace(/^[^\p{L}\p{N}]+/u, '').trim(); // drop leading emoji
    a.title = label;
    a.innerHTML = svg(ICONS[href] || ICONS.more)
      + `<span class="nav-label">${label}</span>`
      + `<span class="nav-short">${SHORT[href] || label}</span>`;
    if (i >= PRIMARY) a.classList.add('nav-secondary');
    if (a.classList.contains('active')) a.setAttribute('aria-current', 'page');
  });

  // Brand at the top of the sidebar / rail.
  const brand = document.createElement('a');
  brand.href = '/index.html';
  brand.className = 'nav-brand';
  brand.setAttribute('aria-label', 'Tasaki Marketing');
  brand.innerHTML = '<img class="logo-dark" src="/assets/tasaki-logo-white.svg" alt="Tasaki" /><img class="logo-light" src="/assets/tasaki-logo-blue.png" alt="Tasaki" /><span>Marketing</span>';
  nav.prepend(brand);
  // Move the nav out of the sticky header (its backdrop-filter would trap position:fixed).
  const header = nav.parentElement;
  header.after(nav);

  // "More" button + sheet (only visible on the folded screen).
  const secondary = links.slice(PRIMARY);
  if (secondary.length) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'nav-link nav-more';
    more.setAttribute('aria-expanded', 'false');
    more.innerHTML = svg(ICONS.more) + '<span class="nav-label">เพิ่มเติม</span><span class="nav-short">เพิ่มเติม</span>';
    if (secondary.some((a) => a.classList.contains('active'))) more.classList.add('active');
    nav.appendChild(more);

    const sheet = document.createElement('div');
    sheet.className = 'nav-sheet';
    sheet.hidden = true;
    sheet.innerHTML = '<div class="nav-sheet-panel" role="menu"><div class="nav-sheet-grip"></div></div>';
    const panel = sheet.firstChild;
    secondary.forEach((a) => {
      const c = a.cloneNode(true);
      c.classList.remove('nav-secondary');
      c.setAttribute('role', 'menuitem');
      panel.appendChild(c);
    });
    document.body.appendChild(sheet);
    const toggle = (open) => {
      sheet.hidden = !open;
      more.setAttribute('aria-expanded', String(open));
    };
    more.addEventListener('click', () => toggle(sheet.hidden));
    sheet.addEventListener('click', (e) => { if (e.target === sheet) toggle(false); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggle(false); });
    window.matchMedia('(min-width: 600px)').addEventListener('change', () => toggle(false));
  }

  // Header actions get their own group so they can wrap as one block on small screens.
  const actions = document.createElement('div');
  actions.className = 'header-actions';
  [...header.children].forEach((el) => { if (el.tagName !== 'H1') actions.appendChild(el); });
  header.appendChild(actions);

  // Browser chrome colour follows the theme.
  const meta = document.querySelector('meta[name="theme-color"]') || document.head.appendChild(Object.assign(document.createElement('meta'), { name: 'theme-color' }));
  const syncThemeColor = () => {
    meta.content = document.documentElement.getAttribute('data-theme') === 'dark' ? '#0d1822' : '#f6f8fa';
  };
  syncThemeColor();
  new MutationObserver(syncThemeColor).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
})();
