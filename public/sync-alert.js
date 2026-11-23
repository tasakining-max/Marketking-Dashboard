// Red bar at the top of every page when the Microsoft Calendar sync is off
// (email settings missing from this copy's .env) or its last email failed.
// Rechecks every 2 minutes so a fix or a new failure shows without a reload.
(function () {
  let bar = null;
  function show(text) {
    if (!bar) {
      bar = document.createElement('div');
      bar.setAttribute('role', 'alert');
      bar.style.cssText = 'position:sticky;top:0;z-index:9999;background:#c62828;color:#fff;'
        + 'font:600 14px/1.4 system-ui,sans-serif;padding:10px 16px;text-align:center';
      document.body.prepend(bar);
    }
    bar.textContent = text;
  }
  function hide() { if (bar) { bar.remove(); bar = null; } }
  async function check() {
    try {
      const r = await fetch('/api/health/sync', { cache: 'no-store' });
      if (!r.ok) return;
      const c = (await r.json()).calendar || {};
      if (!c.configured) {
        show('⚠ ปฏิทิน Microsoft ไม่ซิงก์: เครื่อง ' + location.host + ' ยังไม่ได้ตั้งค่าอีเมล (SMTP_USER / SMTP_PASS / PLANNER_EMAIL_TO ใน .env)');
      } else if (c.failing) {
        const at = c.lastErrorAt ? new Date(c.lastErrorAt).toLocaleString('th-TH') : '';
        show('⚠ ส่งการแก้ไขไปปฏิทิน Microsoft ไม่สำเร็จ (' + at + '): ' + (c.lastError || 'ไม่ทราบสาเหตุ'));
      } else {
        hide();
      }
    } catch (e) { /* offline: keep whatever is shown */ }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', check); else check();
  setInterval(check, 120000);
})();
