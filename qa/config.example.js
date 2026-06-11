// Copy this file to `config.local.js` and fill in your own values.
// config.local.js is gitignored — NEVER commit real credentials.
//
// Every field can also be supplied via an environment variable (env wins),
// so CI can run the harness without a local file.

module.exports = {
  // Base URL of the Jellyfin server to test against.
  baseUrl: process.env.JF_URL || 'http://YOUR-JELLYFIN-HOST:8096',

  // A Jellyfin user that can open books. Used to log into the real web app.
  user:    process.env.JF_USER || 'your-username',
  pass:    process.env.JF_PASS || 'your-password',

  // Path to a Chromium/Chrome executable. The harness uses the system browser
  // (no bundled download) — point this at yours.
  chromiumPath: process.env.JF_CHROMIUM || '/usr/bin/chromium',

  // Book item IDs to exercise. Get them from the Jellyfin item URLs, or:
  //   GET /Items?IncludeItemTypes=Book&Recursive=true&Fields=Path
  books: {
    // Primary EPUB used by most suites (pick one with real prose chapters).
    primary: 'EPUB_ITEM_ID',
    // A spread of EPUBs with different structures (TOC / no-TOC / footnotes).
    epubs: ['EPUB_ITEM_ID_1', 'EPUB_ITEM_ID_2', 'EPUB_ITEM_ID_3'],
    // A non-EPUB book (e.g. .mobi) — should fail to open gracefully.
    nonEpub: 'MOBI_ITEM_ID',
  },
};
