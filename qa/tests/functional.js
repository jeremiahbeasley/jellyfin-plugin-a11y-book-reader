// Functional regression: open, view modes, panels, navigation, search, immersive.
const H = require('../lib/harness');
const { runMain } = require('../lib/report');

async function run() {
  const R = [], log = (n, p, d) => R.push({ name: n, pass: p, detail: d || '' });
  const { browser, page, errs } = await H.login({ width: 1280, height: 900 });
  try {
    await H.openBookViaUI(page, H.cfg.books.primary);
    const ch = await H.gotoTextChapter(page, 200);
    log('opens via real UI to a text chapter', ch.chapter >= 0, 'chapter ' + ch.chapter);

    const click = async id => { await page.evaluate(i => { const e = document.getElementById(i); if (e) e.click(); }, id); await new Promise(r => setTimeout(r, 500)); };
    const st = (fn, ...a) => page.evaluate(fn, ...a);

    // view-mode switch via the real Settings > Page radios keeps content
    const radio = async v => { await page.evaluate(val => { const b = document.querySelector('#abr-viewmode-choice [role="radio"][data-value="' + val + '"]'); if (b) b.click(); }, v); await new Promise(r => setTimeout(r, 800)); };
    const closePanel = async p => { await page.evaluate(id => { const x = document.querySelector('#' + id + ' .abr-panel-close'); if (x) x.click(); }, p); await new Promise(r => setTimeout(r, 500)); };
    await click('abr-settings-btn'); await click('abr-tab-page');
    await radio('page');
    const paged = await st(() => ({ m: window.a11yBookReader._viewMode, t: (() => { try { return document.getElementById('abr-frame').contentDocument.body.textContent.trim().length > 50; } catch (e) { return false; } })() }));
    log('switch to page view keeps content', paged.m === 'page' && paged.t, JSON.stringify(paged));
    await radio('scroll');
    log('switch back to scroll', (await st(() => window.a11yBookReader._viewMode)) === 'scroll');
    await closePanel('abr-settings');

    // panels open/close (settings button is open-only; both close via header X)
    for (const [btn, panel, nm] of [['abr-settings-btn', 'abr-settings', 'Settings'], ['abr-bookmap-btn', 'abr-bookmap', 'Book map']]) {
      await click(btn);
      const open = await st(p => { const e = document.getElementById(p); return e && !e.hasAttribute('hidden'); }, panel);
      const exp = await st(b => { const e = document.getElementById(b); return e && e.getAttribute('aria-expanded'); }, btn);
      log('open panel: ' + nm, open && exp === 'true', 'visible=' + open + ' expanded=' + exp);
      await closePanel(panel);
      log('close panel: ' + nm, await st(p => document.getElementById(p).hasAttribute('hidden'), panel));
    }
    // one popup at a time
    await click('abr-settings-btn'); await click('abr-bookmap-btn');
    const one = await st(() => ({ c: document.getElementById('abr-settings').hasAttribute('hidden'), m: !document.getElementById('abr-bookmap').hasAttribute('hidden') }));
    log('one popup at a time', one.c && one.m, JSON.stringify(one));
    log('book map has TOC entries', (await st(() => document.querySelectorAll('#abr-bookmap [role="list"] button, #abr-bookmap .abr-toc-item, #abr-bookmap li button, #abr-bookmap button').length)) > 2);
    await click('abr-bookmap-btn');

    // chapter nav
    const c0 = await st(() => window.a11yBookReader._chapterIndex);
    await click('abr-next'); await new Promise(r => setTimeout(r, 800));
    const c1 = await st(() => window.a11yBookReader._chapterIndex);
    await click('abr-prev'); await new Promise(r => setTimeout(r, 800));
    const c2 = await st(() => window.a11yBookReader._chapterIndex);
    log('chapter next/prev', c1 === c0 + 1 && c2 === c0, `c ${c0}->${c1}->${c2}`);

    // search
    await click('abr-bookmap-btn'); await click('abr-tab-search');
    const found = await st(async () => {
      const inp = document.querySelector('#abr-bookmap input');
      if (!inp) return 0;
      inp.value = 'the'; inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise(r => setTimeout(r, 1300));
      return document.querySelectorAll('#abr-search-results button, #abr-search-results li').length;
    });
    log('search returns results', found > 0, found + ' results');
    await click('abr-bookmap-btn');

    // go-to + back — start from chapter 0 so the 50% target can never equal
    // the starting chapter (a resumed mid-book position once made g1 === g0)
    await st(async () => { window.a11yBookReader._loadChapter(0); await new Promise(r => setTimeout(r, 800)); });
    const g0 = await st(() => window.a11yBookReader._chapterIndex);
    await click('abr-bookmap-btn'); await click('abr-tab-goto');
    await st(() => { const inp = document.querySelector('#abr-bookmap input'); if (inp) { inp.value = '50%'; inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); } });
    await new Promise(r => setTimeout(r, 1200));
    const g1 = await st(() => window.a11yBookReader._chapterIndex);
    await click('abr-back-btn'); await new Promise(r => setTimeout(r, 800));
    const g2 = await st(() => window.a11yBookReader._chapterIndex);
    log('go-to % navigates and back returns', g1 !== g0 && g2 === g0, `c ${g0}->${g1}->${g2}`);

    // immersive
    await click('abr-immersive-toggle');
    const imm = await st(() => ({ f: !!window.a11yBookReader._immersive, s: (() => { const e = document.getElementById('abr-show-controls'); return e && e.offsetParent !== null; })() }));
    await st(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await new Promise(r => setTimeout(r, 400));
    log('immersive hides chrome & Escape exits', imm.f && imm.s && (await st(() => !window.a11yBookReader._immersive)), JSON.stringify(imm));

    // resume / persistence
    await st(async () => { window.a11yBookReader._loadChapter(3); await new Promise(r => setTimeout(r, 800)); });
    const saved = await st(() => window.a11yBookReader._chapterIndex);
    await click('abr-close'); await new Promise(r => setTimeout(r, 1500));
    await H.openBookViaUI(page, H.cfg.books.primary); await new Promise(r => setTimeout(r, 1500));
    log('resume reopens at saved chapter', (await st(() => window.a11yBookReader && window.a11yBookReader._chapterIndex)) === saved, 'saved ' + saved);

    // leave the book parked on a TEXT chapter — the saved position is the next
    // session's starting state (one server-side user across all suites), and
    // chapter 3 is the image-only title page (zero TTS text)
    await st(async c => { window.a11yBookReader._loadChapter(c); await new Promise(r => setTimeout(r, 1000)); }, ch.chapter);
    await click('abr-close'); await new Promise(r => setTimeout(r, 1000));

    log('no reader JS errors', errs.length === 0, JSON.stringify(errs.slice(0, 3)));
  } finally { await browser.close(); }
  return R;
}

module.exports = { run };
if (require.main === module) runMain(run, 'Functional');
