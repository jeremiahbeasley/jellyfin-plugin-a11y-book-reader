// F3c probe: investigate braille multi-page TTS advance. Open the braille book,
// report view mode + spine, then load page 2 (chapter 1) and check its TTS text.
const H = require('./lib/harness');

(async () => {
  const { browser, page } = await H.login({ width: 1280, height: 900 });
  try {
    const id = await page.evaluate(async () => {
      const r = await ApiClient.ajax({ url: ApiClient.getUrl('Items', { IncludeItemTypes: 'Book', Recursive: true, SearchTerm: 'Braille Sample' }), type: 'GET', dataType: 'json' });
      const it = (r.Items || []).find(i => i.Name === 'Braille Sample');
      return it ? it.Id : null;
    });
    const p = await browser.newPage();
    await p.setViewport({ width: 1280, height: 900 });
    await H.openBookViaUI(p, id);
    await new Promise(res => setTimeout(res, 2500));

    const before = await p.evaluate(async () => {
      const R = window.a11yBookReader;
      await R._ensureLiblouis();
      const doc = document.getElementById('abr-frame').contentDocument;
      return { viewMode: R._viewMode, spine: R._spine.length, chapterIndex: R._chapterIndex, page1Text: (R._buildOffsetMap(doc).text || '').slice(0, 100) };
    });
    console.log('BEFORE:', JSON.stringify(before));

    // Load page 2 (chapter 1) and re-check
    const after = await p.evaluate(async () => {
      const R = window.a11yBookReader;
      R._loadChapter(1);
      await new Promise(res => setTimeout(res, 1500));
      const doc = document.getElementById('abr-frame').contentDocument;
      const lines = doc.querySelectorAll('.braille-line').length;
      const built = R._buildOffsetMap(doc);
      return { chapterIndex: R._chapterIndex, brailleLines: lines, page2Text: (built.text || '').slice(0, 120), mapEntries: built.map.length };
    });
    console.log('AFTER load chapter 1:', JSON.stringify(after));
    await p.close();
  } finally { await browser.close(); }
})();
