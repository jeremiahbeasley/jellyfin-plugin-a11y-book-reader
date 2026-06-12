// Shared headless-Chromium harness for the A11y Book Reader QA suites.
//
// Drives the REAL Jellyfin web app: logs in, opens a book's detail page, lets
// the reader inject its own Read button, clicks it, and exposes helpers for the
// tests. No stubbing — everything hits the live plugin endpoints.

const fs = require('fs');
const path = require('path');

// Resolve puppeteer whether installed locally (qa/node_modules) or globally.
let puppeteer;
try { puppeteer = require('puppeteer'); }
catch (e) { puppeteer = require('/usr/local/lib/node_modules/puppeteer'); }

// Modern axe-core (understands CSS color(srgb ...); the old axe-cli build does not).
let AXE_PATH;
try { AXE_PATH = require.resolve('axe-core/axe.min.js'); }
catch (e) { AXE_PATH = path.join(__dirname, '..', 'node_modules', 'axe-core', 'axe.min.js'); }
const AXE = fs.readFileSync(AXE_PATH, 'utf8');

// Load config: config.local.js if present, else config.example.js (env vars win in both).
let cfg;
try { cfg = require('../config.local.js'); }
catch (e) { cfg = require('../config.example.js'); }

const WCAG = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function launch(viewport) {
  const browser = await puppeteer.launch({
    executablePath: cfg.chromiumPath, headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox',
           '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
  const page = await browser.newPage();
  if (viewport) await page.setViewport(viewport);
  const errs = [];
  page.on('pageerror', e => errs.push(String(e.message || e).slice(0, 160)));
  return { browser, page, errs };
}

// Log into the real Jellyfin web app via its login form.
async function login(viewport) {
  const { browser, page, errs } = await launch(viewport);
  await page.goto(cfg.baseUrl + '/web/', { waitUntil: 'networkidle2', timeout: 45000 });
  await page.waitForSelector('#txtManualName', { timeout: 20000 });
  await page.type('#txtManualName', cfg.user);
  await page.type('#txtManualPassword', cfg.pass);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(x => /sign in/i.test(x.textContent));
    if (b) b.click();
  });
  await page.waitForFunction(
    () => !location.hash.includes('/login') || !document.getElementById('txtManualName'),
    { timeout: 30000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 2500));
  return { browser, page, errs };
}

// Open a book the way a user does: detail page -> native Play button (the
// plugin's Play takeover routes Book items into the reader). Pass a fresh
// page (browser.newPage()) for clean per-book isolation; it shares the
// authenticated localStorage with the login page.
async function openBookViaUI(page, itemId) {
  await page.goto(cfg.baseUrl + '/web/#/details?id=' + itemId,
    { waitUntil: 'networkidle2', timeout: 45000 }).catch(() => {});
  const btn = await page.waitForSelector('.itemDetailPage:not(.hide) .btnPlay', { timeout: 25000, visible: true })
    .catch(() => null);
  if (!btn) return { readButton: false, overlay: false };
  // The interceptor decides from the prefetched detail context — wait for it
  await page.waitForFunction(
    () => window.a11yBookReader && window.a11yBookReader._detailBook,
    { timeout: 15000 }).catch(() => {});
  await btn.click();
  const overlay = await page.waitForSelector('#abr-overlay', { timeout: 20000 })
    .then(() => true).catch(() => false);
  await page.waitForFunction(() => {
    const f = document.getElementById('abr-frame');
    try { return f && f.contentDocument && f.contentDocument.body; } catch (e) { return false; }
  }, { timeout: 20000 }).catch(() => {});
  return { readButton: true, overlay };
}

// Advance chapters until one has > minChars of text (skip cover/title pages).
async function gotoTextChapter(page, minChars) {
  // Judge chapters by the SERVER's chapter text (deterministic — the live
  // frame lags loads and lies during them), then navigate with _goToTarget
  // (scroll-safe; _loadChapter tears down the stitched scroll document) and
  // wait for ARRIVAL.
  return await page.evaluate(async (min) => {
    const A = window.a11yBookReader, n = A._spine.length;
    const token = ApiClient.accessToken();
    for (let i = 0; i < n; i++) {
      const html = await (await fetch(ApiClient.getUrl(
        'A11yBookReader/chapter/' + A._currentItemId + '/' + i, { api_key: token }))).text();
      const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (text.length > min) {
        A._goToTarget(i, null);
        for (let t = 0; t < 12 && A._chapterIndex !== i; t++) await new Promise(r => setTimeout(r, 400));
        await new Promise(r => setTimeout(r, 500));
        return { chapter: i, chars: text.length };
      }
    }
    return { chapter: -1, chars: 0 };
  }, minChars);
}

// Run axe over the plugin chrome only (exclude the book iframe — the book's own
// HTML is the publisher's responsibility, not the reader's).
async function axeChrome(page) {
  return await page.evaluate(async (tags) => {
    const r = await axe.run(
      { include: [['#abr-overlay']], exclude: [['#abr-frame']] },
      { runOnly: { type: 'tag', values: tags } });
    return r.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.length }));
  }, WCAG);
}

module.exports = { launch, login, openBookViaUI, gotoTextChapter, axeChrome, AXE, WCAG, cfg, puppeteer };
