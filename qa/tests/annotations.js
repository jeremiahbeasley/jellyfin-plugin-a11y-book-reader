// Annotations regression (Phase 6): bookmarks (B key, rotor unit, list),
// highlights + notes from a text selection (quote+position anchoring, CSS
// Custom Highlight painting), list filter/search/edit, export endpoints.
// Creates its own test data and deletes it at the end.
const H = require('../lib/harness');
const { runMain } = require('../lib/report');

async function run() {
  const R = [], log = (n, p, d) => R.push({ name: n, pass: p, detail: d || '' });
  const { browser, page, errs } = await H.login({ width: 1280, height: 900 });
  try {
    await H.openBookViaUI(page, H.cfg.books.primary);
    await new Promise(r => setTimeout(r, 1500));

    // Land on a PROSE chapter (>= 3 long blocks). Navigation goes through
    // _goToTarget ONLY: it is correct in every view mode — mixing in
    // _loadChapter would tear down the scroll engine's stitched document
    // while _scrollSections still points at the detached DOM.
    const prose = await page.evaluate(async () => {
      const R = window.a11yBookReader;
      const longBlocks = () => {
        const doc = document.getElementById('abr-frame').contentDocument;
        const sec = doc.querySelector('section.abr-ch[data-ch="' + R._chapterIndex + '"]');
        const blocks = R._viewMode === 'scroll'
          ? (sec ? R._getBlocksIn(sec) : [])
          : R._getBlocks(doc);
        return [...blocks].filter(b => (b.textContent || '').trim().length > 60).length;
      };
      const trace = [];
      for (let i = 0; i < R._spine.length; i++) {
        R._goToTarget(i, null);
        // Wait for ARRIVAL (the scroll engine retries for up to ~2s) — a
        // resident section is not proof the reader actually moved there
        for (let t = 0; t < 8 && R._chapterIndex !== i; t++) await new Promise(r => setTimeout(r, 400));
        await new Promise(r => setTimeout(r, 400));
        trace.push(i + ':' + (R._chapterIndex === i ? 'at' : 'miss@' + R._chapterIndex) + '/' + longBlocks());
        if (R._chapterIndex === i && longBlocks() >= 3) return { chapter: i, blocks: longBlocks(), trace: trace.join(' ') };
      }
      return { chapter: -1, trace: trace.join(' ') };
    });
    log('found a prose chapter for anchoring', prose.chapter >= 0, JSON.stringify(prose));
    if (prose.chapter < 0) { return R; }

    // start clean: remove any leftovers from earlier runs
    await page.evaluate(async () => {
      const R = window.a11yBookReader;
      const list = await ApiClient.ajax({ url: ApiClient.getUrl('A11yBookReader/annotations/' + R._currentItemId), type: 'GET', dataType: 'json' });
      for (const a of (list || [])) {
        await ApiClient.ajax({ url: ApiClient.getUrl('A11yBookReader/annotations/' + R._currentItemId + '/' + (a.Id || a.id)), type: 'DELETE' });
      }
      R._annotations = [];
    });

    // ── bookmarks: B key toggles, button reflects, server persists ──
    await page.evaluate(() => document.getElementById('abr-overlay').focus());
    await page.keyboard.press('b');
    await new Promise(r => setTimeout(r, 1200));
    const bm = await page.evaluate(() => ({
      pressed: document.getElementById('abr-bookmark-btn').getAttribute('aria-pressed'),
      count: window.a11yBookReader._bookmarks().length,
    }));
    log('B key adds a bookmark (button pressed, stored)', bm.pressed === 'true' && bm.count === 1, JSON.stringify(bm));

    // rotor has the Bookmark unit
    log('rotor offers Bookmark unit', await page.evaluate(() => {
      const s = document.getElementById('abr-nav-unit');
      return [...s.options].some(o => o.value === 'bookmark');
    }));

    // second bookmark two chapters on, then rotor-skip back
    const moved = await page.evaluate(async () => {
      const R = window.a11yBookReader;
      const start = R._chapterIndex;
      // Must be a genuinely DIFFERENT chapter — at the book's edge, go backward
      const target = start + 2 < R._spine.length ? start + 2 : start - 2;
      R._goToTarget(target, null);
      for (let t = 0; t < 8 && R._chapterIndex !== target; t++) await new Promise(r => setTimeout(r, 400));
      return { start, target, at: R._chapterIndex };
    });
    log('navigated to a second chapter for bookmark 2', moved.at === moved.target && moved.target !== moved.start, JSON.stringify(moved));
    await page.evaluate(() => document.getElementById('abr-overlay').focus());
    await page.keyboard.press('b');
    await new Promise(r => setTimeout(r, 1200));
    await page.evaluate(() => {
      const s = document.getElementById('abr-nav-unit');
      s.value = 'bookmark';
      s.dispatchEvent(new Event('change', { bubbles: true }));
    });
    // skip toward bookmark 1, whichever direction it lies in
    const skipBtn = moved.target > moved.start ? 'abr-audio-back' : 'abr-audio-fwd';
    await page.evaluate(id => document.getElementById(id).click(), skipBtn);
    await new Promise(r => setTimeout(r, 2500)); // scroll-mode jump retries for up to 2s
    const skip = await page.evaluate(() => ({
      ch: window.a11yBookReader._chapterIndex,
      announce: document.getElementById('abr-chapter-info').textContent,
    }));
    log('rotor skips to the other bookmark with N-of-M announce',
      skip.ch === moved.start && /Bookmark \d+ of \d+/.test(skip.announce), JSON.stringify({ skip, expected: moved.start }));

    // ── highlight from a programmatic selection ──
    const hl = await page.evaluate(async () => {
      const R = window.a11yBookReader;
      const doc = document.getElementById('abr-frame').contentDocument;
      const sec = doc.querySelector('section.abr-ch[data-ch="' + R._chapterIndex + '"]');
      const blocks = R._viewMode === 'scroll'
        ? (sec ? R._getBlocksIn(sec) : [])
        : R._getBlocks(doc);
      const block = [...blocks].find(b => (b.textContent || '').trim().length > 60);
      if (!block) return { err: 'no text block' };
      // select chars 5..45 of the block's first sufficient text node
      const walker = doc.createTreeWalker(block, 4);
      let node; while ((node = walker.nextNode())) { if (node.textContent.length > 50) break; }
      if (!node) return { err: 'no text node' };
      const range = doc.createRange();
      range.setStart(node, 5); range.setEnd(node, 45);
      const sel = doc.getSelection(); sel.removeAllRanges(); sel.addRange(range);
      R._maybeShowSelPopover(document.getElementById('abr-frame'), doc);
      await new Promise(r => setTimeout(r, 200));
      const popped = !!document.getElementById('abr-sel-pop');
      const pending = !!R._pendingSel;
      R._createAnnotation('highlight', null);
      await new Promise(r => setTimeout(r, 1200));
      const anns = R._annotations.filter(a => a.type === 'highlight');
      const win = document.getElementById('abr-frame').contentWindow;
      const painted = win.CSS && win.CSS.highlights && win.CSS.highlights.get('abr-ann-yellow')
        ? win.CSS.highlights.get('abr-ann-yellow').size : -1;
      return { popped, pending, count: anns.length, quote: (anns[0] || {}).quote, painted };
    });
    log('selection popover appears with pending payload', hl.popped === true && hl.pending === true, JSON.stringify({ popped: hl.popped, pending: hl.pending, err: hl.err }));
    log('highlight saved with 40-char quote', hl.count === 1 && (hl.quote || '').length === 40, 'quote len ' + ((hl.quote || '').length));
    log('highlight painted via CSS Highlight API', hl.painted >= 1, 'ranges ' + hl.painted);

    // ── note from a selection, then edit it via the list ──
    const note = await page.evaluate(async () => {
      const R = window.a11yBookReader;
      const doc = document.getElementById('abr-frame').contentDocument;
      const sec = doc.querySelector('section.abr-ch[data-ch="' + R._chapterIndex + '"]');
      const blocks = R._viewMode === 'scroll'
        ? (sec ? R._getBlocksIn(sec) : [])
        : R._getBlocks(doc);
      const block = [...blocks].filter(b => (b.textContent || '').trim().length > 60)[1];
      if (!block) return { err: 'no second block' };
      const walker = doc.createTreeWalker(block, 4);
      let node; while ((node = walker.nextNode())) { if (node.textContent.length > 30) break; }
      const range = doc.createRange();
      range.setStart(node, 0); range.setEnd(node, 25);
      const sel = doc.getSelection(); sel.removeAllRanges(); sel.addRange(range);
      R._maybeShowSelPopover(document.getElementById('abr-frame'), doc);
      await new Promise(r => setTimeout(r, 150));
      R._createAnnotation('note', 'qa note body');
      await new Promise(r => setTimeout(r, 1200));
      const n = R._annotations.filter(a => a.type === 'note');
      return { count: n.length, body: (n[0] || {}).body, id: (n[0] || {}).id };
    });
    log('note saved with body', note.count === 1 && note.body === 'qa note body', JSON.stringify({ body: note.body, err: note.err }));

    // edit the note through the update endpoint (as the list Edit/Save does —
    // including the local-cache update the UI's Save performs). Guard: a
    // missing id must FAIL the check, not throw a raw 404 out of the suite.
    const edited = !note.id ? '(no note id)' : await page.evaluate(async (id) => {
      const R = window.a11yBookReader;
      const u = await ApiClient.ajax({
        url: ApiClient.getUrl('A11yBookReader/annotations/' + R._currentItemId + '/' + id),
        type: 'POST', contentType: 'application/json', dataType: 'json',
        data: JSON.stringify({ Body: 'edited body' })
      });
      const local = R._annotations.find(a => a.id === id);
      if (local) local.body = (u.Body || u.body);
      return (u.Body || u.body);
    }, note.id);
    log('note body updates via update endpoint', edited === 'edited body', String(edited));

    // ── annotations tab: rows, filter, search ──
    await page.evaluate(() => document.getElementById('abr-bookmap-btn').click());
    await new Promise(r => setTimeout(r, 500));
    await page.evaluate(() => document.getElementById('abr-tab-bookmarks').click());
    await new Promise(r => setTimeout(r, 500));
    const tab = await page.evaluate(async () => {
      const rows = () => document.querySelectorAll('#abr-ann-list .abr-bm-row').length;
      const all = rows();
      const f = document.getElementById('abr-ann-filter');
      f.value = 'note'; f.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 300));
      const notesOnly = document.querySelectorAll('#abr-ann-list .abr-bm-row').length;
      const f2 = document.getElementById('abr-ann-filter');
      f2.value = 'all'; f2.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 300));
      const s = document.getElementById('abr-ann-search');
      s.value = 'edited body'; s.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 200));
      const searched = document.querySelectorAll('#abr-ann-list .abr-bm-row').length;
      return { all, notesOnly, searched };
    });
    log('tab lists all 4 annotations', tab.all === 4, JSON.stringify(tab));
    log('type filter narrows to notes', tab.notesOnly === 1, 'rows ' + tab.notesOnly);
    log('text search matches note body', tab.searched === 1, 'rows ' + tab.searched);
    await page.evaluate(() => document.getElementById('abr-bookmap-btn').click());

    // ── export endpoints ──
    const exp = await page.evaluate(async () => {
      const R = window.a11yBookReader;
      const token = ApiClient.accessToken();
      const j = await (await fetch(ApiClient.getUrl('A11yBookReader/annotations/' + R._currentItemId + '/export', { format: 'json', api_key: token }))).json();
      const m = await (await fetch(ApiClient.getUrl('A11yBookReader/annotations/' + R._currentItemId + '/export', { format: 'md', api_key: token }))).text();
      return {
        ctx: j['@context'], total: j.total,
        motiv: (j.items || []).map(i => i.motivation).sort().join(','),
        mdOk: m.startsWith('# Annotations') && m.includes('edited body'),
      };
    });
    log('JSON-LD export: context + 4 items + motivations',
      exp.ctx === 'http://www.w3.org/ns/anno.jsonld' && exp.total === 4 &&
      exp.motiv === 'bookmarking,bookmarking,commenting,highlighting', JSON.stringify(exp));
    log('Markdown export renders title and note', exp.mdOk === true);

    // ── cleanup: delete everything we created ──
    const left = await page.evaluate(async () => {
      const R = window.a11yBookReader;
      const list = await ApiClient.ajax({ url: ApiClient.getUrl('A11yBookReader/annotations/' + R._currentItemId), type: 'GET', dataType: 'json' });
      for (const a of (list || [])) {
        await ApiClient.ajax({ url: ApiClient.getUrl('A11yBookReader/annotations/' + R._currentItemId + '/' + (a.Id || a.id)), type: 'DELETE' });
      }
      const after = await ApiClient.ajax({ url: ApiClient.getUrl('A11yBookReader/annotations/' + R._currentItemId), type: 'GET', dataType: 'json' });
      return (after || []).length;
    });
    log('cleanup leaves zero annotations', left === 0, left + ' remaining');

    log('no reader JS errors', errs.length === 0, JSON.stringify(errs.slice(0, 3)));
  } finally { await browser.close(); }
  return R;
}

module.exports = { run };
if (require.main === module) runMain(run, 'Annotations');
