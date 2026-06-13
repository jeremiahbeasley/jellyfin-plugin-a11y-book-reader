# A11y Book Reader

An accessible, in-browser book reader plugin for Jellyfin, built for WCAG 2.2 A/AA: full keyboard and TV-remote operability, screen-reader semantics with aria-live announcements, careful focus management, and offline text-to-speech. It opens a wide range of book and document formats through one consistent reading surface — so navigation, search, bookmarks, highlights, display settings, and TTS work the same no matter the file type.

## Supported formats

Every format below flows through the same reading surface (chapters, table of contents, full-text search, bookmarks, highlights, and TTS):

| Family | Formats | Notes |
|--------|---------|-------|
| EPUB | `.epub` | Full reflow, embedded nav/landmarks, images |
| PDF | `.pdf` | Reflowed reading from the tagged/marked-content layer **and** a pixel-faithful Original-layout mode (PDF.js); page list + go-to-page |
| DAISY | `.zip` (DAISY 2.02 & DAISY 3 / DTBook) | NCX/NCC table of contents, page list |
| Plain text | `.txt`, `.md`, `.markdown`, `.html`, `.htm`, `.xml` | Headings detected into chapters; HTML sanitized |
| Documents | `.fb2`, `.odt`, `.fodt`, `.odp`, `.fodp`, `.docx`, `.docm`, `.pptx`, `.pptm`, `.rtf` | Text views with accessible tables (`th scope`), lists, and heading structure; presentations become one chapter per slide |
| Legacy Office | `.doc`, `.ppt` | Word/PowerPoint 97–2003, converted in-memory to OOXML (text views) |

**Deliberately not supported:** comic archives (`.cbz/.cbr/.cb7/.cbt`) — image-only with no text layer, so nothing for TTS or Braille to read — and DRM-protected files, which open with a clear message rather than failing silently.

## Reading experience

- **View modes** — paged and continuous-scroll for reflowable books, one-chapter-at-a-time, and Original-layout for PDFs; reader-owned arrow keys, plus tap zones, swipe, and on-screen buttons for every gesture.
- **Text-to-speech** — server-side [Piper](https://github.com/rhasspy/piper) neural TTS, fully offline (voices download into the plugin's own folder), with streaming playback, synced word highlighting, and a browser/TV speech fallback.
- **Navigation** — table of contents (synthesized from headings when a book lacks one), landmarks, print page list, go-to page/percent/chapter, in-book full-text search with context snippets and match counts, footnote popovers, and in-reader internal links with a back button.
- **Annotations** — bookmarks with a ribbon progress indicator, text highlights, and notes (W3C Web Annotation model), all per-user.
- **Display settings** — font picker including bundled OpenDyslexic (SIL OFL); size, line/letter/word/paragraph spacing, margins, and alignment; light/dark/sepia/high-contrast themes plus custom colors with a live WCAG contrast readout. Settings follow the user across devices.
- **Per-user reading position** — resume any book where you left off, on any device (Readium-style locators); TTS resumes from the paragraph it was reading.
- **Reading-time estimates** — each book reports an estimated reading time.
- **Immersive mode** — distraction-free reading with an always-reachable exit; reading ruler; reduced motion honored (OS preference and in-app toggle).

## Accessibility

- WCAG 2.2 AA throughout — keyboard-first, TV-remote (d-pad) operable end to end, screen-reader semantics with live announcements, visible focus, no dimmed text.
- Native **Play** on a book opens the accessible reader (with a Continue Reading resume row); unsupported items pass through to Jellyfin's native handling.

## Self-contained

The plugin bundles everything it needs and depends on **no host-system packages**. Parser dependencies ship as managed DLLs alongside the plugin (PdfPig for PDF, RtfPipe for RTF, b2xtranslator for legacy `.doc`/`.ppt`), PDF.js and the reader UI are embedded web assets, and Piper voices download into the plugin's own folder at runtime. This keeps the plugin portable across any Jellyfin host.

## Dependencies

| Plugin | Why | Where |
|--------|-----|-------|
| **File Transformation** | Required — injects the reader UI into the Jellyfin web client. | https://github.com/IAmParadox27/jellyfin-plugin-file-transformation |

## Install

1. Install the [File Transformation](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation) plugin.
2. Extract the release into a `plugins/A11y Book Reader` folder — this includes `Jellyfin.Plugin.A11yBookReader.dll`, its bundled dependency DLLs (PdfPig, RtfPipe, b2xtranslator), the web assets, and `meta.json`.
3. Restart Jellyfin.

Piper TTS voices are downloaded on demand from the plugin's settings page into the plugin folder.

## Build

```
dotnet publish --configuration Release --output bin -p:NuGetAudit=false
```

Targets .NET 9 / Jellyfin 10.11.x. The legacy-Office converters under `lib/b2xtranslator/` are built from source (the upstream nuget ships only the shared infrastructure, not the `.doc`/`.ppt` parsers) and vendored — see that folder's contents and the `Reference` entries in the csproj.

See `STANDARDS.md` for the standards this project follows (Readium locators, W3C Web Annotations, EPUB 3 nav, WCAG 2.2) and its deliberate deviations.
