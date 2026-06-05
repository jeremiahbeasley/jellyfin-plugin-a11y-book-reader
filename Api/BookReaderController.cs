using System.Net.Mime;
using Jellyfin.Plugin.A11yBookReader.Models;
using Jellyfin.Plugin.A11yBookReader.Services;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.A11yBookReader.Api;

[ApiController]
[Route("A11yBookReader")]
[Authorize(Policy = "DefaultAuthorization")]
public class BookReaderController : ControllerBase
{
    private readonly EpubService _epub;

    public BookReaderController(EpubService epub)
    {
        _epub = epub;
    }

    // Serve embedded JS
    [HttpGet("a11y-book-reader.js")]
    [AllowAnonymous]
    [Produces("application/javascript")]
    public ActionResult GetScript() => ServeEmbedded("Inject.a11y-book-reader.js", "application/javascript");

    // Serve embedded CSS
    [HttpGet("a11y-book-reader.css")]
    [AllowAnonymous]
    [Produces("text/css")]
    public ActionResult GetStylesheet() => ServeEmbedded("Inject.a11y-book-reader.css", "text/css");

    // Returns ordered spine items [{index, title}]
    [HttpGet("spine/{itemId}")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public ActionResult<List<object>> GetSpine(Guid itemId)
    {
        var epub = _epub.GetParsed(itemId);
        if (epub == null) return NotFound();
        return epub.Spine.Select(s => (object)new { s.Index, s.Title }).ToList();
    }

    // Returns full chapter HTML with rewritten resource URLs
    [HttpGet("chapter/{itemId}/{index}")]
    [Produces("text/html")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public ActionResult GetChapter(Guid itemId, int index)
    {
        var serverUrl = $"{Request.Scheme}://{Request.Host}";
        var html = _epub.GetChapterHtml(itemId, index, serverUrl);
        if (html == null) return NotFound();
        return Content(html, "text/html");
    }

    // Streams an EPUB resource (image, CSS, font, etc.)
    [HttpGet("resource/{itemId}")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public ActionResult GetResource(Guid itemId, [FromQuery] string path)
    {
        if (string.IsNullOrWhiteSpace(path)) return BadRequest();
        var (data, contentType) = _epub.GetResource(itemId, path);
        if (data == null) return NotFound();
        return File(data, contentType);
    }

    private ActionResult ServeEmbedded(string resourceName, string contentType)
    {
        var stream = typeof(A11yBookReaderPlugin).Assembly
            .GetManifestResourceStream($"{typeof(A11yBookReaderPlugin).Namespace}.{resourceName}");
        if (stream == null) return NotFound();
        return File(stream, contentType);
    }
}
