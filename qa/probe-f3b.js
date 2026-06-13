// F3b probe: open the braille book, load liblouis, and confirm the TTS offset
// map text is back-translated PRINT (real words), not braille glyphs.
const H = require('./lib/harness');

(async () => {
  const { browser, page } = await H.login({ width: 1280, height: 900 });
  try {
    const id = await page.evaluate(async () => {
      const r = await ApiClient.ajax({ url: ApiClient.getUrl('Items', { IncludeItemTypes: 'Book', Recursive: true, SearchTerm: 'Braille Sample' }), type: 'GET', dataType: 'json' });
      const it = (r.Items || []).find(i => i.Name === 'Braille Sample');
      return it ? it.Id : null;
    });
    if (!id) { console.log('NOT INDEXED'); return; }
    const p = await browser.newPage();
    await p.setViewport({ width: 1280, height: 900 });
    const r = await H.openBookViaUI(p, id);
    if (!r.overlay) { console.log('did not open'); await p.close(); return; }
    await new Promise(res => setTimeout(res, 2000));
    const data = await p.evaluate(async () => {
      const R = window.a11yBookReader;
      await R._ensureLiblouis();
      const frame = document.getElementById('abr-frame');
      const doc = frame && frame.contentDocument;
      const built = R._buildOffsetMap(doc);
      const lineCount = doc ? doc.querySelectorAll('.braille-line').length : 0;
      // direct back-translate sanity on one line
      const firstLine = doc ? (doc.querySelector('.braille-line') || {}).textContent : '';
      return {
        liblouisLoaded: !!R._liblouis,
        version: R._liblouis ? R._liblouis.ccall('lou_version', 'string', [], []) : null,
        brailleLineCount: lineCount,
        firstLineBraille: firstLine,
        firstLinePrint: R._brailleToPrint(firstLine),
        ttsText: (built.text || '').slice(0, 200),
        mapEntries: built.map.length,
        wholeNode: built.map.length ? !!built.map[0].wholeNode : false,
      };
    });
    console.log(JSON.stringify(data, null, 1));
    await p.close();
  } finally { await browser.close(); }
})();
