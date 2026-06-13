// F1 format probe (API-only, no browser): for each F1 fixture, confirm it
// indexed, then exercise the plugin's own endpoints — spine (chapter count),
// nav (TOC), search, and chapter 0 HTML. Reports actuals so we can promote
// real assertions into tests/formats.js. Creds come from config.local.js.
const C = require('./config.local');

const FIX = [
  { name: 'Fiction Fb2 Meadow',     ext: '.fb2',  term: 'meadowlark', wantSpine: 2 },
  { name: 'OpenDoc Text Garden',    ext: '.odt',  term: 'compost',    wantSpine: 2 },
  { name: 'OpenDoc Flat Orchard',   ext: '.fodt', term: 'compost',    wantSpine: 2 },
  { name: 'OpenDoc Slides Harvest', ext: '.odp',  term: 'apples',     wantSpine: 2 },
  { name: 'OpenDoc FlatSlides Vine',ext: '.fodp', term: 'apples',     wantSpine: 2 },
  { name: 'Word Modern Brook',      ext: '.docx', term: 'trout',      wantSpine: 2 },
  { name: 'PowerPoint Modern Cliff',ext: '.pptx', term: 'sandstone',  wantSpine: 2 },
  { name: 'Rich Text Dunes',        ext: '.rtf',  term: 'marram',     wantSpine: 1 },
  { name: 'Plain Xml Catalog',      ext: '.xml',  term: 'saltspray',  wantSpine: 1 },
];

async function main() {
  const authHdr = 'MediaBrowser Client="qa", Device="qa", DeviceId="qa-f1", Version="1"';
  const a = await fetch(C.baseUrl + '/Users/AuthenticateByName', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Emby-Authorization': authHdr },
    body: JSON.stringify({ Username: C.user, Pw: C.pass }),
  });
  const j = await a.json().catch(() => ({}));
  if (!j.AccessToken) { console.error('AUTH FAILED ' + a.status); process.exit(1); }
  const T = j.AccessToken;
  const H = { 'X-Emby-Token': T };
  const get = async (url) => fetch(C.baseUrl + url, { headers: H });

  let indexed = 0;
  for (const f of FIX) {
    const r = await get('/Items?Recursive=true&IncludeItemTypes=Book&SearchTerm=' + encodeURIComponent(f.name));
    const items = (await r.json().catch(() => ({}))).Items || [];
    const it = items.find(i => i.Name === f.name);
    if (!it) { console.log(pad(f.ext) + pad(f.name) + 'NOT INDEXED'); continue; }
    indexed++;
    const id = it.Id;
    const info   = await (await get('/A11yBookReader/info/' + id)).json().catch(() => ({}));
    const spine  = await (await get('/A11yBookReader/spine/' + id)).json().catch(() => ([]));
    const nav    = await (await get('/A11yBookReader/nav/' + id)).json().catch(() => ({}));
    const sr     = await (await get('/A11yBookReader/search/' + id + '?q=' + encodeURIComponent(f.term))).json().catch(() => ({}));
    const spineN = Array.isArray(spine) ? spine.length : (spine.Spine ? spine.Spine.length : 0);
    const tocN   = (nav.Toc || nav.toc || []).length;
    const hits   = sr.Total || sr.total || 0;
    const fmt    = info.Format || info.format || '?';
    // Pull every chapter and union the HTML so we catch structures (tables,
    // lists) that live past chapter 0.
    let all = '';
    for (let ci = 0; ci < spineN; ci++) {
      all += await (await get('/A11yBookReader/chapter/' + id + '/' + ci + '?api_key=' + T)).text().catch(() => '');
    }
    const ok = spineN === f.wantSpine && hits >= 1;
    const marks = [];
    if (/<th scope="col">/.test(all)) marks.push('th-scope');
    if (/<ul>/.test(all)) marks.push('ul');
    if (/<em>|<strong>/.test(all)) marks.push('em');
    if (/<h1>Slide /.test(all)) marks.push('slide-h1');
    if (/<blockquote>/.test(all)) marks.push('blockquote');
    console.log(pad(f.ext) + pad(f.name) +
      (ok ? 'OK  ' : 'CHK ') +
      'fmt=' + pad(fmt, 6) + 'spine=' + spineN + '/' + f.wantSpine +
      ' toc=' + tocN + ' hits=' + hits +
      ' lang=' + (/<html lang="([^"]*)"/.exec(all) || [, '?'])[1] +
      ' [' + marks.join(',') + ']');
  }
  console.log('\nindexed ' + indexed + '/' + FIX.length);
}
function pad(s, n = 26) { s = String(s); return s.length >= n ? s + ' ' : s + ' '.repeat(n - s.length); }
main();
