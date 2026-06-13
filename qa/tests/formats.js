// Format support regression (v61/v62): plain text, markdown, single-file
// HTML, DAISY 2.02, and DAISY 3 (DTBook) — fixtures live in the eBooks
// library's _qa-formats folder. Each format opens through the real UI and
// must deliver chapters, navigation, and search; HTML must be sanitized;
// DAISY 3 must surface its NCX TOC and page list.
const H = require('../lib/harness');
const { runMain } = require('../lib/report');

async function run() {
  const R = [], log = (n, p, d) => R.push({ name: n, pass: p, detail: d || '' });
  const { browser, page, errs } = await H.login({ width: 1280, height: 900 });
  try {
    const findId = name => page.evaluate(async n => {
      const r = await ApiClient.ajax({
        url: ApiClient.getUrl('Items', { IncludeItemTypes: 'Book', Recursive: true, SearchTerm: n }),
        type: 'GET', dataType: 'json'
      });
      const it = (r.Items || []).find(i => i.Name === n);
      return it ? it.Id : null;
    }, name);

    const openBook = async (name, term) => {
      const id = await findId(name);
      if (!id) return { err: 'not indexed' };
      const p = await browser.newPage();
      await p.setViewport({ width: 1280, height: 900 });
      const r = await H.openBookViaUI(p, id);
      if (!r.overlay) { await p.close(); return { err: 'did not open' }; }
      await new Promise(res => setTimeout(res, 1500));
      const data = await p.evaluate(async (itemId, t) => {
        const R2 = window.a11yBookReader;
        const nav = await ApiClient.ajax({ url: ApiClient.getUrl('A11yBookReader/nav/' + itemId), type: 'GET', dataType: 'json' });
        const sr = await ApiClient.ajax({ url: ApiClient.getUrl('A11yBookReader/search/' + itemId, { q: t }), type: 'GET', dataType: 'json' });
        // Rendering assertions use the server's chapter 0 directly: the live
        // view resumes at the SAVED position, which varies run to run
        const token = ApiClient.accessToken();
        const ch0 = await (await fetch(ApiClient.getUrl('A11yBookReader/chapter/' + itemId + '/0', { api_key: token }))).text();
        // Concatenate every chapter so structural assertions catch tables and
        // lists that live past chapter 0 (e.g. a Word table under heading 2).
        let allHtml = '';
        for (let i = 0; i < R2._spine.length; i++) {
          allHtml += await (await fetch(ApiClient.getUrl('A11yBookReader/chapter/' + itemId + '/' + i, { api_key: token }))).text();
        }
        const toc = nav.Toc || nav.toc || [];
        return {
          spine: R2._spine.length,
          ch0Html: ch0.slice(0, 30000),
          allHtml: allHtml.slice(0, 120000),
          tocCount: toc.length,
          tocNested: toc.some(x => ((x.Children || x.children || []).length) > 0),
          pageList: (nav.PageList || nav.pageList || []).length,
          searchHits: sr.Total || sr.total || 0,
        };
      }, id, term);
      await p.close();
      return data;
    };

    // ── plain text ──
    const txt = await openBook('The Spike Test', 'scanner');
    log('txt: opens with heading-detected chapters', txt.spine === 4, JSON.stringify({ spine: txt.spine, err: txt.err }));
    log('txt: search works', txt.searchHits >= 1, 'hits ' + txt.searchHits);

    // ── markdown ──
    const md = await openBook('Markdown Field Notes', 'quixotic');
    log('md: chapter per heading', md.spine === 4, JSON.stringify({ spine: md.spine, err: md.err }));
    log('md: constructs render', /<strong>/.test(md.ch0Html || '') && /<a href=/.test(md.ch0Html || ''), '');
    log('md: search works', md.searchHits >= 1, 'hits ' + md.searchHits);

    // ── single-file html ──
    const html = await openBook('HTML Single File', 'perspicacious');
    log('html: opens sanitized', html.spine === 1 &&
      !/onclick/i.test(html.ch0Html || '') && !/javascript:/i.test(html.ch0Html || ''),
      JSON.stringify({ spine: html.spine, err: html.err }));
    log('html: search works', html.searchHits >= 1, 'hits ' + html.searchHits);

    // ── DAISY 2.02 ──
    const d2 = await openBook('Daisy Two Garden', 'marigold');
    log('daisy202: content docs become chapters', d2.spine === 2, JSON.stringify({ spine: d2.spine, err: d2.err }));
    log('daisy202: NCC drives a nested TOC', d2.tocCount >= 2 && d2.tocNested === true,
      JSON.stringify({ toc: d2.tocCount, nested: d2.tocNested }));
    log('daisy202: search works', d2.searchHits >= 1, 'hits ' + d2.searchHits);

    // ── DAISY 3 / DTBook ──
    const d3 = await openBook('Daisy Three Orchard', 'pomology');
    log('daisy3: level1 sections become chapters', d3.spine === 2, JSON.stringify({ spine: d3.spine, err: d3.err }));
    log('daisy3: DTBook renders (heading, list, pagebreak)',
      /<h1/.test(d3.ch0Html || '') && /<ul/.test(d3.ch0Html || '') && /doc-pagebreak/.test(d3.ch0Html || ''),
      '');
    log('daisy3: NCX TOC nested + page list', d3.tocCount === 2 && d3.tocNested === true && d3.pageList === 2,
      JSON.stringify({ toc: d3.tocCount, nested: d3.tocNested, pages: d3.pageList }));
    log('daisy3: search works', d3.searchHits >= 1, 'hits ' + d3.searchHits);

    // ── F1 document formats (fb2 / ODF text+presentation / OOXML / rtf / xml) ──
    const fb2 = await openBook('Fiction Fb2 Meadow', 'meadowlark');
    log('fb2: sections become chapters', fb2.spine === 2, JSON.stringify({ spine: fb2.spine, err: fb2.err }));
    log('fb2: emphasis + blockquote render', /<em>|<strong>/.test(fb2.allHtml || '') && /<blockquote>/.test(fb2.allHtml || ''), '');
    log('fb2: lang carried from metadata', /<html lang="en"/.test(fb2.allHtml || ''), '');
    log('fb2: search works', fb2.searchHits >= 1, 'hits ' + fb2.searchHits);

    const odt = await openBook('OpenDoc Text Garden', 'compost');
    log('odt: headings become chapters', odt.spine === 2, JSON.stringify({ spine: odt.spine, err: odt.err }));
    log('odt: accessible table (th scope) + list', /<th scope="col">/.test(odt.allHtml || '') && /<ul>/.test(odt.allHtml || ''), '');
    log('odt: search works', odt.searchHits >= 1, 'hits ' + odt.searchHits);

    const fodt = await openBook('OpenDoc Flat Orchard', 'compost');
    log('fodt: flat ODF opens with chapters', fodt.spine === 2, JSON.stringify({ spine: fodt.spine, err: fodt.err }));
    log('fodt: search works', fodt.searchHits >= 1, 'hits ' + fodt.searchHits);

    const odp = await openBook('OpenDoc Slides Harvest', 'apples');
    log('odp: slides become chapters', odp.spine === 2, JSON.stringify({ spine: odp.spine, err: odp.err }));
    log('odp: slide titles are headings', /<h1>Slide /.test(odp.allHtml || ''), '');
    log('odp: search works', odp.searchHits >= 1, 'hits ' + odp.searchHits);

    const fodp = await openBook('OpenDoc FlatSlides Vine', 'apples');
    log('fodp: flat presentation opens', fodp.spine === 2, JSON.stringify({ spine: fodp.spine, err: fodp.err }));
    log('fodp: search works', fodp.searchHits >= 1, 'hits ' + fodp.searchHits);

    const docx = await openBook('Word Modern Brook', 'trout');
    log('docx: heading1 splits chapters', docx.spine === 2, JSON.stringify({ spine: docx.spine, err: docx.err }));
    log('docx: accessible table (th scope) + list', /<th scope="col">/.test(docx.allHtml || '') && /<ul>/.test(docx.allHtml || ''), '');
    log('docx: search works', docx.searchHits >= 1, 'hits ' + docx.searchHits);

    const pptx = await openBook('PowerPoint Modern Cliff', 'sandstone');
    log('pptx: slides become chapters', pptx.spine === 2, JSON.stringify({ spine: pptx.spine, err: pptx.err }));
    log('pptx: slide titles are headings', /<h1>Slide /.test(pptx.allHtml || ''), '');
    log('pptx: search works', pptx.searchHits >= 1, 'hits ' + pptx.searchHits);

    const rtf = await openBook('Rich Text Dunes', 'marram');
    log('rtf: opens as single chapter', rtf.spine === 1, JSON.stringify({ spine: rtf.spine, err: rtf.err }));
    log('rtf: search works', rtf.searchHits >= 1, 'hits ' + rtf.searchHits);

    const xml = await openBook('Plain Xml Catalog', 'saltspray');
    log('xml: opens via text service', xml.spine === 1, JSON.stringify({ spine: xml.spine, err: xml.err }));
    log('xml: search works', xml.searchHits >= 1, 'hits ' + xml.searchHits);

    log('no reader JS errors', errs.length === 0, JSON.stringify(errs.slice(0, 3)));
  } finally { await browser.close(); }
  return R;
}

module.exports = { run };
if (require.main === module) runMain(run, 'Formats');
