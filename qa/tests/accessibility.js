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
  } finally { await browser.close(); }
  return R;
}

module.exports = { run };
if (require.main === module) runMain(run, 'Accessibility');
