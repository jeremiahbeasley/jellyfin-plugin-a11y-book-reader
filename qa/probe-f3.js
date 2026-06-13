// F3a braille probe (API-only): the .brf fixture indexes, reports the braille
// format, paginates on the form-feed, and renders Unicode braille glyphs.
const C = require('./config.local');
const NAME = 'Braille Sample';

(async () => {
  const a = await fetch(C.baseUrl + '/Users/AuthenticateByName', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Emby-Authorization': 'MediaBrowser Client="q", Device="q", DeviceId="qa-f3", Version="1"' },
    body: JSON.stringify({ Username: C.user, Pw: C.pass }),
  });
  const j = await a.json().catch(() => ({}));
  if (!j.AccessToken) { console.error('AUTH FAILED ' + a.status); process.exit(1); }
  const T = j.AccessToken;
  const g = (u) => fetch(C.baseUrl + u, { headers: { 'X-Emby-Token': T } });

  const r = await g('/Items?Recursive=true&IncludeItemTypes=Book&SearchTerm=' + encodeURIComponent(NAME));
  const it = ((await r.json().catch(() => ({}))).Items || []).find(i => i.Name === NAME);
  if (!it) { console.log('NOT INDEXED'); return; }
  const info  = await (await g('/A11yBookReader/info/' + it.Id)).json().catch(() => ({}));
  const spine = await (await g('/A11yBookReader/spine/' + it.Id)).json().catch(() => ([]));
  const nav   = await (await g('/A11yBookReader/nav/' + it.Id)).json().catch(() => ({}));
  const ch0   = await (await g('/A11yBookReader/chapter/' + it.Id + '/0?api_key=' + T)).text().catch(() => '');

  const fox = '⠋⠕⠭'; // FOX in braille
  console.log('format=' + (info.Format || '?'));
  console.log('spine=' + (spine.length || 0) + ' (want 2)');
  console.log('toc=' + ((nav.Toc || []).length));
  console.log('chapter0 has <pre class=braille>: ' + /<pre class="braille"/.test(ch0));
  console.log('chapter0 has FOX glyphs (⠋⠕⠭): ' + ch0.includes(fox));
  console.log('chapter0 has aria-label page: ' + /aria-label="Braille page/.test(ch0));
  const glyphs = (ch0.match(/[⠀-⠿]/g) || []).length;
  console.log('braille glyph count in chapter0: ' + glyphs);
})();
