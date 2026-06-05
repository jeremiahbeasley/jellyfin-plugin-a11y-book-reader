using System.Collections.Concurrent;
using System.IO.Compression;
using System.Text.RegularExpressions;
using System.Xml.Linq;
using Jellyfin.Plugin.A11yBookReader.Models;
using MediaBrowser.Controller.Library;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.A11yBookReader.Services;

public class EpubService
{
    private readonly ILibraryManager _libraryManager;
    private readonly ILogger<EpubService> _logger;
    private readonly ConcurrentDictionary<Guid, ParsedEpub> _cache = new();

    public EpubService(ILibraryManager libraryManager, ILogger<EpubService> logger)
    {
        _libraryManager = libraryManager;
        _logger = logger;
    }

    public ParsedEpub? GetParsed(Guid itemId)
    {
        return _cache.GetOrAdd(itemId, id =>
        {
            try { return ParseEpubForItem(id); }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to parse EPUB for item {Id}", id);
                return null!;
            }
        });
    }

    private ParsedEpub ParseEpubForItem(Guid itemId)
    {
        var item = _libraryManager.GetItemById(itemId);
        if (item == null) throw new InvalidOperationException("Item not found");

        var path = item.Path;
        if (string.IsNullOrEmpty(path) || !path.EndsWith(".epub", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Item is not an EPUB");

        if (!File.Exists(path)) throw new FileNotFoundException("EPUB file not found", path);

        using var zip = ZipFile.OpenRead(path);

        // container.xml → OPF path
        var containerEntry = zip.GetEntry("META-INF/container.xml")
            ?? throw new InvalidOperationException("No META-INF/container.xml");

        string opfPath;
        using (var stream = containerEntry.Open())
        {
            var doc = XDocument.Load(stream);
            opfPath = doc.Descendants()
                .First(e => e.Name.LocalName == "rootfile")
                .Attribute("full-path")!.Value;
        }

        var opfEntry = zip.GetEntry(opfPath)
            ?? throw new InvalidOperationException($"OPF not found: {opfPath}");

        string opfBaseDir = opfPath.Contains('/')
            ? opfPath[..(opfPath.LastIndexOf('/') + 1)]
            : string.Empty;

        var manifest = new Dictionary<string, (string Href, string MimeType)>();
        var spineIds = new List<string>();

        using (var stream = opfEntry.Open())
        {
            var doc = XDocument.Load(stream);

            foreach (var el in doc.Descendants().Where(e => e.Name.LocalName == "item"))
            {
                var id = el.Attribute("id")?.Value;
                var href = el.Attribute("href")?.Value;
                var mime = el.Attribute("media-type")?.Value ?? string.Empty;
                if (id != null && href != null)
                    manifest[id] = (href, mime);
            }

            foreach (var el in doc.Descendants().Where(e => e.Name.LocalName == "itemref"))
            {
                var idref = el.Attribute("idref")?.Value;
                if (idref != null && manifest.ContainsKey(idref))
                    spineIds.Add(idref);
            }
        }

        // Try NCX for chapter titles
        var navTitles = new Dictionary<string, string>();
        var ncxEntry = manifest.Values
            .Where(v => v.MimeType.Contains("ncx", StringComparison.OrdinalIgnoreCase))
            .Select(v => zip.GetEntry(NormalizePath(opfBaseDir + v.Href)))
            .FirstOrDefault(e => e != null);

        if (ncxEntry != null)
        {
            try
            {
                using var stream = ncxEntry.Open();
                var doc = XDocument.Load(stream);
                foreach (var navPoint in doc.Descendants().Where(e => e.Name.LocalName == "navPoint"))
                {
                    var titleText = navPoint.Descendants()
                        .FirstOrDefault(e => e.Name.LocalName == "text")?.Value.Trim();
                    var src = navPoint.Descendants()
                        .FirstOrDefault(e => e.Name.LocalName == "content")
                        ?.Attribute("src")?.Value;
                    if (src != null && titleText != null)
                    {
                        var srcBase = src.Contains('#') ? src[..src.IndexOf('#')] : src;
                        navTitles[srcBase] = titleText;
                    }
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "NCX parsing failed, falling back to generic chapter titles");
            }
        }

        var spine = spineIds.Select((id, i) =>
        {
            var (href, mime) = manifest[id];
            var zipPath = NormalizePath(opfBaseDir + href);
            navTitles.TryGetValue(href, out var title);
            return new SpineItem
            {
                Index = i,
                Title = title ?? $"Chapter {i + 1}",
                ZipPath = zipPath,
                MimeType = mime
            };
        }).ToList();

        return new ParsedEpub
        {
            FilePath = path,
            OpfBaseDir = opfBaseDir,
            Spine = spine,
            Manifest = manifest
        };
    }

    public string? GetChapterHtml(Guid itemId, int index, string serverUrl)
    {
        var epub = GetParsed(itemId);
        if (epub == null || index < 0 || index >= epub.Spine.Count) return null;

        var chapter = epub.Spine[index];
        using var zip = ZipFile.OpenRead(epub.FilePath);
        var entry = zip.GetEntry(chapter.ZipPath);
        if (entry == null) return null;

        string html;
        using (var reader = new StreamReader(entry.Open()))
            html = reader.ReadToEnd();

        return RewriteUrls(html, chapter.ZipPath, itemId, serverUrl);
    }

    public (Stream? Data, string ContentType) GetResource(Guid itemId, string path)
    {
        var epub = GetParsed(itemId);
        if (epub == null) return (null, string.Empty);

        var normalized = NormalizePath(path);
        using var zip = ZipFile.OpenRead(epub.FilePath);
        var entry = zip.GetEntry(normalized);
        if (entry == null) return (null, string.Empty);

        var ms = new MemoryStream();
        using (var s = entry.Open()) s.CopyTo(ms);
        ms.Position = 0;

        var mime = epub.Manifest.Values
            .Where(v => NormalizePath(epub.OpfBaseDir + v.Href) == normalized)
            .Select(v => v.MimeType)
            .FirstOrDefault()
            ?? MimeFromExtension(Path.GetExtension(normalized));

        return (ms, mime);
    }

    private static string RewriteUrls(string html, string chapterZipPath, Guid itemId, string serverUrl)
    {
        var chapterDir = chapterZipPath.Contains('/')
            ? chapterZipPath[..(chapterZipPath.LastIndexOf('/') + 1)]
            : string.Empty;

        // Rewrite href="..." and src="..." attributes
        html = Regex.Replace(html, @"(href|src)=""([^""]+)""", m =>
        {
            var attr = m.Groups[1].Value;
            var url = m.Groups[2].Value;
            if (url.StartsWith("http", StringComparison.Ordinal) ||
                url.StartsWith("data:", StringComparison.Ordinal) ||
                url.StartsWith('#'))
                return m.Value;
            var urlNoAnchor = url.Contains('#') ? url[..url.IndexOf('#')] : url;
            var urlNoQuery = urlNoAnchor.Contains('?') ? urlNoAnchor[..urlNoAnchor.IndexOf('?')] : urlNoAnchor;
            var resolved = NormalizePath(chapterDir + urlNoQuery);
            return $"{attr}=\"{serverUrl}/A11yBookReader/resource/{itemId}?path={Uri.EscapeDataString(resolved)}\"";
        });

        // Rewrite url(...) in inline styles
        html = Regex.Replace(html, @"url\(['""]?([^'""\)\s]+)['""]?\)", m =>
        {
            var url = m.Groups[1].Value;
            if (url.StartsWith("http", StringComparison.Ordinal) ||
                url.StartsWith("data:", StringComparison.Ordinal))
                return m.Value;
            var resolved = NormalizePath(chapterDir + url);
            return $"url('{serverUrl}/A11yBookReader/resource/{itemId}?path={Uri.EscapeDataString(resolved)}')";
        });

        return html;
    }

    private static string NormalizePath(string path)
    {
        var parts = path.Split('/');
        var result = new List<string>();
        foreach (var part in parts)
        {
            if (part == "..") { if (result.Count > 0) result.RemoveAt(result.Count - 1); }
            else if (part is not ("." or "")) result.Add(part);
        }
        return string.Join("/", result);
    }

    private static string MimeFromExtension(string ext) => ext.ToLowerInvariant() switch
    {
        ".jpg" or ".jpeg" => "image/jpeg",
        ".png"            => "image/png",
        ".gif"            => "image/gif",
        ".svg"            => "image/svg+xml",
        ".webp"           => "image/webp",
        ".css"            => "text/css",
        ".ttf"            => "font/ttf",
        ".woff"           => "font/woff",
        ".woff2"          => "font/woff2",
        ".otf"            => "font/otf",
        ".xhtml"          => "application/xhtml+xml",
        ".html" or ".htm" => "text/html",
        _                 => "application/octet-stream"
    };
}
