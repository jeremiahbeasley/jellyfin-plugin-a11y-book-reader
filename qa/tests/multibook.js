// Multi-book regression: open several EPUBs of differing structure (real TOC,
// synthesized TOC, footnotes) + one non-EPUB. Each book gets a fresh page that
// shares the authenticated session.
const H = require('../lib/harness');
const { runMain } = require('../lib/report');

async function run() {
  const R = [], log = (n, p, d) => R.push({ name: n, pass: p, detail: d || '' });
  const { browser } = await H.login({ width: 1280, height: 900 });
  try {
    for (const id of H.cfg.books.epubs) {
      const page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 900 });
      const errs = []; page.on('pageerror', e => errs.push(String(e.message || e).slice(0, 100)));
      const r = await H.openBookViaUI(page, id);
      if (!r.overlay) { log('EPUB ' + id.slice(0, 8), false, 'did not open'); await page.close(); continue; }
      await page.addScriptTag({ content: H.AXE }).catch(() => {});
      const info = await page.evaluate(async () => {
        const R = window.a11yBookReader;
        for (let i = 0; i < R._spine.length; i++) { await new Promise(r => { R._loadChapter(i); setTimeout(r, 600); }); const f = document.getElementById('abr-frame'); try { if (f.contentDocument.body.textContent.trim().length > 300) break; } catch (e) {} }
        await new Promise(r => { document.getElementById('abr-bookmap-btn').click(); setTimeout(r, 500); });
        const toc = document.querySelectorAll('#abr-bookmap [role="list"] button, #abr-bookmap .abr-toc-item, #abr-bookmap li button, #abr-bookmap button').length;
        document.getElementById('abr-tab-search').click();
        const inp = document.querySelector('#abr-bookmap input'); let results = 0;
        if (inp) { inp.value = 'the'; inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await new Promise(r => setTimeout(r, 1300)); results = document.querySelectorAll('#abr-search-results button, #abr-search-results li').length; }
        document.getElementById('abr-bookmap-btn').click();
        return { spine: R._spine.length, toc, results };
      });
      const ax = await H.axeChrome(page);
      const ok = info.spine > 0 && info.toc > 2 && ax.length === 0 && errs.length === 0;
      log('EPUB ' + id.slice(0, 8), ok, 'spine=' + info.spine + ' toc=' + info.toc + ' search=' + info.results + ' axe=' + (ax.length ? JSON.stringify(ax) : 0) + ' errs=' + errs.length);
      await page.close();
    }
    // non-EPUB should NOT open a reader
    if (H.cfg.books.nonEpub) {
      const page = await browser.newPage();
      const r = await H.openBookViaUI(page, H.cfg.books.nonEpub);
      await new Promise(r => setTimeout(r, 1500));
      const noFrame = await page.evaluate(() => { try { return document.getElementById('abr-frame').contentDocument.body.textContent.trim().length === 0; } catch (e) { return true; } });
      log('non-EPUB fails gracefully (no reader)', !r.overlay || noFrame, 'overlay=' + r.overlay);
      await page.close();
    }
  } finally { await browser.close(); }
  return R;
}

module.exports = { run };
if (require.main === module) runMain(run, 'Multi-book');
