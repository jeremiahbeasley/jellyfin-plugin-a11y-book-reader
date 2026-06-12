// Accessibility regression: axe-core (WCAG 2.0/2.1/2.2 A+AA) over the plugin
// chrome in each major state. The book iframe is excluded (publisher content).
const H = require('../lib/harness');
const { runMain } = require('../lib/report');

async function run() {
  const R = [], log = (n, p, d) => R.push({ name: n, pass: p, detail: d || '' });
  const { browser, page } = await H.login({ width: 1280, height: 900 });
  try {
    await H.openBookViaUI(page, H.cfg.books.primary);
    await page.addScriptTag({ content: H.AXE });
    await H.gotoTextChapter(page, 200);
    const click = async id => { await page.evaluate(i => { const e = document.getElementById(i); if (e) e.click(); }, id); await new Promise(r => setTimeout(r, 500)); };

    const check = async label => {
      const v = await H.axeChrome(page);
      const serious = v.filter(x => x.impact === 'serious' || x.impact === 'critical');
      log('axe: ' + label, v.length === 0, v.length ? JSON.stringify(v) : '0 violations' + (serious.length ? ' (' + serious.length + ' serious)' : ''));
    };
    // strict: assert the expected UI state before each scan — a guarded click on
    // a missing element must FAIL the check, never silently re-scan the reading
    // view and pass vacuously
    const checkPanel = async (label, panel, tab) => {
      const state = await page.evaluate((p, t) => {
        const el = document.getElementById(p);
        if (!el || el.hasAttribute('hidden')) return p + ' not open';
        if (t) {
          const b = document.getElementById('abr-tab-' + t);
          if (!b || b.getAttribute('aria-selected') !== 'true') return 'tab ' + t + ' not selected';
        }
        return '';
      }, panel, tab);
      if (state) { log('axe: ' + label, false, 'UI state not reached: ' + state); return; }
      await check(label);
    };

    await check('reading view');
    await click('abr-settings-btn'); await checkPanel('settings open: Text tab', 'abr-settings', 'text');
    await click('abr-tab-page'); await checkPanel('settings open: Page tab', 'abr-settings', 'page');
    await click('abr-tab-audio'); await checkPanel('settings open: Audio tab', 'abr-settings', 'audio');
    await click('abr-tab-color'); await checkPanel('settings open: Color tab', 'abr-settings', 'color');
    await page.evaluate(() => { const x = document.querySelector('#abr-settings .abr-panel-close'); if (x) x.click(); });
    await new Promise(r => setTimeout(r, 400));
    await click('abr-bookmap-btn'); await checkPanel('book map open', 'abr-bookmap'); await click('abr-bookmap-btn');

    // D-pad tab descent: on a TV remote, arrows are the ONLY way to move
    // focus. Down on a tab must land INSIDE the open panel (it used to cycle
    // tabs, locking remote users out of the tab content); Right still cycles.
    const dpad = async (panelBtn, tabId, panelSel, label) => {
      await click(panelBtn);
      await page.evaluate(t => document.getElementById(t).focus(), tabId);
      await page.keyboard.press('ArrowDown');
      await new Promise(r => setTimeout(r, 300));
      const r1 = await page.evaluate(sel => {
        const panel = document.querySelector(sel);
        const a = document.activeElement;
        return { inPanel: !!(panel && a && panel.contains(a)), focused: a && (a.id || a.className || a.tagName) };
      }, panelSel);
      log(label + ': ArrowDown on tab descends into panel', r1.inPanel === true, JSON.stringify(r1));
      await page.evaluate(t => document.getElementById(t).focus(), tabId);
      await page.keyboard.press('ArrowRight');
      await new Promise(r => setTimeout(r, 300));
      const r2 = await page.evaluate(t => {
        const a = document.activeElement;
        return { cycled: !!(a && a.classList.contains('abr-tab') && a.id !== t), focused: a && a.id };
      }, tabId);
      log(label + ': ArrowRight still cycles tabs', r2.cycled === true, JSON.stringify(r2));
      await click(panelBtn);
    };
    await dpad('abr-settings-btn', 'abr-tab-text', '#abr-settings .abr-tabpanel:not([hidden])', 'settings d-pad');
    await dpad('abr-bookmap-btn', 'abr-tab-toc', '#abr-map-body', 'book map d-pad');

    // The remote must reach the CONTENT, not just the chrome: the arrow
    // rover cycles into the reading frame, and Back/Escape exits back to
    // the controls WITHOUT closing the reader.
    await page.evaluate(() => document.getElementById('abr-settings-btn').focus());
    let walk = [];
    for (let i = 0; i < 15; i++) {
      await page.keyboard.press('ArrowRight');
      await new Promise(r => setTimeout(r, 150));
      const id = await page.evaluate(() => document.activeElement && (document.activeElement.id || document.activeElement.tagName));
      walk.push(id);
      if (id === 'abr-frame') break;
    }
    log('d-pad: rover reaches the reading frame', walk.includes('abr-frame'), walk.join(' > '));
    await page.keyboard.press('Escape');
    await new Promise(r => setTimeout(r, 400));
    const esc = await page.evaluate(() => ({
      readerOpen: !!document.getElementById('abr-overlay'),
      focused: document.activeElement && document.activeElement.id,
    }));
    log('d-pad: Escape exits frame to controls, reader stays open',
        esc.readerOpen === true && !!esc.focused && esc.focused !== 'abr-frame', JSON.stringify(esc));
  } finally { await browser.close(); }
  return R;
}

module.exports = { run };
if (require.main === module) runMain(run, 'Accessibility');
