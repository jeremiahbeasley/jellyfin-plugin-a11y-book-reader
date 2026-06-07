using Jellyfin.Plugin.A11yBookReader.Models;
using Jellyfin.Plugin.A11yBookReader.Services;
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
    private readonly ILogger<BookReaderController> _logger;

    public BookReaderController(EpubService epub, PiperService piper, ProgressService progress, ILogger<BookReaderController> logger)
    {
        _epub = epub;
        _piper = piper;
        _progress = progress;
        _logger = logger;
    }

    /// <summary>Current user's id from the Jellyfin auth claim; never trusted from the client.</summary>
    private Guid? GetUserId()
    {
        var claim = User.Claims.FirstOrDefault(c =>
            string.Equals(c.Type, "Jellyfin-UserId", StringComparison.OrdinalIgnoreCase));
        return Guid.TryParse(claim?.Value, out var id) ? id : null;
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
        var epub = _epub.GetParsed(itemId);
        if (epub == null) return NotFound();
        return epub.Spine.Select(s => (object)new { s.Index, s.Title, Href = s.ZipPath }).ToList();
    }

    [HttpGet("chapter/{itemId}/{index}")]
    [AllowAnonymous]
    [Produces("text/html")]
    public ActionResult GetChapter(Guid itemId, int index)
    {
        var serverUrl = $"{Request.Scheme}://{Request.Host}";
        var html = _epub.GetChapterHtml(itemId, index, serverUrl);
        if (html == null) return NotFound();
        return Content(html, "text/html");
    }

    [HttpGet("resource/{itemId}")]
    [AllowAnonymous]
    public ActionResult GetResource(Guid itemId, [FromQuery] string path)
    {
        if (string.IsNullOrWhiteSpace(path)) return BadRequest();
        var (data, contentType) = _epub.GetResource(itemId, path);
        if (data == null) return NotFound();
        return File(data, contentType);
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

    private static readonly System.Collections.Concurrent.ConcurrentDictionary<Guid, (string Text, string Voice, double Rate, DateTime Created)> _pendingTts = new();

    [HttpPost("tts/prepare")]
    public ActionResult<object> PrepareTts([FromBody] TtsRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.Text) || string.IsNullOrWhiteSpace(request.Voice))
            return BadRequest();

        // Sweep expired entries (client never fetched the stream)
        var cutoff = DateTime.UtcNow.AddMinutes(-5);
        foreach (var kv in _pendingTts)
            if (kv.Value.Created < cutoff)
                _pendingTts.TryRemove(kv.Key, out _);

        var id = Guid.NewGuid();
        _pendingTts[id] = (request.Text, request.Voice, request.Rate, DateTime.UtcNow);
        return new { id };
    }

    [HttpGet("tts/stream/{id}")]
    public async Task StreamTts(Guid id)
    {
        // Look up WITHOUT removing: iOS/AVFoundation fetches media URLs more
        // than once (a probe request, then the real one) — a consume-once id
        // 404s the second request. Entries expire via the TTL sweep instead.
        if (!_pendingTts.TryGetValue(id, out var pending))
        {
            Response.StatusCode = StatusCodes.Status404NotFound;
            return;
        }

        Response.ContentType = _piper.StreamContentType;   // audio/mpeg, or audio/wav if ffmpeg is missing
        try
        {
            await _piper.SynthesizeStreamAsync(pending.Text, pending.Voice, pending.Rate, Response.Body, HttpContext.RequestAborted)
                .ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // client stopped playback / navigated away — normal
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Streaming TTS failed for voice '{Voice}'", pending.Voice);
        }
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
