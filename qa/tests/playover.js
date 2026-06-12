// Play-takeover regression: Book items open in OUR reader through the
// NATIVE play controls (detail Play button + card hover play), playback is
// reported so books land on the resume rows, unsupported book-library items
// (mobi/audiobooks/comics) pass through to the native handler, and the
// runtime provider gives books a reading-time estimate.
const H = require('../lib/harness');
const { runMain } = require('../lib/report');

async function run() {
  const R = [], log = (n, p, d) => R.push({ name: n, pass: p, detail: d || '' });
  const { browser, page, errs } = await H.login({ width: 1280, height: 900 });
  try {
    // 1. native detail Play button opens OUR reader (openBookViaUI clicks it)
    const r = await H.openBookViaUI(page, H.cfg.books.pdf);
    log('detail Play opens the plugin reader', r.overlay === true, JSON.stringify(r));
    await new Promise(res => setTimeout(res, 4000));

    // generate some progress, then close (reports PlaybackStopped)
    await page.evaluate(async () => {
      const A = window.a11yBookReader;
      if (A._viewMode === 'pdfview') {
        for (let i = 0; i < 30; i++) { await new Promise(r2 => setTimeout(r2, 1000)); if (A._pdfDoc) break; }
        await A._pdfRenderPage(80);
      } else {
        A._goToTarget(3, null);
      }
      await new Promise(r2 => setTimeout(r2, 1500));
    });
    await page.evaluate(() => document.getElementById('abr-close').click());
    await new Promise(res => setTimeout(res, 2500));

    // 2. playback was recorded: resume position set, item on the resume row
    const ud = await page.evaluate(async id => {
      const it = await ApiClient.getItem(ApiClient.getCurrentUserId(), id);
      const res = await ApiClient.ajax({
        url: ApiClient.getUrl('Items', {
          Recursive: true, IncludeItemTypes: 'Book', Filters: 'IsResumable',
          UserId: ApiClient.getCurrentUserId()
        }),
        type: 'GET', dataType: 'json'
      });
      return {
        posTicks: it.UserData ? it.UserData.PlaybackPositionTicks : null,
        runTicks: it.RunTimeTicks || 0,
        inResume: (res.Items || []).some(x => x.Id === id),
      };
    }, H.cfg.books.pdf);
    log('reading session set a resume position', ud.posTicks > 0, JSON.stringify(ud));
    log('book appears in the resumable list', ud.inResume === true, JSON.stringify(ud));

    // 3. runtime provider: refresh just the fixture, expect a real estimate
    await page.evaluate(async () => {
      const tasks = await ApiClient.ajax({ url: ApiClient.getUrl('ScheduledTasks'), type: 'GET', dataType: 'json' });
      const t = tasks.find(x => x.Key === 'Jellyfin.Plugin.A11yBookReader.BookRuntime');
      if (t) await ApiClient.ajax({ url: ApiClient.getUrl('ScheduledTasks/Running/' + t.Id), type: 'POST' });
    });
    let runTicks = 0;
    for (let i = 0; i < 40; i++) {
      await new Promise(res => setTimeout(res, 3000));
      runTicks = await page.evaluate(async id =>
        (await ApiClient.getItem(ApiClient.getCurrentUserId(), id)).RunTimeTicks || 0, H.cfg.books.pdf);
      if (runTicks > 600000000) break;
    }
    log('runtime estimate > 1 minute after task run (416-page PDF)', runTicks > 600000000,
        Math.round(runTicks / 600000000) + ' min');

    // 4. card hover play in the eBooks library opens OUR reader
    await page.goto(H.cfg.baseUrl + '/web/#/list?parentId=' + H.cfg.libraries.ebooks,
      { waitUntil: 'networkidle2', timeout: 45000 }).catch(() => {});
    let cardSel = null;
    for (let i = 0; i < 20; i++) {
      cardSel = await page.evaluate(pid => {
        const c = document.querySelector('.card[data-type="Book"][data-id="' + pid + '"]')
               || document.querySelector('.card[data-type="Book"]');
        return c ? c.getAttribute('data-id') : null;
      }, H.cfg.books.primary);
      if (cardSel) break;
      await new Promise(res => setTimeout(res, 1000));
    }
    if (!cardSel) {
      log('card play opens the plugin reader', false, 'no Book card rendered');
    } else {
      const pos = await page.evaluate(id => {
        const c = document.querySelector('.card[data-id="' + id + '"] .cardBox');
        const r2 = c.getBoundingClientRect();
        return { x: r2.x + r2.width / 2, y: r2.y + r2.height / 2 };
      }, cardSel);
      await page.mouse.move(pos.x, pos.y);
      await new Promise(res => setTimeout(res, 1200));
      await page.evaluate(id => {
        const c = document.querySelector('.card[data-id="' + id + '"]');
        const b = c.querySelector('.cardOverlayButton[data-action="resume"], .cardOverlayButton[data-action="play"]');
        if (b) b.click();
      }, cardSel);
      const overlay = await page.waitForSelector('#abr-overlay', { timeout: 20000 })
        .then(() => true).catch(() => false);
      log('card play opens the plugin reader', overlay === true, 'card ' + cardSel);
      if (overlay) {
        await page.evaluate(() => document.getElementById('abr-close').click());
        await new Promise(res => setTimeout(res, 1500));
      }
    }

    // 5. unsupported (mobi) passes through: our overlay must NOT open
    if (H.cfg.books.nonEpub) {
      const p2 = await browser.newPage();
      const r2 = await H.openBookViaUI(p2, H.cfg.books.nonEpub);
      log('unsupported book passes through to native handling', r2.overlay === false, JSON.stringify(r2));
      await p2.close();
    }

    // jellyfin-web raises "item or serverId cannot be null" during the COLD
    // page-load of a #/list URL — probe-verified as the web client's own
    // route restore, before any plugin code runs. Not ours; excluded.
    const ours = errs.filter(e => !/item or serverId cannot be null/.test(e));
    log('no reader JS errors', ours.length === 0, JSON.stringify(ours));
    return R;
  } finally { await browser.close(); }
}

module.exports = { run };
if (require.main === module) runMain(run, 'Play takeover');
