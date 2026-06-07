# Standards & Conventions

This project is intended to grow into a full ebook **and** audiobook player
supporting many formats (EPUB first). To avoid reinventing solved problems and
to keep user data portable, features must follow the standards below. Check
this file before designing any new subsystem; record new adoptions and
deliberate deviations here.

## Adopted

### Reading position / progress — Readium Locator model
- Spec: https://readium.org/architecture/models/locators/
- Implemented: v1.0.0.12 (`Models/Locator.cs`, `Services/ProgressService.cs`)
- Shape: `{ href, locations: { chapter, progression, totalProgression, position }, text: { before, highlight, after }, updated }`
- Resolution order on restore: structural `position` → verified/searched text
  quote → `progression` fallback. The text quote survives layout, edition, and
  rendering-engine changes; locators are format-agnostic (audio uses
  time-based `locations`), which is what makes multi-format support possible
  without data migration.
- Deviation (deliberate): `position` is a block-element index, not a full EPUB
  CFI. CFI generation may replace it later; the quote fallback makes the
  fragment form swappable.

### Accessibility — WCAG 2.2 A/AA
- Spec: https://www.w3.org/TR/WCAG22/
- Whole-UI requirement, all platforms (web, TV/remote, mobile). Notables in
  use: 2.5.8 target size, 1.4.11 non-text contrast, 2.5.3 label-in-name,
  4.1.2 name/role/value, focus visible everywhere, `prefers-reduced-motion`
  honored alongside an in-app toggle (planned, Phase 2).

## Planned (do NOT build private versions of these)

### Annotations (Phase 6) — W3C Web Annotation Data Model
- Spec: https://www.w3.org/TR/annotation-model/
- Highlights/notes/bookmarks stored as annotations with
  `TextQuoteSelector` + `TextPositionSelector`; exportable JSON.

### TTS word/sentence sync (Phase 5)
- Books that ship narration sync: EPUB 3 Media Overlays (SMIL)
  https://www.w3.org/TR/epub-33/#sec-media-overlays
- Generated TTS: real word timings from the engine (verify Piper alignment
  output before building), not estimated durations. SSML marks where
  applicable.

### Navigation (Phase 3) — EPUB 3 Navigation Document
- Spec: https://www.w3.org/TR/epub-33/#sec-nav
- TOC from `nav.xhtml` (NCX fallback), `landmarks`, `page-list` for real
  print page numbers.

### Audiobooks (future)
- Time-based Readium locators for position.
- Decide deliberately whether/how to sync progress with Audiobookshelf's API
  (already deployed on CT112) rather than creating a second source of truth.

## Deliberate non-adoptions

### Rendering engine — custom, not epub.js/Readium Web
- Reasons: full control of WCAG/TV-remote behavior in our own small DOM;
  reuses the existing server-side C# EPUB parsing; engine is swappable later
  *because* all stored state uses standard locator shapes (the data model is
  the lock-in risk, not the renderer).
- Revisit if: pagination complexity grows past what CSS columns handle, or
  fixed-layout EPUB support is needed.

## Rules

1. Before building a feature, check whether a standard exists; prefer it.
2. Store user data ONLY in standard shapes — renderers may change, data must not.
3. Record every adoption, plan, and deviation in this file, with the reason.
