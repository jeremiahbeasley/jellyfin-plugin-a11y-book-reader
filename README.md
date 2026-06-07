# A11y Book Reader

An accessible EPUB reader plugin for Jellyfin, built for WCAG 2.2 A/AA: full keyboard and TV-remote operability, screen-reader semantics with aria-live announcements, focus management, and text-to-speech.

## Features

- In-browser EPUB reading with chapter navigation (reader-owned arrow keys)
- Per-user reading position persistence — resume any book where you left off, on any device
- Text-to-speech: server-side [Piper](https://github.com/rhasspy/piper) neural TTS with streaming playback and voice management, with browser/TV speech fallback
- Read button injected on book detail pages

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
