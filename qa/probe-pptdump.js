// One-off: dump the rendered chapter HTML for a named book, to inspect parser output.
const C = require('./config.local');
const NAME = process.argv[2] || 'PowerPoint Legacy Sample';
(async () => {
  const a = await fetch(C.baseUrl + '/Users/AuthenticateByName', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Emby-Authorization': 'MediaBrowser Client="q", Device="q", DeviceId="q", Version="1"' },
    body: JSON.stringify({ Username: C.user, Pw: C.pass }),
  });
  const T = (await a.json()).AccessToken;
  const g = (u) => fetch(C.baseUrl + u, { headers: { 'X-Emby-Token': T } });
  const items = (await (await g('/Items?Recursive=true&IncludeItemTypes=Book&SearchTerm=' + encodeURIComponent(NAME))).json()).Items || [];
  const it = items.find(i => i.Name === NAME);
  if (!it) { console.log('not indexed'); return; }
  const spine = await (await g('/A11yBookReader/spine/' + it.Id)).json();
  console.log('spine=' + (spine.length || 0));
  for (let i = 0; i < (spine.length || 0); i++) {
    const html = await (await g('/A11yBookReader/chapter/' + it.Id + '/' + i + '?api_key=' + T)).text();
    console.log('--- chapter ' + i + ' ---');
    console.log(html.replace(/^[\s\S]*?<body>/, '').replace(/<\/body>[\s\S]*$/, '').slice(0, 700));
  }
})();
