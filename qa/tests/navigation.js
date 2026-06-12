// Navigation regression: BOTH tracks — navigate by view (Prev/Next) and
// navigate by rotor (⏪/⏩ + "Navigate by" unit) — across every view mode,
// on the PDF (Original layout + reflow) and the EPUB. All moves go through
// the REAL UI controls; every step asserts arrival, intact rendering, and
// an unchanged view mode (the "silently fell back to text view" class).
const H = require('../lib/harness');
const { runMain } = require('../lib/report');

async function run() {
  const R = [], log = (n, p, d) => R.push({ name: n, pass: p, detail: d || '' });
  const { browser, page, errs } = await H.login({ width: 1280, height: 900 });
  try {
    // ── shared in-page helpers ──────────────────────────────────────────
    const state = () => page.evaluate(() => {
      const A = window.a11yBookReader;
      const f = document.getElementById('abr-frame');
      const doc = f && f.contentDocument;
      const c = doc && doc.getElementById('abr-pdf-canvas');
      let painted = null;
      if (c && c.width) {
        const d = c.getContext('2d').getImageData(0, 0, 300, 300).data;
        let nw = 0;
        for (let i = 0; i < d.length; i += 40) if (d[i + 3] > 0 && (d[i] < 240 || d[i + 1] < 240 || d[i + 2] < 240)) nw++;
        painted = nw > 50;
      }
      let scrollY = 0;
      try { scrollY = Math.round(f.contentWindow.pageYOffset); } catch (e) {}
      return {
        mode: A._viewMode, ch: A._chapterIndex, pg: A._page, pdf: A._pdfPage,
        painted, scrollY, tts: A._ttsCharOffset || 0,
        reflowBody: !!(doc && doc.body && !doc.getElementById('abr-pdf-wrap')
                       && (doc.body.textContent || '').trim().length > 50),
      };
    });
    const setUnit = u => page.evaluate(x => {
      const sel = document.getElementById('abr-nav-unit');
      sel.value = x; sel.dispatchEvent(new Event('change', { bubbles: true }));
    }, u);
    const click = id => page.evaluate(x => document.getElementById(x).click(), id);
    const pause = ms => new Promise(r => setTimeout(r, ms));
    const setMode = async m => {
      await page.evaluate(x => window.a11yBookReader._setViewMode(x), m);
      if (m === 'pdfview') {
        await page.evaluate(async () => {
          const A = window.a11yBookReader;
          for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 1000)); if (A._pdfDoc) break; }
        });
      }
      await pause(2500);
    };

    // ════ PART 1: PDF book, Original layout ════
    await H.openBookViaUI(page, H.cfg.books.pdf);
    await pause(4000);
    await setMode('pdfview');
    await page.evaluate(async () => { await window.a11yBookReader._pdfRenderPage(1); });
    await pause(800);
    let s = await state();
    log('pdfview: enters rendered at page 1', s.mode === 'pdfview' && s.pdf === 1 && s.painted === true, JSON.stringify(s));

    // view nav: Next / Prev / clamp at first page
    await click('abr-next'); await pause(2000); s = await state();
    log('pdfview view-nav: Next → page 2, still painted', s.pdf === 2 && s.painted === true && s.mode === 'pdfview', JSON.stringify(s));
    await click('abr-prev'); await pause(2000); s = await state();
    log('pdfview view-nav: Prev → page 1', s.pdf === 1 && s.painted === true, JSON.stringify(s));
    await click('abr-prev'); await pause(1500); s = await state();
    log('pdfview view-nav: Prev clamps at first page', s.pdf === 1, JSON.stringify(s));
    const last = await page.evaluate(async () => {
      const A = window.a11yBookReader;
      await A._pdfRenderPage(A._pdfNumPages);
      return A._pdfNumPages;
    });
    await pause(1500);
    await click('abr-next'); await pause(1500); s = await state();
    log('pdfview view-nav: Next clamps at last page', s.pdf === last, JSON.stringify({ pdf: s.pdf, last }));

    // rotor: page unit
    await page.evaluate(async () => { await window.a11yBookReader._pdfRenderPage(40); });
    await pause(1500);
    await setUnit('page');
    await click('abr-audio-fwd'); await pause(2000); s = await state();
    log('pdfview rotor page: ⏩ → page 41', s.pdf === 41 && s.painted === true, JSON.stringify(s));
    await click('abr-audio-back'); await pause(2000); s = await state();
    log('pdfview rotor page: ⏪ → page 40', s.pdf === 40, JSON.stringify(s));

    // rotor: chapter unit — must land on the NEXT chapter's first page
    const chapPlan = await page.evaluate(async () => {
      const A = window.a11yBookReader;
      const nav = await A._fetchNav();
      const cur = A._chapterIndex;
      return {
        cur,
        nextFirst: A._pdfFirstPageOfChapter(nav, cur + 1),
        curFirst: A._pdfFirstPageOfChapter(nav, cur),
      };
    });
    await setUnit('chapter');
    await click('abr-audio-fwd'); await pause(3000); s = await state();
    log('pdfview rotor chapter: ⏩ → next chapter first page', s.pdf === chapPlan.nextFirst && s.mode === 'pdfview' && s.painted === true, JSON.stringify({ s, chapPlan }));
    await click('abr-audio-back'); await pause(3000); s = await state();
    log('pdfview rotor chapter: ⏪ → back to current chapter first page', s.pdf === chapPlan.curFirst && s.painted === true, JSON.stringify({ s, chapPlan }));

    // rotor: fine units step by page (fixed layout has no reflow structure)
    for (const u of ['heading', 'paragraph', 'sentence']) {
      const before = (await state()).pdf;
      await setUnit(u);
      await click('abr-audio-fwd'); await pause(2000); s = await state();
      log('pdfview rotor ' + u + ': ⏩ steps one page, stays rendered', s.pdf === before + 1 && s.mode === 'pdfview' && s.painted === true, JSON.stringify(s));
    }

    // position bookkeeping in pdfview (what gets SAVED)
    const book = await page.evaluate(() => {
      const A = window.a11yBookReader;
      return {
        frac: A._currentScrollFraction(),
        expect: (A._pdfPage - 1) / (A._pdfNumPages - 1),
        para: A._firstVisiblePara(),
      };
    });
    log('pdfview: saved fraction is the book-wide page fraction', Math.abs(book.frac - book.expect) < 1e-9 && book.para === null, JSON.stringify(book));

    // rotor: bookmark unit — toggle detection + cross-book skips
    await page.evaluate(async () => {
      const A = window.a11yBookReader;
      const list = await ApiClient.ajax({ url: ApiClient.getUrl('A11yBookReader/annotations/' + A._currentItemId), type: 'GET', dataType: 'json' });
      for (const a of (list || [])) await ApiClient.ajax({ url: ApiClient.getUrl('A11yBookReader/annotations/' + A._currentItemId + '/' + (a.Id || a.id)), type: 'DELETE' });
      A._annotations = [];
      await A._pdfRenderPage(40);
    });
    await pause(1500);
    const bmCount = () => page.evaluate(() => window.a11yBookReader._bookmarks().length);
    await page.evaluate(() => window.a11yBookReader._toggleBookmark()); await pause(1200);
    log('pdfview bookmark: toggle ON stores one', (await bmCount()) === 1, 'count ' + await bmCount());
    await page.evaluate(() => window.a11yBookReader._toggleBookmark()); await pause(1200);
    log('pdfview bookmark: toggle on SAME page removes it', (await bmCount()) === 0, 'count ' + await bmCount());
    await page.evaluate(() => window.a11yBookReader._toggleBookmark()); await pause(1200);
    await page.evaluate(async () => { await window.a11yBookReader._pdfRenderPage(200); });
    await pause(1500);
    await page.evaluate(() => window.a11yBookReader._toggleBookmark()); await pause(1200);
    log('pdfview bookmark: two stored on pages 40 and 200', (await bmCount()) === 2, 'count ' + await bmCount());
    await setUnit('bookmark');
    await click('abr-audio-back'); await pause(3000); s = await state();
    log('pdfview rotor bookmark: ⏪ from 200 lands page 40', s.pdf === 40 && s.painted === true, JSON.stringify(s));
    await click('abr-audio-fwd'); await pause(3000); s = await state();
    log('pdfview rotor bookmark: ⏩ returns to page 200', s.pdf === 200 && s.painted === true, JSON.stringify(s));
    await page.evaluate(async () => {
      const A = window.a11yBookReader;
      const list = await ApiClient.ajax({ url: ApiClient.getUrl('A11yBookReader/annotations/' + A._currentItemId), type: 'GET', dataType: 'json' });
      for (const a of (list || [])) await ApiClient.ajax({ url: ApiClient.getUrl('A11yBookReader/annotations/' + A._currentItemId + '/' + (a.Id || a.id)), type: 'DELETE' });
      A._annotations = [];
    });

    // TTS continuation: rotor page skip while reading must resume, ONCE
    await page.evaluate(async () => {
      const A = window.a11yBookReader;
      await A._pdfRenderPage(40);
      const sel = document.getElementById('abr-voice-select');
      sel.value = [...sel.options].find(x => x.value.startsWith('piper:')).value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('abr-tts-toggle').click();
    });
    await pause(12000);
    const playing0 = await page.evaluate(() => window.a11yBookReader._ttsPlaying);
    await setUnit('page');
    await click('abr-audio-fwd');
    await pause(12000);
    const tts = await page.evaluate(() => {
      const A = window.a11yBookReader;
      const live = [...document.querySelectorAll('audio')].filter(a => !a.paused && !a.ended).length;
      return { playing: A._ttsPlaying, pdf: A._pdfPage, liveAudio: live };
    });
    log('pdfview TTS: rotor skip while reading resumes on the new page', playing0 === true && tts.playing === true && tts.pdf === 41, JSON.stringify({ playing0, tts }));
    log('pdfview TTS: exactly one audio stream after skip (no double start)', tts.liveAudio <= 1, JSON.stringify(tts));
    await page.evaluate(() => document.getElementById('abr-tts-stop').click());
    await pause(1500);

    // d-pad content access: with the frame focused, Down scrolls within the
    // tall page (the bottom half used to be unreachable without TTS), and
    // page turns announce to screen readers while in Original layout.
    await page.evaluate(() => document.getElementById('abr-frame').focus());
    const y0 = await page.evaluate(() => document.getElementById('abr-frame').contentWindow.pageYOffset);
    await page.keyboard.press('ArrowDown');
    await pause(900);
    const y1 = await page.evaluate(() => document.getElementById('abr-frame').contentWindow.pageYOffset);
    log('pdfview d-pad: ArrowDown in frame scrolls within the page', y1 > y0, y0 + ' -> ' + y1);
    const liveOn = await page.evaluate(() => document.getElementById('abr-page-info').getAttribute('aria-live'));
    log('pdfview: page readout announces (aria-live polite)', liveOn === 'polite', String(liveOn));

    // ════ PART 2: PDF book, reflow page mode round-trip ════
    await setMode('page');
    s = await state();
    log('pdf reflow: switch to Page view renders reflow text', s.mode === 'page' && s.reflowBody === true, JSON.stringify(s));
    // Page view also announces page turns (discrete) — only the churning
    // scroll/chapter readouts are silent.
    const livePage = await page.evaluate(() => document.getElementById('abr-page-info').getAttribute('aria-live'));
    log('reflow page mode: page readout stays polite (discrete turns)', livePage === 'polite', String(livePage));
    const pg0 = s.pg;
    await click('abr-next'); await pause(2000); s = await state();
    log('pdf reflow page: Next advances a page', s.pg === pg0 + 1 || s.ch !== undefined && s.pg === 0 && s.reflowBody, JSON.stringify({ before: pg0, s }));
    await setUnit('chapter');
    const ch0 = s.ch;
    await click('abr-audio-fwd'); await pause(3500); s = await state();
    log('pdf reflow rotor chapter: ⏩ → next chapter', s.ch === ch0 + 1 && s.reflowBody === true, JSON.stringify({ ch0, s }));
    await setMode('pdfview');
    s = await state();
    log('pdf: back to Original layout still renders', s.mode === 'pdfview' && s.painted === true, JSON.stringify(s));

    // ════ PART 3: EPUB, all three reflow modes ════
    await page.evaluate(() => { try { document.getElementById('abr-close-btn').click(); } catch (e) {} });
    await pause(1500);
    await H.openBookViaUI(page, H.cfg.books.primary);
    await pause(3500);

    for (const mode of ['page', 'chapter', 'scroll']) {
      await setMode(mode);
      // park deterministically at chapter 1 (chapter 0 covers, chapter 5 prose)
      await page.evaluate(() => window.a11yBookReader._goToTarget(1, null));
      await page.evaluate(async () => {
        const A = window.a11yBookReader;
        for (let t = 0; t < 10 && A._chapterIndex !== 1; t++) await new Promise(r => setTimeout(r, 400));
      });
      await pause(800);
      s = await state();
      const okPark = s.ch === 1 && s.mode === mode;
      log('epub ' + mode + ': parked at chapter 1', okPark, JSON.stringify(s));

      // view nav: Next then Prev return to a coherent position
      const sig0 = JSON.stringify([s.ch, s.pg, Math.round(s.scrollY / 50)]);
      await click('abr-next'); await pause(2500); s = await state();
      const sig1 = JSON.stringify([s.ch, s.pg, Math.round(s.scrollY / 50)]);
      log('epub ' + mode + ' view-nav: Next moves the position', sig1 !== sig0 && s.mode === mode && s.reflowBody === true, sig0 + ' -> ' + sig1);
      await click('abr-prev'); await pause(2500); s = await state();
      log('epub ' + mode + ' view-nav: Prev stays in mode, content intact', s.mode === mode && s.reflowBody === true, JSON.stringify(s));

      // rotor: chapter fwd/back arrivals
      await setUnit('chapter');
      const c0 = (await state()).ch;
      await click('abr-audio-fwd');
      await page.evaluate(async c => {
        const A = window.a11yBookReader;
        for (let t = 0; t < 10 && A._chapterIndex !== c + 1; t++) await new Promise(r => setTimeout(r, 400));
      }, c0);
      await pause(600);
      s = await state();
      log('epub ' + mode + ' rotor chapter: ⏩ arrives at chapter ' + (c0 + 1), s.ch === c0 + 1 && s.reflowBody === true, JSON.stringify(s));
      await click('abr-audio-back');
      await page.evaluate(async c => {
        const A = window.a11yBookReader;
        for (let t = 0; t < 10 && A._chapterIndex !== c; t++) await new Promise(r => setTimeout(r, 400));
      }, c0);
      await pause(600);
      s = await state();
      log('epub ' + mode + ' rotor chapter: ⏪ returns to chapter ' + c0, s.ch === c0, JSON.stringify(s));

      // rotor: fine units move the position without leaving the mode
      // (prose lives in chapter 5 — park there so headings/sentences exist)
      await page.evaluate(() => window.a11yBookReader._goToTarget(5, null));
      await page.evaluate(async () => {
        const A = window.a11yBookReader;
        for (let t = 0; t < 10 && A._chapterIndex !== 5; t++) await new Promise(r => setTimeout(r, 400));
      });
      await pause(800);
      for (const u of ['paragraph', 'sentence']) {
        await setUnit(u);
        const b = await state();
        await click('abr-audio-fwd'); await pause(2500);
        s = await state();
        // The step's observable is the reading anchor (it highlights the
        // target block); the page/scroll only changes when the target is
        // outside the current view.
        const moved = s.tts !== b.tts
          || JSON.stringify([s.ch, s.pg, Math.round(s.scrollY / 25)]) !== JSON.stringify([b.ch, b.pg, Math.round(b.scrollY / 25)]);
        log('epub ' + mode + ' rotor ' + u + ': ⏩ moves the reading anchor, stays in mode',
            s.mode === mode && s.reflowBody === true && moved,
            JSON.stringify({ before: [b.ch, b.pg, b.scrollY, b.tts], after: [s.ch, s.pg, s.scrollY, s.tts] }));
      }
    }

    // scroll mode: the known sore spot — multi-chapter BACKWARD jump
    await setMode('scroll');
    await page.evaluate(() => window.a11yBookReader._goToTarget(5, null));
    await page.evaluate(async () => {
      const A = window.a11yBookReader;
      for (let t = 0; t < 10 && A._chapterIndex !== 5; t++) await new Promise(r => setTimeout(r, 400));
    });
    await pause(800);
    await page.evaluate(() => window.a11yBookReader._goToTarget(1, null));
    await page.evaluate(async () => {
      const A = window.a11yBookReader;
      for (let t = 0; t < 12 && A._chapterIndex !== 1; t++) await new Promise(r => setTimeout(r, 400));
    });
    await pause(800);
    s = await state();
    log('epub scroll: backward multi-chapter jump (5 → 1) arrives', s.ch === 1, JSON.stringify(s));

    log('no reader JS errors', errs.length === 0, JSON.stringify(errs));
    return R;
  } finally { await browser.close(); }
}

module.exports = { run };
if (require.main === module) runMain(run, 'Navigation');
