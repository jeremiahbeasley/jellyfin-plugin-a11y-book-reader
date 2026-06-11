// Responsive regression (WCAG 1.4.10 Reflow, 2.5.8 Target Size): the reader
// overlay at 320/360/768/1280. Checks the reader's own chrome only — Jellyfin's
// surrounding page is out of scope (the plugin must not restyle Jellyfin).
const H = require('../lib/harness');
const { runMain } = require('../lib/report');
const VPs = [{ w: 320, h: 568 }, { w: 360, h: 640 }, { w: 768, h: 1024 }, { w: 1280, h: 800 }];

async function run() {
  const R = [], log = (n, p, d) => R.push({ name: n, pass: p, detail: d || '' });
  const { browser } = await H.login({ width: 1280, height: 900 });
  try {
    for (const vp of VPs) {
      const page = await browser.newPage();
      await page.setViewport({ width: vp.w, height: vp.h });
      const errs = []; page.on('pageerror', e => errs.push(String(e.message || e).slice(0, 100)));
      const r = await H.openBookViaUI(page, H.cfg.books.primary);
      if (!r.overlay) { log(vp.w + 'px: reader opens', false, 'overlay did not open'); await page.close(); continue; }
      await page.addScriptTag({ content: H.AXE }).catch(() => {});
      await H.gotoTextChapter(page, 200);
      const res = await page.evaluate((W, Hh) => {
        const ov = document.getElementById('abr-overlay');
        const hOverflow = ov.scrollWidth > W + 1;   // the reader overlay itself
        const btns = [...ov.querySelectorAll('button')].filter(b => { const s = getComputedStyle(b); return s.display !== 'none' && s.visibility !== 'hidden' && b.offsetParent !== null; });
        const off = [], tiny = [];
        btns.forEach(b => { const r = b.getBoundingClientRect();
          if (r.right > W + 1 || r.left < -1 || r.bottom > Hh + 1 || r.top < -1) off.push((b.id || b.getAttribute('aria-label')));
          if ((r.width < 24 || r.height < 24) && r.width > 0) tiny.push((b.id || b.getAttribute('aria-label')) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height)); });
        const c = document.getElementById('abr-close'), cr = c && c.getBoundingClientRect();
        return { hOverflow, off, tiny, closeOk: !!(cr && cr.right <= W + 1 && cr.top >= -1) };
      }, vp.w, vp.h);
      await page.evaluate(() => { const b = document.getElementById('abr-settings-btn'); if (b) b.click(); });
      await new Promise(r => setTimeout(r, 400));
      // strict: the panel must actually be open here — a missing button must fail, not skip
      const panelFits = await page.evaluate(W => { const p = document.getElementById('abr-settings'); if (!p || p.hasAttribute('hidden')) return false; const r = p.getBoundingClientRect(); return r.right <= W + 1 && r.left >= -1; }, vp.w);
      const ax = await H.axeChrome(page);
      const ok = !res.hOverflow && res.off.length === 0 && res.tiny.length === 0 && res.closeOk && panelFits && ax.length === 0 && errs.length === 0;
      log(vp.w + 'x' + vp.h + ' reflow + target-size + a11y', ok,
        'overlayOverflow=' + res.hOverflow + ' offscreen=' + (res.off.length ? JSON.stringify(res.off) : 0) + ' tiny=' + (res.tiny.length ? JSON.stringify(res.tiny) : 0) + ' close=' + res.closeOk + ' panelFits=' + panelFits + ' axe=' + (ax.length ? JSON.stringify(ax) : 0) + ' errs=' + errs.length);
      await page.close();
    }
  } finally { await browser.close(); }
  return R;
}

module.exports = { run };
if (require.main === module) runMain(run, 'Responsive');
