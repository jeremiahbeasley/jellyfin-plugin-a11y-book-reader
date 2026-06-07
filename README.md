# A11y Book Reader

An accessible EPUB reader plugin for Jellyfin, built for WCAG 2.2 A/AA: full keyboard and TV-remote operability, screen-reader semantics with aria-live announcements, focus management, and text-to-speech.

## Features

- In-browser EPUB reading with paged and continuous-scroll modes (reader-owned arrow keys; tap zones, swipe, and buttons for every gesture)
- Per-user reading position persistence (Readium-style locators) — resume any book where you left off, on any device; TTS resumes from the paragraph it was reading
- Display settings ("colophon"): font picker incl. bundled OpenDyslexic (SIL OFL), size/line/letter/word/paragraph spacing, margins, alignment, light/dark/sepia/high-contrast themes plus custom colors with a live WCAG contrast readout — settings follow the user across devices
- Book map: table of contents (synthesized from section headings when a book lacks one), landmarks, print page list, and go-to-page/percent/chapter; footnote popovers with a return-to-position button; internal links navigate in-reader with a back button
- In-book full-text search with context snippets, match counts, and jump-to-result (announced to screen readers)
- Bookmark-ribbon progress indicator, reading ruler, and a distraction-free immersive mode with an always-reachable exit
- Text-to-speech: server-side [Piper](https://github.com/rhasspy/piper) neural TTS with streaming playback, synced word highlight in both view modes, and browser/TV speech fallback
- WCAG 2.2 AA throughout — keyboard, TV-remote, and screen-reader first; no dimmed text; reduced motion honored (OS preference and in-app toggle)
- Read button injected on book detail pages

See `STANDARDS.md` for the standards this project follows (Readium locators, W3C Web Annotations, EPUB 3 nav, WCAG 2.2) and its deliberate deviations.

## Dependencies

| Plugin | Why | Where |
|--------|-----|-------|
| **File Transformation** | Required — injects the reader UI into the Jellyfin web client. Without it the Read button never appears. | https://github.com/IAmParadox27/jellyfin-plugin-file-transformation |

## Install

1. Install the [File Transformation](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation) plugin.
2. Drop `Jellyfin.Plugin.A11yBookReader.dll` (from [Releases](../../releases)) into a `plugins/A11y Book Reader` folder.
3. Restart Jellyfin.

Deploy the plugin DLL only — no dependency DLLs alongside it.

## Build

```
dotnet publish --configuration Release --output bin -p:NuGetAudit=false
```

Targets .NET 9 / Jellyfin 10.11.x.
