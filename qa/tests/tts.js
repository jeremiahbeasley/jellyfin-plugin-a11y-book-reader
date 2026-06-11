// TTS regression: Piper play produces a real timing manifest (spans), and speed
// + voice changes each re-stream (speed is baked server-side, so a change must
// restart the stream, not poke playbackRate).
const H = require('../lib/harness');
const { runMain } = require('../lib/report');

async function run() {
  const R = [], log = (n, p, d) => R.push({ name: n, pass: p, detail: d || '' });
  const { browser, page, errs } = await H.login({ width: 1280, height: 900 });
  const streams = [];
  page.on('response', r => { if (r.url().includes('/tts/stream/')) streams.push(r.url().split('/tts/stream/')[1].split('?')[0].slice(0, 8)); });
  let voiceFetches = 0;
  page.on('response', r => { if (r.url().includes('/piper/voices')) voiceFetches++; });
  try {
    await H.openBookViaUI(page, H.cfg.books.primary);
    await H.gotoTextChapter(page, 300);
    // select a Piper voice (browser voices are absent in headless)
    await page.evaluate(() => { const s = document.getElementById('abr-voice-select'); const o = [...s.options].find(o => o.value.startsWith('piper:')); s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); });

    await page.evaluate(() => document.getElementById('abr-tts-toggle').click());
    // Piper synthesis can be slow under server load — poll for the stream
    // instead of a fixed wait (a fixed 5s once produced a false spans=0)
    for (let i = 0; i < 20 && streams.length === 0; i++) await new Promise(r => setTimeout(r, 1000));
    await new Promise(r => setTimeout(r, 2500));   // let the timing manifest attach
    const play = await page.evaluate(() => ({ audio: !!window.a11yBookReader._piperAudio, spans: (window.a11yBookReader._piperAudio || {}).abrSpans?.length || 0 }));
    log('Piper plays with timing manifest', play.audio && play.spans > 0, 'spans=' + play.spans);
    const afterPlay = streams.length;

    await page.evaluate(() => { const s = document.getElementById('abr-speed-select'); s.value = '1.5'; s.dispatchEvent(new Event('change', { bubbles: true })); });
    for (let i = 0; i < 15 && streams.length <= afterPlay; i++) await new Promise(r => setTimeout(r, 1000));
    log('speed change re-streams', streams.length > afterPlay, 'streams ' + afterPlay + ' -> ' + streams.length);

    // a short chapter can finish during the waits — restart playback if needed so
    // the voice-change check tests a live stream (a stopped reader correctly
    // skips the re-stream)
    if (!(await page.evaluate(() => !!window.a11yBookReader._ttsPlaying))) {
      await page.evaluate(() => document.getElementById('abr-tts-toggle').click());
      await new Promise(r => setTimeout(r, 4000));
    }
    const afterSpeed = streams.length;

    await page.evaluate(() => { const s = document.getElementById('abr-voice-select'); const o = [...s.options].filter(o => o.value.startsWith('piper:')); s.value = o[1].value; s.dispatchEvent(new Event('change', { bubbles: true })); });
    for (let i = 0; i < 15 && streams.length <= afterSpeed; i++) await new Promise(r => setTimeout(r, 1000));
    log('voice change re-streams', streams.length > afterSpeed, 'streams ' + afterSpeed + ' -> ' + streams.length);

    await page.evaluate(() => document.getElementById('abr-tts-stop').click());
    await new Promise(r => setTimeout(r, 500));
    log('stop ends playback', await page.evaluate(() => !window.a11yBookReader._ttsPlaying));

    log('piper/voices fetched once (not per retry)', voiceFetches <= 2, voiceFetches + ' fetches');
    log('no reader JS errors', errs.length === 0, JSON.stringify(errs.slice(0, 3)));
  } finally { await browser.close(); }
  return R;
}

module.exports = { run };
if (require.main === module) runMain(run, 'TTS');
