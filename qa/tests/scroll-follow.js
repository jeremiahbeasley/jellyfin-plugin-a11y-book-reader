// TTS auto-scroll regression: in scroll mode the page must follow the spoken
// word by PARAGRAPH only — it scrolls when the word enters a new paragraph and
// holds still within one (guards the v1.0.0.39 fix against regressing to the
// per-tick re-centering that made the page jump around).
const H = require('../lib/harness');
const { runMain } = require('../lib/report');

async function run() {
  const R = [], log = (n, p, d) => R.push({ name: n, pass: p, detail: d || '' });
  const { browser, page } = await H.login({ width: 900, height: 600 });
  try {
    await H.openBookViaUI(page, H.cfg.books.primary);
    // find a chapter tall enough to scroll
    const tall = await page.evaluate(async () => {
      const R = window.a11yBookReader;
      // the scan must run in scroll mode: the QA user's server-saved ViewMode may
      // be 'page', whose column layout never exceeds the viewport height
      if (R._viewMode !== 'scroll') { R._setViewMode('scroll'); await new Promise(r => setTimeout(r, 600)); }
      for (let i = 0; i < R._spine.length; i++) {
        await new Promise(r => { R._loadChapter(i); setTimeout(r, 700); });
        const f = document.getElementById('abr-frame');
        try { if (f.contentDocument.documentElement.scrollHeight > 3000) return i; } catch (e) {}
      }
      return -1;
    });
    if (tall < 0) { log('found a tall chapter to test', false, 'no chapter > 3000px'); return R; }

    const out = await page.evaluate(async () => {
      const R = window.a11yBookReader, frame = document.getElementById('abr-frame'), win = frame.contentWindow;
      R._viewMode = 'scroll'; R._reducedMotion = true;   // instant scroll => deterministic
      const doc = frame.contentDocument;
      const built = R._buildOffsetMap(doc); R._ttsFullText = built.text; R._ttsOffsetMap = built.map;
      // group text nodes into blocks the way _followScroll does (nearest BLOCK ancestor)
      const BLOCK = /^(P|DIV|H[1-6]|LI|TR|TD|TH|BLOCKQUOTE|SECTION|ARTICLE|HEADER|FOOTER|MAIN|NAV|ASIDE|FIGURE|FIGCAPTION|PRE)$/;
      const blockOf = n => { let b = n.parentElement; while (b && !BLOCK.test(b.nodeName)) b = b.parentElement; return b; };
      const blocks = []; let cur = null;
      built.map.forEach(m => { const el = blockOf(m.node); if (!el) return; if (!cur || cur.el !== el) { cur = { el, start: m.absStart, end: m.absEnd }; blocks.push(cur); } else cur.end = m.absEnd; });
      const longs = blocks.map((b, idx) => ({ b, idx, len: b.end - b.start })).filter(x => x.len > 120);
      // _followScroll only re-anchors a NEW paragraph when it is poorly placed
      // (top outside the 12-55% viewport band) and the scroll target is reachable.
      // Pick a target/next pair where a scroll MUST happen — anything else holds
      // by design and would fail the test unfairly.
      const vh = win.innerHeight, maxScroll = doc.documentElement.scrollHeight - vh;
      const topOf = el => el.getBoundingClientRect().top + (win.pageYOffset || 0);
      let target = null, next = null;
      for (const t of longs) {
        const n = longs.find(x => x.idx > t.idx);
        if (!n) break;
        const tAnchor = topOf(t.b.el) - vh * 0.25;
        const nAnchor = topOf(n.b.el) - vh * 0.25;
        if (tAnchor > 0 && tAnchor < maxScroll - 10 && nAnchor < maxScroll - 10 &&
            (topOf(n.b.el) - tAnchor) > vh * 0.55) { target = t; next = n; break; }
      }
      if (!target) return { skip: true };
      win.scrollTo(0, 0); R._hlPara = null;
      const y = [];
      R._highlightWord(frame, target.b.start + 5, 4); await new Promise(r => setTimeout(r, 300)); y.push(win.scrollY);
      R._highlightWord(frame, target.b.start + 40, 4); await new Promise(r => setTimeout(r, 300)); y.push(win.scrollY);
      R._highlightWord(frame, target.b.start + 90, 4); await new Promise(r => setTimeout(r, 300)); y.push(win.scrollY);
      R._highlightWord(frame, next.b.start + 5, 4); await new Promise(r => setTimeout(r, 400)); y.push(win.scrollY);
      return { y };
    });
    if (out.skip) { log('scroll-follow (needs long paragraphs)', true, 'skipped: not enough long blocks'); return R; }
    const [a, b, c, d] = out.y;
    log('no scroll within a paragraph', a === b && b === c, 'scrollY ' + a + '/' + b + '/' + c);
    log('scrolls on new paragraph', d !== c, 'scrollY ' + c + ' -> ' + d);
  } finally { await browser.close(); }
  return R;
}

module.exports = { run };
if (require.main === module) runMain(run, 'Scroll-follow');
