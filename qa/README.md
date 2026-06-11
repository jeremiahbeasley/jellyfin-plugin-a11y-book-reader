# A11y Book Reader — QA Harness

Automated regression testing for the plugin, run against a **live Jellyfin
server** in headless Chromium. It logs into the real web app, opens books the
way a user does (the reader injects its own **Read** button), and exercises the
reader — so it tests the real `ApiClient`, real endpoints, and real book data,
not a mock.

What it covers:

| Suite | Checks |
|-------|--------|
| `functional` | open via UI, paged/scroll toggle, all panels (one-open-at-a-time), TOC, chapter nav, search, go-to + back, immersive + Escape, resume/persistence |
| `accessibility` | axe-core (WCAG 2.0/2.1/2.2 **A + AA**) over the reader chrome in every panel state |
| `responsive` | reflow + target-size (1.4.10 / 2.5.8) at 320 / 360 / 768 / 1280 px |
| `tts` | Piper play + timing manifest (spans); speed change and voice change each re-stream; stop |
| `multibook` | several EPUBs (real / synthesized TOC) + a non-EPUB that must fail gracefully |
| `scroll-follow` | TTS auto-scroll moves by paragraph only (guards the v1.0.0.39 fix) |

## Setup (once)

```sh
cd qa
npm install                       # axe-core (+ puppeteer if not already global)
cp config.example.js config.local.js
$EDITOR config.local.js           # set baseUrl, user, pass, chromiumPath, book IDs
```

`config.local.js` is **gitignored** — it holds credentials and must never be
committed. Any field can also come from an env var (`JF_URL`, `JF_USER`,
`JF_PASS`, `JF_CHROMIUM`), which take precedence.

The harness uses your **system** Chromium (no bundled download). Set
`chromiumPath` (default `/usr/bin/chromium`). If `npm install` of puppeteer
tries to download a browser, set `PUPPETEER_SKIP_DOWNLOAD=1`.

Finding book IDs:

```sh
curl -s -H 'X-Emby-Token: <token>' \
  "<baseUrl>/Items?IncludeItemTypes=Book&Recursive=true&Fields=Path" | jq '.Items[]|{Name,Id,Path}'
```

## Run

```sh
npm run qa            # everything, one summary, non-zero exit on any failure
npm run functional    # a single suite
npm run a11y
npm run responsive
npm run tts
npm run multibook
npm run scroll
```

## Scope note

These suites test the **reader's own UI**. The plugin must never restyle or
override Jellyfin's own DOM/classes (it would break on other installs), so
anything outside `#abr-overlay` / the injected `#abr-read-btn` is intentionally
out of scope.

## Gotcha worth remembering

`axe-cli`'s bundled `axe-core` is old (3.2.x) and cannot parse Chromium's
modern `color(srgb …)` serialization — it emits false contrast failures with
`NaN` backgrounds. This harness pins **axe-core ≥ 4.10**. If you see a wall of
`color-contrast` violations, check the axe-core version before trusting them.
