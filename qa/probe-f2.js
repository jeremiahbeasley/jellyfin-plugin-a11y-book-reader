// F2 legacy-Office probe (API-only): .doc and .ppt convert via b2xtranslator
// then read through the F1 docx/pptx parsers. Reports actuals so we can write
// real assertions. Creds from config.local.js.
const C = require('./config.local');

const FIX = [
  { name: 'Word Legacy Sample',       ext: '.doc', term: 'underline' },
  { name: 'PowerPoint Legacy Sample', ext: '.ppt', term: 'box' },
];

async function main() {
  const authHdr = 'MediaBrowser Client="qa", Device="qa", DeviceId="qa-f2", Version="1"';
  const a = await fetch(C.baseUrl + '/Users/AuthenticateByName', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Emby-Authorization': authHdr },
    body: JSON.stringify({ Username: C.user, Pw: C.pass }),
  });
  const j = await a.json().catch(() => ({}));
  if (!j.AccessToken) { console.error('AUTH FAILED ' + a.status); process.exit(1); }
  const T = j.AccessToken;
  const get = (url) => fetch(C.baseUrl + url, { headers: { 'X-Emby-Token': T } });

  for (const f of FIX) {
    const r = await get('/Items?Recursive=true&IncludeItemTypes=Book&SearchTerm=' + encodeURIComponent(f.name));
    const items = (await r.json().catch(() => ({}))).Items || [];
    const it = items.find(i => i.Name === f.name);
    if (!it) { console.log(f.ext + '  ' + f.name + '  -> NOT INDEXED'); continue; }
    const id = it.Id;
    const info  = await (await get('/A11yBookReader/info/' + id)).json().catch(() => ({}));
    const spine = await (await get('/A11yBookReader/spine/' + id)).json().catch(() => ([]));
    const nav   = await (await get('/A11yBookReader/nav/' + id)).json().catch(() => ({}));
    const sr    = await (await get('/A11yBookReader/search/' + id + '?q=' + encodeURIComponent(f.term))).json().catch(() => ({}));
    const spineN = Array.isArray(spine) ? spine.length : 0;
    let all = '';
    for (let ci = 0; ci < spineN; ci++)
      all += await (await get('/A11yBookReader/chapter/' + id + '/' + ci + '?api_key=' + T)).text().catch(() => '');
    const marks = [];
    if (/<th scope="col">/.test(all)) marks.push('th-scope');
    if (/<ul>/.test(all)) marks.push('ul');
    if (/<h[1-6]>/.test(all)) marks.push('heading');
    if (/<p>/.test(all)) marks.push('p');
    console.log(f.ext + '  ' + f.name + '  -> OK  fmt=' + (info.Format || '?') +
      ' spine=' + spineN + ' toc=' + ((nav.Toc || []).length) +
      ' hits(' + f.term + ')=' + (sr.Total || 0) + ' [' + marks.join(',') + ']' +
      ' textlen=' + all.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length);
  }
}
main();
