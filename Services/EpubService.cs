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

    private readonly ConcurrentDictionary<Guid, BookNavigation> _navCache = new();

    /// <summary>
    /// Navigation per the EPUB 3 Navigation Document (nav.xhtml: toc,
    /// landmarks, page-list), with NCX navMap/pageList as the fallback.
    /// </summary>
    public BookNavigation? GetNavigation(Guid itemId)
    {
        var epub = GetParsed(itemId);
        if (epub == null) return null;
        return _navCache.GetOrAdd(itemId, _ =>
        {
            try { return ParseNavigation(epub); }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Navigation parsing failed for {Id}", itemId);
                return new BookNavigation();
            }
        });
    }

    private BookNavigation ParseNavigation(ParsedEpub epub)
    {
        var nav = new BookNavigation();
        using var zip = ZipFile.OpenRead(epub.FilePath);

        // Spine lookup: zip path -> index
        var spineByPath = epub.Spine.ToDictionary(s => s.ZipPath, s => s.Index);

        // EPUB 3 nav document: manifest item with properties containing "nav".
        // Properties live in the OPF, which Manifest doesn't retain — re-read it.
        string? navHref = null;
        var containerEntry = zip.GetEntry("META-INF/container.xml");
        if (containerEntry != null)
        {
            string opfPath;
            using (var s = containerEntry.Open())
            {
                opfPath = XDocument.Load(s).Descendants()
                    .First(e => e.Name.LocalName == "rootfile")
                    .Attribute("full-path")!.Value;
            }
            var opfEntry = zip.GetEntry(opfPath);
            if (opfEntry != null)
            {
                using var s = opfEntry.Open();
                navHref = XDocument.Load(s).Descendants()
                    .Where(e => e.Name.LocalName == "item" &&
                                (e.Attribute("properties")?.Value ?? string.Empty)
                                .Split(' ').Contains("nav"))
                    .Select(e => e.Attribute("href")?.Value)
                    .FirstOrDefault();
            }
        }

        NavNode? Resolve(string? src, string baseDir, string title, string? epubType)
        {
            if (string.IsNullOrWhiteSpace(src)) return null;
            var anchor = src.Contains('#') ? src[(src.IndexOf('#') + 1)..] : null;
            var file = src.Contains('#') ? src[..src.IndexOf('#')] : src;
            var zipPath = NormalizePath(baseDir + Uri.UnescapeDataString(file));
            return new NavNode
            {
                Title = title.Trim(),
                Chapter = spineByPath.TryGetValue(zipPath, out var idx) ? idx : -1,
                Anchor = string.IsNullOrEmpty(anchor) ? null : anchor,
                EpubType = epubType,
            };
        }

        if (navHref != null)
        {
            var navZipPath = NormalizePath(epub.OpfBaseDir + navHref);
            var navDir = navZipPath.Contains('/')
                ? navZipPath[..(navZipPath.LastIndexOf('/') + 1)] : string.Empty;
            var navEntry = zip.GetEntry(navZipPath);
            if (navEntry != null)
            {
                XDocument doc;
                using (var s = navEntry.Open()) doc = XDocument.Load(s);
                XNamespace epubNs = "http://www.idpf.org/2007/ops";

                List<NavNode> WalkList(XElement? ol)
                {
                    var nodes = new List<NavNode>();
                    if (ol == null) return nodes;
                    foreach (var li in ol.Elements().Where(e => e.Name.LocalName == "li"))
                    {
                        var a = li.Elements().FirstOrDefault(e => e.Name.LocalName == "a");
                        var span = li.Elements().FirstOrDefault(e => e.Name.LocalName == "span");
                        var label = (a ?? span)?.Value ?? string.Empty;
                        var node = Resolve(a?.Attribute("href")?.Value, navDir, label,
                                       a?.Attribute(epubNs + "type")?.Value)
                                   ?? new NavNode { Title = label.Trim() };
                        var childOl = li.Elements().FirstOrDefault(e => e.Name.LocalName == "ol");
                        node.Children = WalkList(childOl);
                        if (!string.IsNullOrWhiteSpace(node.Title) || node.Children.Count > 0)
                            nodes.Add(node);
                    }
                    return nodes;
                }

                foreach (var navEl in doc.Descendants().Where(e => e.Name.LocalName == "nav"))
                {
                    var type = navEl.Attribute(epubNs + "type")?.Value ?? string.Empty;
                    var ol = navEl.Elements().FirstOrDefault(e => e.Name.LocalName == "ol");
                    if (type.Contains("toc")) nav.Toc = WalkList(ol);
                    else if (type.Contains("landmarks")) nav.Landmarks = WalkList(ol)
                        .Select(n => { n.EpubType ??= null; return n; }).ToList();
                    else if (type.Contains("page-list")) nav.PageList = WalkList(ol);
                }
            }
        }

        // NCX fallback for TOC (and pageList) when the nav doc gave nothing
        if (nav.Toc.Count == 0)
        {
            var ncxEntry = epub.Manifest.Values
                .Where(v => v.MimeType.Contains("ncx", StringComparison.OrdinalIgnoreCase))
                .Select(v => zip.GetEntry(NormalizePath(epub.OpfBaseDir + v.Href)))
                .FirstOrDefault(e => e != null);
            if (ncxEntry != null)
            {
                XDocument doc;
                using (var s = ncxEntry.Open()) doc = XDocument.Load(s);

                List<NavNode> WalkPoints(XElement parent)
                {
                    var nodes = new List<NavNode>();
                    foreach (var np in parent.Elements().Where(e => e.Name.LocalName == "navPoint"))
                    {
                        var title = np.Descendants().FirstOrDefault(e => e.Name.LocalName == "text")?.Value ?? string.Empty;
                        var src = np.Elements().FirstOrDefault(e => e.Name.LocalName == "content")?.Attribute("src")?.Value;
                        var node = Resolve(src, epub.OpfBaseDir, title, null)
                                   ?? new NavNode { Title = title.Trim() };
                        node.Children = WalkPoints(np);
                        nodes.Add(node);
                    }
                    return nodes;
                }

                var navMap = doc.Descendants().FirstOrDefault(e => e.Name.LocalName == "navMap");
                if (navMap != null) nav.Toc = WalkPoints(navMap);

                foreach (var pt in doc.Descendants().Where(e => e.Name.LocalName == "pageTarget"))
                {
                    var label = pt.Descendants().FirstOrDefault(e => e.Name.LocalName == "text")?.Value ?? string.Empty;
                    var src = pt.Elements().FirstOrDefault(e => e.Name.LocalName == "content")?.Attribute("src")?.Value;
                    var node = Resolve(src, epub.OpfBaseDir, label, null);
                    if (node != null) nav.PageList.Add(node);
                }
            }
        }

        // No book ever shows a useless navigation: synthesize a TOC from the
        // content when the parsed TOC is empty OR covers fewer than 2 distinct
        // chapters while the spine has more (e.g. Calibre's single "Start"
        // navPoint). A genuine multi-entry TOC is preserved untouched.
        int distinctChapters = CountDistinctChapters(nav.Toc);
        if (distinctChapters < 2 && epub.Spine.Count > 2)
        {
            nav.Toc = SynthesizeToc(epub, zip);
            nav.TocGenerated = true;
        }

        return nav;
    }

    private static int CountDistinctChapters(List<NavNode> nodes)
    {
        var seen = new HashSet<int>();
        void Walk(List<NavNode> ns)
        {
            foreach (var n in ns)
            {
                if (n.Chapter >= 0) seen.Add(n.Chapter);
                if (n.Children.Count > 0) Walk(n.Children);
            }
        }
        Walk(nodes);
        return seen.Count;
    }

    private List<NavNode> SynthesizeToc(ParsedEpub epub, ZipArchive zip)
    {
        var toc = new List<NavNode>();
        foreach (var item in epub.Spine)
        {
            string? heading = null;
            try
            {
                var entry = zip.GetEntry(item.ZipPath);
                if (entry != null)
                {
                    string html;
                    using (var r = new StreamReader(entry.Open())) html = r.ReadToEnd();
                    var m = Regex.Match(html, @"<h[1-6][^>]*>(.*?)</h[1-6]>",
                        RegexOptions.IgnoreCase | RegexOptions.Singleline);
                    if (m.Success)
                    {
                        var text = Regex.Replace(m.Groups[1].Value, "<[^>]+>", " ");
                        text = System.Net.WebUtility.HtmlDecode(text);
                        text = Regex.Replace(text, @"\s+", " ").Trim();
                        if (text.Length > 0) heading = text.Length > 80 ? text[..80] : text;
                    }
                }
            }
            catch (Exception ex)
            {
                _logger.LogDebug(ex, "Heading scan failed for spine item {Path}", item.ZipPath);
            }

            var title = heading
                ?? (item.Title.StartsWith("Chapter ", StringComparison.Ordinal) ? null : item.Title)
                ?? $"Section {item.Index + 1}";
            toc.Add(new NavNode { Title = title, Chapter = item.Index });
        }
        return toc;
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

        return RewriteUrlsForItem(html, chapter.ZipPath, itemId, serverUrl);
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

    private string? RewriteUrlsForItem(string html, string chapterZipPath, Guid itemId, string serverUrl)
    {
        var epub = GetParsed(itemId);
        var spineByPath = epub?.Spine.ToDictionary(s => s.ZipPath, s => s.Index)
                          ?? new Dictionary<string, int>();
        return RewriteUrls(html, chapterZipPath, itemId, serverUrl, spineByPath);
    }

    private static string RewriteUrls(string html, string chapterZipPath, Guid itemId, string serverUrl,
        Dictionary<string, int> spineByPath)
    {
        var chapterDir = chapterZipPath.Contains('/')
            ? chapterZipPath[..(chapterZipPath.LastIndexOf('/') + 1)]
            : string.Empty;

        // Mirror epub:type onto data-epub-type so the client can read it
        // reliably (the namespaced attribute is awkward in HTML-parsed docs).
        html = Regex.Replace(html, @"epub:type=""([^""]+)""",
            m => $"epub:type=\"{m.Groups[1].Value}\" data-epub-type=\"{m.Groups[1].Value}\"");

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
            var resolved = NormalizePath(chapterDir + Uri.UnescapeDataString(urlNoQuery));

            // Internal document-to-document link: mark for client-side
            // navigation instead of letting the iframe leave the reader.
            if (attr == "href" && spineByPath.TryGetValue(resolved, out var spineIdx))
            {
                var anchor = url.Contains('#') ? url[(url.IndexOf('#') + 1)..] : string.Empty;
                return $"href=\"#\" data-abr-chapter=\"{spineIdx}\" data-abr-anchor=\"{System.Net.WebUtility.HtmlEncode(anchor)}\"";
            }

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
