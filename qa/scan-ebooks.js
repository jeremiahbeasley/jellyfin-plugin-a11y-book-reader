// Triggers a targeted refresh of the eBooks library so newly added fixture
// files index as Book items. Credentials come from the gitignored
// config.local.js — never passed on the command line. Run: node scan-ebooks.js
const C = require('./config.local');

(async () => {
  const authHdr = 'MediaBrowser Client="qa", Device="qa", DeviceId="qa-scan", Version="1"';
  const auth = await fetch(C.baseUrl + '/Users/AuthenticateByName', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Emby-Authorization': authHdr },
    body: JSON.stringify({ Username: C.user, Pw: C.pass }),
  });
  const j = await auth.json().catch(() => ({}));
  if (!j.AccessToken) {
    console.error('AUTH FAILED (HTTP ' + auth.status + ')');
    process.exit(1);
  }
  console.log('auth OK');

  const lib = C.libraries.ebooks;
  const ref = await fetch(
    C.baseUrl + '/Items/' + lib + '/Refresh' +
      '?Recursive=true&MetadataRefreshMode=Default&ImageRefreshMode=Default&ReplaceAllMetadata=false',
    { method: 'POST', headers: { 'X-Emby-Token': j.AccessToken } });
  console.log('eBooks refresh HTTP ' + ref.status + (ref.status === 204 ? ' (scan started)' : ''));
})();
