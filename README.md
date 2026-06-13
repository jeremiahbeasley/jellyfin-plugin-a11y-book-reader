# A11y Book Reader

**Read any book or document in Jellyfin — comfortably, by keyboard, by remote, or by ear.**

A11y Book Reader turns Jellyfin into a genuinely accessible reading app. Open a book and you get one consistent reading surface — the same navigation, search, bookmarks, highlights, display controls, and text-to-speech — no matter whether the file is an EPUB, a PDF, a Word document, a DAISY talking book, or a Braille file. It's built to WCAG 2.2 A/AA from the ground up, so it works for people who read with their eyes, their ears, a screen reader, or a TV remote.

---

## Why you'll want it

- **Every book reads the same way.** Learn the controls once and they work across every supported format — no relearning per file type.
- **Listen, don't just look.** Built-in neural text-to-speech reads aloud with the words highlighted as they're spoken, and picks up exactly where you left off — even on a different device.
- **Read the way that's comfortable for you.** Your font (OpenDyslexic included), size, spacing, margins, colors, and theme — with a live contrast check so you know it's readable — and your choices follow you everywhere.
- **Never lose your place.** Resume any book at the paragraph you stopped on, on any device, with a Continue Reading row right on the Jellyfin home screen.
- **Works on the couch.** Fully operable with a TV remote's d-pad, not just a mouse or touchscreen.
- **Nothing to install on the server.** One self-contained plugin — no system packages, no companion plugins.

---

## Supported formats

Open a book and it just works. Chapters, table of contents, full-text search, bookmarks, highlights, and read-aloud are available for **every** format below:

| You have… | Files | What you get |
|-----------|-------|--------------|
| **E-books** | `.epub` | Full reflow with the book's own navigation, landmarks, and images |
| **PDFs** | `.pdf` | Reflowed, reads-aloud text from the document's tagged layer **plus** a pixel-faithful "original layout" view; jump to any page |
| **Talking books** | DAISY 2.02 & DAISY 3 / DTBook (`.zip`) | The book's real chapter and page structure, preserved |
| **Plain text & web** | `.txt`, `.md`, `.markdown`, `.html`, `.htm`, `.xml` | Headings become chapters automatically; HTML is sanitized for safe reading |
| **Documents & slides** | `.fb2`, `.odt`, `.fodt`, `.odp`, `.fodp`, `.docx`, `.docm`, `.pptx`, `.pptm`, `.rtf` | Clean text with accessible tables, lists, and headings; each slide becomes a chapter |
| **Legacy Office** | `.doc`, `.ppt` | Word/PowerPoint 97–2003, opened and read like any modern document |
| **Braille** | `.brf`, `.brl` | Shown as real Braille cells with a one-tap switch to print; read aloud via accurate UEB back-translation |

**Not supported, on purpose:** comic archives (`.cbz/.cbr/.cb7/.cbt`) are images with no text to read aloud or translate to Braille, and DRM-locked files open with a clear explanation instead of failing silently.

---

## Reading experience

- **Choose how it flows** — paged or continuous-scroll for reflowable books, and a true original-layout mode for PDFs. Arrow keys, tap zones, swipe, and on-screen buttons all do the same thing.
- **Find and jump anywhere** — table of contents (built automatically from headings when a book doesn't ship one), landmarks, a print page list, go-to page/percent/chapter, and full-text search with context snippets and match counts. Footnotes open in place; internal links have a back button.
- **Mark it up** — bookmarks with a progress ribbon, text highlights, and notes, saved per user using the W3C Web Annotation model.
- **Make it yours** — font, size, line/letter/word/paragraph spacing, margins, alignment; light/dark/sepia/high-contrast themes or your own colors with a live WCAG contrast readout. Settings sync across your devices.
- **Stay in the flow** — distraction-free immersive mode with an always-reachable exit, a reading ruler, reduced-motion support, and an estimated reading time for every book.

---

## Accessibility

This isn't accessibility bolted on — it's the point of the plugin.

- **WCAG 2.2 AA throughout:** keyboard-first and TV-remote (d-pad) operable end to end, screen-reader semantics with live announcements, visible focus, and no dimmed/low-contrast text.
- Pressing **Play** on a book opens the accessible reader and adds it to your Continue Reading row; items the reader can't open pass straight through to Jellyfin's normal handling.

---

## Install

The plugin is **fully self-contained** — a single DLL with everything embedded. There's no companion plugin to install and nothing to add to the server itself.

### Option A — from the JB11 repository (recommended)

1. In Jellyfin, go to **Dashboard → Plugins → Repositories** and add:
   `https://raw.githubusercontent.com/jeremiahbeasley/jb11-jellyfin-repository/main/manifest.json`
2. Open **Catalog**, find **A11y Book Reader**, and click **Install**.
3. **Restart Jellyfin.** Open any book and press Play.

Updates then show up in the plugin catalog like any other plugin.

### Option B — manual

1. Download `A11yBookReader_<version>.zip` from the [latest release](https://github.com/jeremiahbeasley/jellyfin-plugin-a11y-book-reader/releases/latest).
2. Extract it into a `plugins/A11y Book Reader` folder inside your Jellyfin data directory — it contains `Jellyfin.Plugin.A11yBookReader.dll` and `meta.json`.
3. **Restart Jellyfin.**

Requires Jellyfin **10.11.10** or newer.

---

## Setting up read-aloud (Piper text-to-speech)

The reader can speak using [Piper](https://github.com/rhasspy/piper), a high-quality **neural** TTS engine that runs **entirely on your server** — no cloud, no account, no data leaving your network. Because synthesis happens server-side, even low-powered clients and TVs get natural read-aloud with the words highlighted in time.

Piper is set up **once, by an administrator**, from the plugin's configuration page — after that, every user can use it.

**Admin setup (Dashboard → Plugins → A11y Book Reader):**

1. Under **Piper TTS**, click **Download & Install Piper**. This downloads and installs the Piper engine onto the server (into the plugin's own folder — nothing is installed system-wide).
2. Once Piper is installed, the **Voice Library** appears. Filter by language or name, preview voices with the sample button, and click **Download** on the voices you want. Voices come in low/medium/high quality — *medium* is a great default; *high* sounds best on a capable server. Download as many as you like.

**Then, for everyone:**

- In the reader, open the voice menu and pick any installed Piper voice — they appear alongside the browser's/TV's built-in voices. Adjust **speed** from the reader; the word-highlighting stays in sync with the audio.
- **Fully offline once installed.** The engine and voices live in `plugins/A11y Book Reader/` and run locally from then on.
- **Haven't installed Piper yet?** Read-aloud still works out of the box using the browser's or TV's built-in speech — Piper just makes it sound better.

---

## Self-contained by design

A11y Book Reader depends on **no host-system packages and no other plugins**. Everything it needs is inside the one DLL: the PDF, RTF, and legacy-Office parsers are merged in, the reader UI and PDF.js are embedded web assets, the Braille back-translator (liblouis) is compiled in, and the reader injects itself into the web client through its own middleware. The only things fetched after install are the Piper engine and the voices an administrator chooses on the config page, which land in the plugin's own folder. That keeps it portable across any Jellyfin host.

---

## Build from source

```
dotnet build --configuration Release -p:DoMerge=true
```

Targets **.NET 9 / Jellyfin 10.11.x**. The `-p:DoMerge=true` switch merges the managed parser dependencies (PdfPig, RtfPipe, b2xtranslator) into the plugin DLL for a single self-contained artifact. The legacy-Office converters under `lib/b2xtranslator/` are built from source and vendored (the upstream NuGet ships only shared infrastructure, not the `.doc`/`.ppt` parsers).

See `STANDARDS.md` for the standards this project follows (Readium locators, W3C Web Annotations, EPUB 3 nav, WCAG 2.2) and its deliberate deviations.
