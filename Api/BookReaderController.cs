using Jellyfin.Plugin.A11yBookReader.Models;
using Jellyfin.Plugin.A11yBookReader.Services;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.A11yBookReader.Api;

[ApiController]
[Route("A11yBookReader")]
[Authorize]
public class BookReaderController : ControllerBase
{
    private readonly EpubService _epub;
    private readonly PiperService _piper;
    private readonly ProgressService _progress;
    private readonly SettingsService _settings;
    private readonly AnnotationService _annotations;
    private readonly TextFormatService _textFormats;
    private readonly DaisyFormatService _daisy;
    private readonly ILibraryManager _libraryManager;
    private readonly IUserManager _userManager;
    private readonly ILogger<BookReaderController> _logger;

    public BookReaderController(EpubService epub, PiperService piper, ProgressService progress, SettingsService settings, AnnotationService annotations, TextFormatService textFormats, DaisyFormatService daisy, ILibraryManager libraryManager, IUserManager userManager, ILogger<BookReaderController> logger)
    {
        _epub = epub;
        _piper = piper;
        _progress = progress;
        _settings = settings;
        _annotations = annotations;
        _textFormats = textFormats;
        _daisy = daisy;
        _libraryManager = libraryManager;
        _userManager = userManager;
        _logger = logger;
    }

    /// <summary>Current user's id from the Jellyfin auth claim; never trusted from the client.</summary>
    private Guid? GetUserId()
    {
        var claim = User.Claims.FirstOrDefault(c =>
            string.Equals(c.Type, "Jellyfin-UserId", StringComparison.OrdinalIgnoreCase));
        return Guid.TryParse(claim?.Value, out var id) ? id : null;
    }

    /// <summary>
    /// Whether the authenticated user may see this library item. Enforces
    /// library access and parental limits on every content-serving endpoint —
    /// authentication alone still allowed any user to read any item by GUID.
    /// Callers return 404 (not 403) on failure so item existence isn't leaked.
    /// </summary>
    private bool CanAccessItem(Guid itemId)
    {
        var userId = GetUserId();
        if (userId == null) return false;
        var user = _userManager.GetUserById(userId.Value);
        if (user == null) return false;
        var item = _libraryManager.GetItemById(itemId);
        return item != null && item.IsVisibleStandalone(user);
    }

    /// <summary>
    /// The caller's access token, for embedding in rewritten resource URLs —
    /// the chapter iframe's subresource requests (images, CSS) can't send auth
    /// headers, so they authenticate via ?api_key= like the TTS stream does.
    /// </summary>
    private string? GetApiToken()
    {
        if (Request.Query.TryGetValue("api_key", out var qk) && !string.IsNullOrEmpty(qk))
            return qk.ToString();
        if (Request.Headers.TryGetValue("X-Emby-Token", out var hk) && !string.IsNullOrEmpty(hk))
            return hk.ToString();
        // Authorization: MediaBrowser Client="...", Token="..."
        var auth = Request.Headers.Authorization.ToString();
        var m = System.Text.RegularExpressions.Regex.Match(auth, "Token=\"([^\"]+)\"");
        return m.Success ? m.Groups[1].Value : null;
    }

    // ── Static assets ─────────────────────────────────────────────────────────

    [HttpGet("a11y-book-reader.js")]
    [AllowAnonymous]
    [Produces("application/javascript")]
    public ActionResult GetScript() => ServeEmbedded("Inject.a11y-book-reader.js", "application/javascript");

    [HttpGet("a11y-book-reader.css")]
    [AllowAnonymous]
    [Produces("text/css")]
    public ActionResult GetStylesheet() => ServeEmbedded("Inject.a11y-book-reader.css", "text/css");

    // ── EPUB reading ──────────────────────────────────────────────────────────

    [HttpGet("spine/{itemId}")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public ActionResult<List<object>> GetSpine(Guid itemId)
    {
        if (!CanAccessItem(itemId)) return NotFound();
        // Format routing: text formats (.txt/.md/.html) and DAISY zips share
        // the EPUB surface
        var epub = _textFormats.Handles(itemId) ? _textFormats.GetParsed(itemId)
            : _daisy.Handles(itemId) ? _daisy.GetParsed(itemId)
            : _epub.GetParsed(itemId);
        if (epub == null) return NotFound();
        return epub.Spine.Select(s => (object)new { s.Index, s.Title, Href = s.ZipPath }).ToList();
    }

    // Auth via the class-level [Authorize]: the chapter iframe and its
    // subresources pass ?api_key= (headers are impossible there), the same
    // pattern the TTS <audio> stream uses. Was [AllowAnonymous] — anyone with
    // a GUID could read any book, bypassing library and parental limits.
    [HttpGet("chapter/{itemId}/{index}")]
    [Produces("text/html")]
    public ActionResult GetChapter(Guid itemId, int index)
    {
        if (!CanAccessItem(itemId)) return NotFound();
        var html = _textFormats.Handles(itemId) ? _textFormats.GetChapterHtml(itemId, index, GetApiToken())
            : _daisy.Handles(itemId) ? _daisy.GetChapterHtml(itemId, index, GetApiToken())
            : _epub.GetChapterHtml(itemId, index, GetApiToken());
        if (html == null) return NotFound();
        return Content(html, "text/html");
    }

    [HttpGet("resource/{itemId}")]
    public ActionResult GetResource(Guid itemId, [FromQuery] string path)
    {
        if (!CanAccessItem(itemId)) return NotFound();
        if (string.IsNullOrWhiteSpace(path)) return BadRequest();
        var (data, contentType) = _textFormats.Handles(itemId) ? _textFormats.GetResource(itemId, path)
            : _daisy.Handles(itemId) ? _daisy.GetResource(itemId, path)
            : _epub.GetResource(itemId, path);
        if (data == null) return NotFound();
        return File(data, contentType);
    }

    // ── Navigation (TOC / landmarks / page list) ──────────────────────────────

    [HttpGet("nav/{itemId}")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public ActionResult<BookNavigation> GetNavigation(Guid itemId)
    {
        if (!CanAccessItem(itemId)) return NotFound();
        var nav = _textFormats.Handles(itemId) ? _textFormats.GetNavigation(itemId)
            : _daisy.Handles(itemId) ? _daisy.GetNavigation(itemId)
            : _epub.GetNavigation(itemId);
        if (nav == null) return NotFound();
        return nav;
    }

    // ── In-book search ────────────────────────────────────────────────────────

    [HttpGet("search/{itemId}")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public ActionResult<SearchResults> Search(Guid itemId, [FromQuery] string q)
    {
        if (!CanAccessItem(itemId)) return NotFound();  // results leak book text
        if (string.IsNullOrWhiteSpace(q) || q.Trim().Length < 2)
            return new SearchResults();
        return _textFormats.Handles(itemId) ? _textFormats.Search(itemId, q)
            : _daisy.Handles(itemId) ? _daisy.Search(itemId, q)
            : _epub.Search(itemId, q);
    }

    // ── Reading progress ──────────────────────────────────────────────────────

    [HttpGet("progress/{itemId}")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public ActionResult<Locator> GetProgress(Guid itemId)
    {
        var userId = GetUserId();
        if (userId == null) return Unauthorized();
        var locator = _progress.Get(userId.Value, itemId);
        if (locator == null) return NotFound();
        return locator;
    }

    [HttpPost("progress/{itemId}")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    public ActionResult SaveProgress(Guid itemId, [FromBody] SaveLocatorRequest request)
    {
        var userId = GetUserId();
        if (userId == null) return Unauthorized();

        // Locator shape from current clients; legacy flat fields from cached scripts
        var locator = request.Locations != null
            ? new Locator { Href = request.Href, Locations = request.Locations, Text = request.Text }
            : new Locator
            {
                Locations = new LocatorLocations
                {
                    Chapter = request.Chapter ?? 0,
                    Progression = request.Fraction ?? 0.0,
                    Position = request.Para,
                },
            };

        _progress.Save(userId.Value, itemId, locator);
        return NoContent();
    }

    // ── Annotations & bookmarks (per user, per book) ──────────────────────────

    [HttpGet("annotations/{itemId}")]
    public ActionResult<List<Annotation>> GetAnnotations(Guid itemId)
    {
        var userId = GetUserId();
        if (userId == null) return Unauthorized();
        return _annotations.List(userId.Value, itemId);
    }

    [HttpPost("annotations/{itemId}")]
    public ActionResult<Annotation> CreateAnnotation(Guid itemId, [FromBody] SaveAnnotationRequest request)
    {
        var userId = GetUserId();
        if (userId == null) return Unauthorized();
        if (request.Locations == null) return BadRequest(new { error = "Locations is required" });

        var created = _annotations.Add(userId.Value, itemId, new Annotation
        {
            Type = request.Type,
            Body = request.Body,
            Color = request.Color,
            Target = new Locator { Href = request.Href, Locations = request.Locations, Text = request.Text },
        });
        if (created == null) return BadRequest(new { error = "Annotation limit reached for this book" });
        return created;
    }

    [HttpPost("annotations/{itemId}/{id}")]
    public ActionResult<Annotation> UpdateAnnotation(Guid itemId, Guid id, [FromBody] UpdateAnnotationRequest request)
    {
        var userId = GetUserId();
        if (userId == null) return Unauthorized();
        var updated = _annotations.Update(userId.Value, itemId, id, request.Body, request.Color);
        if (updated == null) return NotFound();
        return updated;
    }

    [HttpDelete("annotations/{itemId}/{id}")]
    public ActionResult DeleteAnnotation(Guid itemId, Guid id)
    {
        var userId = GetUserId();
        if (userId == null) return Unauthorized();
        return _annotations.Delete(userId.Value, itemId, id) ? NoContent() : NotFound();
    }

    /// <summary>
    /// Export the user's annotations for a book: W3C Web Annotation JSON-LD
    /// (format=json, the interchange standard) or human-readable Markdown
    /// (format=md). Served as a download.
    /// </summary>
    [HttpGet("annotations/{itemId}/export")]
    public ActionResult ExportAnnotations(Guid itemId, [FromQuery] string format = "json")
    {
        var userId = GetUserId();
        if (userId == null) return Unauthorized();
        var list = _annotations.List(userId.Value, itemId)
            .OrderBy(a => a.Target.Locations.Chapter)
            .ThenBy(a => a.Target.Locations.Progression)
            .ToList();
        var title = _libraryManager.GetItemById(itemId)?.Name ?? itemId.ToString("N");

        if (string.Equals(format, "md", StringComparison.OrdinalIgnoreCase))
        {
            var sb = new System.Text.StringBuilder();
            sb.Append("# Annotations — ").AppendLine(title).AppendLine();
            foreach (var a in list)
            {
                var pct = (int)Math.Round(a.Target.Locations.Progression * 100);
                sb.Append("- **").Append(a.Type).Append("** (chapter ")
                  .Append(a.Target.Locations.Chapter + 1).Append(", ").Append(pct).Append("%)");
                var quote = a.Target.Text?.Highlight;
                if (!string.IsNullOrEmpty(quote)) sb.Append(": “").Append(quote).Append('”');
                sb.AppendLine();
                if (!string.IsNullOrEmpty(a.Body)) sb.Append("  - ").AppendLine(a.Body!.Replace("\n", "\n    "));
            }
            return File(System.Text.Encoding.UTF8.GetBytes(sb.ToString()),
                "text/markdown", SafeFileName(title) + "-annotations.md");
        }

        var motivations = new Dictionary<string, string>
        {
            ["bookmark"] = "bookmarking",
            ["highlight"] = "highlighting",
            ["note"] = "commenting",
        };
        var items = list.Select(a => new Dictionary<string, object?>
        {
            ["id"] = "urn:uuid:" + a.Id,
            ["type"] = "Annotation",
            ["motivation"] = motivations.TryGetValue(a.Type, out var m) ? m : "bookmarking",
            ["created"] = a.Created.ToString("o"),
            ["modified"] = a.Updated.ToString("o"),
            ["body"] = string.IsNullOrEmpty(a.Body)
                ? null
                : new Dictionary<string, object?> { ["type"] = "TextualBody", ["value"] = a.Body, ["format"] = "text/plain" },
            ["target"] = new Dictionary<string, object?>
            {
                ["source"] = a.Target.Href ?? itemId.ToString("N"),
                ["selector"] = new object[]
                {
                    new Dictionary<string, object?>
                    {
                        ["type"] = "TextQuoteSelector",
                        ["exact"] = a.Target.Text?.Highlight ?? string.Empty,
                        ["prefix"] = a.Target.Text?.Before,
                        ["suffix"] = a.Target.Text?.After,
                    },
                    new Dictionary<string, object?>
                    {
                        ["type"] = "FragmentSelector",
                        ["value"] = "chapter=" + a.Target.Locations.Chapter +
                            (a.Target.Locations.Position != null ? ";block=" + a.Target.Locations.Position : string.Empty),
                    },
                },
            },
        }).ToList();
        var export = new Dictionary<string, object>
        {
            ["@context"] = "http://www.w3.org/ns/anno.jsonld",
            ["type"] = "AnnotationCollection",
            ["label"] = title + " — annotations",
            ["total"] = items.Count,
            ["items"] = items,
        };
        var json = System.Text.Json.JsonSerializer.Serialize(export,
            new System.Text.Json.JsonSerializerOptions { WriteIndented = true });
        return File(System.Text.Encoding.UTF8.GetBytes(json),
            "application/ld+json", SafeFileName(title) + "-annotations.json");
    }

    private static string SafeFileName(string s)
    {
        foreach (var c in Path.GetInvalidFileNameChars()) s = s.Replace(c, '_');
        return s;
    }

    // ── Reader settings (cross-device, per user) ──────────────────────────────

    [HttpGet("settings")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public ActionResult<ReaderSettings> GetSettings()
    {
        var userId = GetUserId();
        if (userId == null) return Unauthorized();
        var settings = _settings.Get(userId.Value);
        if (settings == null) return NotFound();
        return settings;
    }

    [HttpPost("settings")]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    public ActionResult SaveSettings([FromBody] ReaderSettings settings)
    {
        var userId = GetUserId();
        if (userId == null) return Unauthorized();
        _settings.Save(userId.Value, settings);
        return NoContent();
    }

    // ── Bundled fonts ─────────────────────────────────────────────────────────

    private static readonly string[] AllowedFonts =
    {
        "OpenDyslexic-Regular.woff2", "OpenDyslexic-Bold.woff2", "OpenDyslexic-Italic.woff2",
    };

    [HttpGet("font/{name}")]
    [AllowAnonymous]
    public ActionResult GetFont(string name)
    {
        if (!AllowedFonts.Contains(name, StringComparer.OrdinalIgnoreCase)) return NotFound();
        return ServeEmbedded("Fonts." + name, "font/woff2");
    }

    // ── Piper status & management ─────────────────────────────────────────────

    [HttpGet("piper/status")]
    public ActionResult<object> GetPiperStatus()
    {
        return new
        {
            installed = _piper.IsInstalled(),
            voices = _piper.GetDownloadedVoices(),
        };
    }

    // Returns the full Hugging Face voice catalog (for the config page)
    [HttpGet("piper/catalog")]
    public async Task<ActionResult<List<PiperVoiceInfo>>> GetPiperCatalog(CancellationToken ct)
    {
        try
        {
            return await _piper.GetCatalogAsync(ct).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            return StatusCode(502, new { error = ex.Message });
        }
    }

    // Returns only downloaded voices (for the reader dropdown)
    [HttpGet("piper/voices")]
    public ActionResult<List<PiperVoiceInfo>> GetPiperVoices()
        => _piper.GetDownloadedVoices();

    [HttpPost("piper/install")]
    public async Task<ActionResult> InstallPiper(CancellationToken ct)
    {
        try
        {
            await _piper.InstallAsync(ct).ConfigureAwait(false);
            return Ok(new { message = "Piper installed successfully" });
        }
        catch (Exception ex)
        {
            return StatusCode(500, new { error = ex.Message });
        }
    }

    [HttpGet("piper/voice/{key}/sample")]
    [AllowAnonymous]
    public async Task<ActionResult> StreamVoiceSample(string key, CancellationToken ct)
    {
        try
        {
            var catalog = await _piper.GetCatalogAsync(ct).ConfigureAwait(false);
            var voice = catalog.Find(v => string.Equals(v.Key, key, StringComparison.OrdinalIgnoreCase));
            if (voice?.SampleUrl == null) return NotFound();
            var wav = await _piper.FetchSampleAsync(voice.SampleUrl, ct).ConfigureAwait(false);
            return File(wav, "audio/wav");
        }
        catch (Exception ex)
        {
            return StatusCode(502, new { error = ex.Message });
        }
    }

    [HttpPost("piper/voice/{key}/download")]
    public async Task<ActionResult> DownloadVoice(string key, CancellationToken ct)
    {
        try
        {
            await _piper.DownloadVoiceAsync(key, ct).ConfigureAwait(false);
            return Ok(new { message = $"Voice '{key}' downloaded" });
        }
        catch (Exception ex)
        {
            return StatusCode(500, new { error = ex.Message });
        }
    }

    [HttpDelete("piper/voice/{key}")]
    public ActionResult DeleteVoice(string key)
    {
        _piper.DeleteVoice(key);
        return Ok(new { deleted = true });
    }

    // ── Text-to-speech synthesis ──────────────────────────────────────────────

    [HttpPost("tts")]
    public async Task<ActionResult> Synthesize([FromBody] TtsRequest request, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(request.Text) || string.IsNullOrWhiteSpace(request.Voice))
            return BadRequest();
        if (!_piper.HasVoice(request.Voice))
            return BadRequest(new { error = $"Voice '{request.Voice}' is not installed" });
        try
        {
            var wav = await _piper.SynthesizeAsync(request.Text, request.Voice, ct).ConfigureAwait(false);
            return File(wav, "audio/wav");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "TTS synthesis failed for voice '{Voice}'", request.Voice);
            return StatusCode(500, new { error = ex.Message });
        }
    }

    // ── Streaming text-to-speech ──────────────────────────────────────────────
    // Two-step because chapter text is too long for a URL and <audio> elements
    // can't send POST bodies: prepare stores the text and returns an id, then
    // the <audio> element GETs the stream URL (auth via api_key query param).

    // A prepared TTS session: the text/voice/rate to synthesize, plus the
    // per-sentence timing manifest that StreamTimedAsync fills in *as it
    // streams the audio*. The client streams the audio (fast start) and polls
    // the timing endpoint; the spans drive the highlight with zero drift
    // because they're measured from the exact audio being played.
    private sealed class TtsSession
    {
        public string Text = string.Empty;
        public string Voice = string.Empty;
        public double Rate = 1.0;
        public readonly List<SentenceSpan> Spans = new();
        public readonly object Lock = new();
        public bool Done;
        public DateTime Created = DateTime.UtcNow;
    }

    private static readonly System.Collections.Concurrent.ConcurrentDictionary<Guid, TtsSession> _pendingTts = new();

    [HttpPost("tts/prepare")]
    public ActionResult<object> PrepareTts([FromBody] TtsRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.Text) || string.IsNullOrWhiteSpace(request.Voice))
            return BadRequest();
        // Reject unknown voices HERE, where the client can still show an error —
        // an invalid key used to sail through and the stream came back as a
        // silent 200 with zero bytes.
        if (!_piper.HasVoice(request.Voice))
            return BadRequest(new { error = $"Voice '{request.Voice}' is not installed" });

        // Sweep expired entries (client never fetched the stream)
        var cutoff = DateTime.UtcNow.AddMinutes(-5);
        foreach (var kv in _pendingTts)
            if (kv.Value.Created < cutoff)
                _pendingTts.TryRemove(kv.Key, out _);

        var id = Guid.NewGuid();
        _pendingTts[id] = new TtsSession
        {
            Text = request.Text,
            Voice = request.Voice,
            Rate = request.Rate > 0 ? request.Rate : 1.0,
            Created = DateTime.UtcNow,
        };
        return new { id };
    }

    [HttpGet("tts/stream/{id}")]
    public async Task StreamTts(Guid id)
    {
        // Look up WITHOUT removing: iOS/AVFoundation fetches media URLs more
        // than once (a probe request, then the real one) — a consume-once id
        // 404s the second request. Entries expire via the TTL sweep instead.
        if (!_pendingTts.TryGetValue(id, out var session))
        {
            Response.StatusCode = StatusCodes.Status404NotFound;
            return;
        }

        // Fresh run: reset the manifest so a re-fetch (the iOS double-request)
        // rebuilds it rather than doubling it. Spans are deterministic for the
        // same text/voice/rate, so a client polling across the reset always
        // reads consistent values.
        lock (session.Lock) { session.Spans.Clear(); session.Done = false; }

        Response.ContentType = _piper.TimedStreamContentType;   // audio/mpeg (speed baked), or audio/wav if ffmpeg is missing
        _logger.LogInformation("Streaming TTS: voice '{Voice}', {Chars} chars, rate {Rate}", session.Voice, session.Text.Length, session.Rate);
        try
        {
            await _piper.StreamTimedAsync(session.Text, session.Voice, session.Rate,
                Response.Body, session.Spans, session.Lock, HttpContext.RequestAborted)
                .ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // client stopped playback / navigated away — normal, but leave a
            // trace: an aborted stream used to vanish without any log line
            _logger.LogDebug("TTS stream canceled by client (voice '{Voice}')", session.Voice);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Streaming TTS failed for voice '{Voice}'", session.Voice);
        }
        finally
        {
            lock (session.Lock) session.Done = true;
        }
    }

    [HttpGet("tts/timing/{id}")]
    public ActionResult<object> TtsTiming(Guid id)
    {
        if (!_pendingTts.TryGetValue(id, out var session))
            return NotFound();

        // Snapshot under the lock so serialization can't race the stream
        // mutating the list.
        List<SentenceSpan> snapshot;
        bool done;
        lock (session.Lock)
        {
            snapshot = new List<SentenceSpan>(session.Spans);
            done = session.Done;
        }
        return new { spans = snapshot, done };
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private ActionResult ServeEmbedded(string resourceName, string contentType)
    {
        var stream = typeof(A11yBookReaderPlugin).Assembly
            .GetManifestResourceStream($"{typeof(A11yBookReaderPlugin).Namespace}.{resourceName}");
        if (stream == null) return NotFound();
        return File(stream, contentType);
    }
}

public class TtsRequest
{
    public string Text { get; set; } = string.Empty;
    public string Voice { get; set; } = string.Empty;
    public double Rate { get; set; } = 1.0;
}
