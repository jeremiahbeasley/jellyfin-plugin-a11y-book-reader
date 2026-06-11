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

// Open a book the way a user does: detail page -> injected Read button -> reader.
// Pass a fresh page (browser.newPage()) for clean per-book isolation; it shares
// the authenticated localStorage with the login page.
async function openBookViaUI(page, itemId) {
  await page.goto(cfg.baseUrl + '/web/#/details?id=' + itemId,
    { waitUntil: 'networkidle2', timeout: 45000 }).catch(() => {});
  const btn = await page.waitForSelector('#abr-read-btn', { timeout: 25000, visible: true })
    .catch(() => null);
  if (!btn) return { readButton: false, overlay: false };
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
  return await page.evaluate(async (min) => {
    const R = window.a11yBookReader, n = R._spine.length;
    for (let i = 0; i < n; i++) {
      await new Promise(res => { R._loadChapter(i); setTimeout(res, 800); });
      const f = document.getElementById('abr-frame'); let t = '';
      try { t = f.contentDocument.body.textContent.trim(); } catch (e) {}
      if (t.length > min) return { chapter: i, chars: t.length };
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
