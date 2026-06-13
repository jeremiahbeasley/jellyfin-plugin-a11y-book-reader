// F3d probe: braille navigation. Open "Braille Book" (has headings), check the
// server TOC (layout-detected heading anchors) back-translates to real titles,
// and the page list reflects the embosser pages.
const H = require('./lib/harness');

(async () => {
  const { browser, page } = await H.login({ width: 1280, height: 900 });
  try {
    const id = await page.evaluate(async () => {
      const r = await ApiClient.ajax({ url: ApiClient.getUrl('Items', { IncludeItemTypes: 'Book', Recursive: true, SearchTerm: 'Braille Book' }), type: 'GET', dataType: 'json' });
      const it = (r.Items || []).find(i => i.Name === 'Braille Book');
      return it ? it.Id : null;
    });
    if (!id) { console.log('NOT INDEXED'); return; }
    const p = await browser.newPage();
    await p.setViewport({ width: 1280, height: 900 });
    await H.openBookViaUI(p, id);
    await new Promise(res => setTimeout(res, 2500));
    const data = await p.evaluate(async (itemId) => {
      const R = window.a11yBookReader;
      await R._ensureLiblouis();
      const nav = await ApiClient.ajax({ url: ApiClient.getUrl('A11yBookReader/nav/' + itemId), type: 'GET', dataType: 'json' });
      const toc = (nav.Toc || nav.toc || []);
      const tocPrint = toc.map(t => ({ anchor: t.Anchor || t.anchor, braille: (t.Title || t.title), print: R._brailleToPrint(t.Title || t.title || '') }));
      const pageList = (nav.PageList || nav.pageList || []).length;
      const built = R._buildOffsetMap(document.getElementById('abr-frame').contentDocument);
      return { tocPrint, pageList, ttsText: (built.text || '').slice(0, 200) };
    }, id);
    console.log(JSON.stringify(data, null, 1));
    await p.close();
  } finally { await browser.close(); }
})();
