using System.Collections.Concurrent;
using System.IO.Compression;
using System.Text;
using System.Text.RegularExpressions;
using System.Xml.Linq;
using Jellyfin.Plugin.A11yBookReader.Models;
using MediaBrowser.Controller.Library;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.A11yBookReader.Services;

/// <summary>
/// Text DAISY talking books packaged as .zip — both DAISY 2.02 (ncc.html
/// navigation + XHTML content) and DAISY 3 / Z39.86 (OPF package + DTBook
/// content + NCX navigation). Presented through the same surface as
/// EpubService so TTS, search, bookmarks, and highlights work unchanged.
/// </summary>
public class DaisyFormatService
{
    private readonly ILibraryManager _libraryManager;
    private readonly ILogger<DaisyFormatService> _logger;
    private readonly ConcurrentDictionary<Guid, ParsedDaisy?> _cache = new();

    public DaisyFormatService(ILibraryManager libraryManager, ILogger<DaisyFormatService> logger)
    {
        _libraryManager = libraryManager;
        _logger = logger;
    }

    private sealed class ParsedDaisy
    {
        public string FilePath = string.Empty;
        public bool IsDtbook;                       // DAISY 3 (transformed) vs 2.02 (zip XHTML)
        public List<DaisyChapter> Chapters = new();
        public BookNavigation Nav = new();
    }

    private sealed class DaisyChapter
    {
        public string Title = string.Empty;
        public string ZipPath = string.Empty;       // 2.02: content doc in the zip; 3: synthetic id
        public string BodyHtml = string.Empty;      // 3 only: transformed DTBook XHTML
        public string BaseDir = string.Empty;       // for resource URL resolution
    }

    // ── Detection (used by the resolver at scan time) ────────────────────────

    /// <summary>Cheap zip sniff: ncc.html (2.02) or an OPF declaring DTBook (3).</summary>
    public static bool SniffsAsDaisy(string path)
    {
        if (!path.EndsWith(".zip", StringComparison.OrdinalIgnoreCase)) return false;
        try
        {
            using var zip = ZipFile.OpenRead(path);
            if (FindEntry(zip, e => e.Name.Equals("ncc.html", StringComparison.OrdinalIgnoreCase)) != null)
                return true;
            var opf = FindEntry(zip, e => e.Name.EndsWith(".opf", StringComparison.OrdinalIgnoreCase));
            if (opf == null) return false;
            using var r = new StreamReader(opf.Open());
            var head = r.ReadToEnd();
            return head.Contains("x-dtbook", StringComparison.OrdinalIgnoreCase) ||
                   head.Contains("ANSI/NISO Z39.86", StringComparison.OrdinalIgnoreCase);
        }
        catch { return false; }
    }

    public bool Handles(Guid itemId)
    {
        if (_cache.TryGetValue(itemId, out var cached)) return cached != null;
        var path = _libraryManager.GetItemById(itemId)?.Path;
        if (path == null || !path.EndsWith(".zip", StringComparison.OrdinalIgnoreCase)) return false;
        return SniffsAsDaisy(path);
    }

    private static ZipArchiveEntry? FindEntry(ZipArchive zip, Func<ZipArchiveEntry, bool> match) =>
        zip.Entries.Where(match).OrderBy(e => e.FullName.Count(c => c == '/')).FirstOrDefault();

    // ── Public surface (mirrors EpubService) ─────────────────────────────────

    public ParsedEpub? GetParsed(Guid itemId)
    {
        var book = GetBook(itemId);
        if (book == null) return null;
        return new ParsedEpub
        {
            FilePath = book.FilePath,
            Spine = book.Chapters.Select((c, i) => new SpineItem
            {
                Index = i,
                Title = c.Title,
                ZipPath = c.ZipPath,
                MimeType = "application/xhtml+xml",
            }).ToList(),
        };
    }

    public BookNavigation? GetNavigation(Guid itemId) => GetBook(itemId)?.Nav;

    public string? GetChapterHtml(Guid itemId, int index, string? apiKey = null)
    {
        var book = GetBook(itemId);
        if (book == null || index < 0 || index >= book.Chapters.Count) return null;
        var c = book.Chapters[index];

        string body;
        if (book.IsDtbook)
        {
            body = c.BodyHtml;
        }
        else
        {
            using var zip = ZipFile.OpenRead(book.FilePath);
            var entry = zip.GetEntry(c.ZipPath);
            if (entry == null) return null;
            using var r = new StreamReader(entry.Open());
            var raw = r.ReadToEnd();
            var m = Regex.Match(raw, @"<body[^>]*>(.*)</body>", RegexOptions.IgnoreCase | RegexOptions.Singleline);
            body = Sanitize(m.Success ? m.Groups[1].Value : raw);
        }

        var html = "<!DOCTYPE html><html xmlns=\"http://www.w3.org/1999/xhtml\"><head><meta charset=\"utf-8\"/><title>"
            + Escape(c.Title) + "</title></head><body>" + body + "</body></html>";
        return RewriteUrls(html, c.BaseDir, itemId,
            book.Chapters.Select((ch, i) => (ch.ZipPath, i)).ToDictionary(t => t.ZipPath, t => t.i), apiKey);
    }

    public (Stream? Data, string ContentType) GetResource(Guid itemId, string path)
    {
        var book = GetBook(itemId);
        if (book == null) return (null, string.Empty);
        var normalized = NormalizePath(path);
        using var zip = ZipFile.OpenRead(book.FilePath);
        var entry = zip.GetEntry(normalized);
        if (entry == null) return (null, string.Empty);
        var ms = new MemoryStream();
        using (var s = entry.Open()) s.CopyTo(ms);
        ms.Position = 0;
        return (ms, MimeFromExtension(Path.GetExtension(normalized)));
    }

    public SearchResults Search(Guid itemId, string query, int cap = 200)
    {
        var results = new SearchResults();
        var book = GetBook(itemId);
        if (book == null || string.IsNullOrWhiteSpace(query)) return results;
        var needle = query.Trim();

        using var zip = book.IsDtbook ? null : ZipFile.OpenRead(book.FilePath);
        for (var ci = 0; ci < book.Chapters.Count; ci++)
        {
            var c = book.Chapters[ci];
            string html;
            if (book.IsDtbook) html = c.BodyHtml;
            else
            {
                var entry = zip!.GetEntry(c.ZipPath);
                if (entry == null) continue;
                using var r = new StreamReader(entry.Open());
                html = r.ReadToEnd();
            }
            var text = Regex.Replace(html, @"<(script|style)[^>]*>.*?</\1>", " ",
                RegexOptions.IgnoreCase | RegexOptions.Singleline);
            text = Regex.Replace(text, "<[^>]+>", " ");
            text = System.Net.WebUtility.HtmlDecode(text);
            text = Regex.Replace(text, @"\s+", " ").Trim();

            int ordinal = 0, from = 0;
            while (true)
            {
                int idx = text.IndexOf(needle, from, StringComparison.OrdinalIgnoreCase);
                if (idx < 0) break;
                results.Total++;
                if (results.Hits.Count < cap)
                {
                    int bStart = Math.Max(0, idx - 40);
                    int aEnd = Math.Min(text.Length, idx + needle.Length + 60);
                    var matchText = text.Substring(idx, needle.Length);
                    var after = text[(idx + needle.Length)..aEnd];
                    results.Hits.Add(new SearchHit
                    {
                        Chapter = ci,
                        ChapterTitle = c.Title,
                        Before = (bStart > 0 ? "…" : string.Empty) + text[bStart..idx],
                        Match = matchText,
                        After = after + (aEnd < text.Length ? "…" : string.Empty),
                        Quote = (matchText + after).Trim(),
                        Ordinal = ordinal,
                    });
                }
                ordinal++;
                from = idx + needle.Length;
            }
        }

        results.Capped = results.Total > results.Hits.Count;
        return results;
    }

    // ── Parsing ──────────────────────────────────────────────────────────────

    private ParsedDaisy? GetBook(Guid itemId)
    {
        return _cache.GetOrAdd(itemId, id =>
        {
            try { return Parse(id); }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to parse DAISY book {Id}", id);
                return null;
            }
        });
    }

    private ParsedDaisy? Parse(Guid itemId)
    {
        var path = _libraryManager.GetItemById(itemId)?.Path;
        if (path == null || !File.Exists(path)) return null;

        using var zip = ZipFile.OpenRead(path);
        var ncc = FindEntry(zip, e => e.Name.Equals("ncc.html", StringComparison.OrdinalIgnoreCase));
        if (ncc != null) return ParseDaisy202(path, zip, ncc);
        var opf = FindEntry(zip, e => e.Name.EndsWith(".opf", StringComparison.OrdinalIgnoreCase));
        if (opf != null) return ParseDaisy3(path, zip, opf);
        return null;
    }

    // ── DAISY 2.02: ncc.html headings drive structure ────────────────────────

    private ParsedDaisy ParseDaisy202(string path, ZipArchive zip, ZipArchiveEntry ncc)
    {
        var baseDir = ncc.FullName.Contains('/')
            ? ncc.FullName[..(ncc.FullName.LastIndexOf('/') + 1)]
            : string.Empty;

        string nccHtml;
        using (var r = new StreamReader(ncc.Open())) nccHtml = r.ReadToEnd();

        // Heading anchors: <hN ...><a href="content.html#id">Title</a></hN>
        var headings = new List<(int Level, string Title, string Target)>();
        foreach (Match m in Regex.Matches(nccHtml,
            @"<h([1-6])[^>]*>\s*<a[^>]+href\s*=\s*[""']([^""']+)[""'][^>]*>(.*?)</a>",
            RegexOptions.IgnoreCase | RegexOptions.Singleline))
        {
            var title = Regex.Replace(m.Groups[3].Value, "<[^>]+>", string.Empty).Trim();
            headings.Add((int.Parse(m.Groups[1].Value), System.Net.WebUtility.HtmlDecode(title), m.Groups[2].Value));
        }

        // Content docs in NCC order. An audio-DAISY NCC points at .smil files;
        // each smil's first <text src> names the real text document.
        var docOrder = new List<string>();
        var docOf = new Dictionary<string, string>();   // heading target → content doc zip path
        foreach (var (_, _, target) in headings)
        {
            var file = target.Contains('#') ? target[..target.IndexOf('#')] : target;
            var zipPath = NormalizePath(baseDir + Uri.UnescapeDataString(file));
            if (zipPath.EndsWith(".smil", StringComparison.OrdinalIgnoreCase))
            {
                var resolved = ResolveSmilText(zip, zipPath);
                if (resolved == null) continue;
                zipPath = resolved;
            }
            docOf[target] = zipPath;
            if (!docOrder.Contains(zipPath)) docOrder.Add(zipPath);
        }

        var chapters = docOrder.Select(p => new DaisyChapter
        {
            ZipPath = p,
            BaseDir = p.Contains('/') ? p[..(p.LastIndexOf('/') + 1)] : string.Empty,
            Title = headings.FirstOrDefault(h => docOf.TryGetValue(h.Target, out var d) && d == p).Title ?? Path.GetFileName(p),
        }).ToList();

        // TOC tree from heading levels; chapter = index of the target's doc
        var nav = new BookNavigation();
        var stack = new List<(int Level, NavNode Node)>();
        foreach (var (level, title, target) in headings)
        {
            if (!docOf.TryGetValue(target, out var doc)) continue;
            var node = new NavNode
            {
                Title = title,
                Chapter = docOrder.IndexOf(doc),
                Anchor = target.Contains('#') ? target[(target.IndexOf('#') + 1)..] : null,
            };
            while (stack.Count > 0 && stack[^1].Level >= level) stack.RemoveAt(stack.Count - 1);
            if (stack.Count == 0) nav.Toc.Add(node);
            else stack[^1].Node.Children.Add(node);
            stack.Add((level, node));
        }

        return new ParsedDaisy { FilePath = path, IsDtbook = false, Chapters = chapters, Nav = nav };
    }

    private static string? ResolveSmilText(ZipArchive zip, string smilZipPath)
    {
        try
        {
            var entry = zip.GetEntry(smilZipPath);
            if (entry == null) return null;
            using var s = entry.Open();
            var doc = XDocument.Load(s);
            var src = doc.Descendants().FirstOrDefault(e => e.Name.LocalName == "text")?.Attribute("src")?.Value;
            if (src == null) return null;
            var file = src.Contains('#') ? src[..src.IndexOf('#')] : src;
            var dir = smilZipPath.Contains('/') ? smilZipPath[..(smilZipPath.LastIndexOf('/') + 1)] : string.Empty;
            return NormalizePath(dir + Uri.UnescapeDataString(file));
        }
        catch { return null; }
    }

    // ── DAISY 3: OPF + DTBook + NCX ──────────────────────────────────────────

    private ParsedDaisy ParseDaisy3(string path, ZipArchive zip, ZipArchiveEntry opfEntry)
    {
        var baseDir = opfEntry.FullName.Contains('/')
            ? opfEntry.FullName[..(opfEntry.FullName.LastIndexOf('/') + 1)]
            : string.Empty;

        XDocument opf;
        using (var s = opfEntry.Open()) opf = XDocument.Load(s);

        var manifest = opf.Descendants().Where(e => e.Name.LocalName == "item")
            .Where(e => e.Attribute("id") != null && e.Attribute("href") != null)
            .ToDictionary(e => e.Attribute("id")!.Value,
                          e => (Href: e.Attribute("href")!.Value, Mime: e.Attribute("media-type")?.Value ?? string.Empty));

        var dtbookPaths = opf.Descendants().Where(e => e.Name.LocalName == "itemref")
            .Select(e => e.Attribute("idref")?.Value)
            .Where(idr => idr != null && manifest.ContainsKey(idr!))
            .Select(idr => manifest[idr!])
            .Where(m2 => m2.Mime.Contains("dtbook", StringComparison.OrdinalIgnoreCase) ||
                         m2.Href.EndsWith(".xml", StringComparison.OrdinalIgnoreCase))
            .Select(m2 => NormalizePath(baseDir + m2.Href))
            .ToList();
        if (dtbookPaths.Count == 0)
        {
            dtbookPaths = manifest.Values
                .Where(m2 => m2.Mime.Contains("dtbook", StringComparison.OrdinalIgnoreCase))
                .Select(m2 => NormalizePath(baseDir + m2.Href)).ToList();
        }

        var chapters = new List<DaisyChapter>();
        var idToChapter = new Dictionary<string, int>(StringComparer.Ordinal);
        var pageNodes = new List<NavNode>();

        foreach (var dtPath in dtbookPaths)
        {
            var entry = zip.GetEntry(dtPath);
            if (entry == null) continue;
            XDocument dt;
            using (var s = entry.Open()) dt = XDocument.Load(s);

            var bookEl = dt.Descendants().FirstOrDefault(e => e.Name.LocalName == "book") ?? dt.Root!;
            var level1s = bookEl.Descendants().Where(e => e.Name.LocalName == "level1").ToList();
            if (level1s.Count == 0) level1s = new List<XElement> { bookEl };

            var dtDir = dtPath.Contains('/') ? dtPath[..(dtPath.LastIndexOf('/') + 1)] : string.Empty;
            foreach (var lvl in level1s)
            {
                var sb = new StringBuilder();
                var chapterIndex = chapters.Count;
                TransformDtbook(lvl, sb, 1, id => idToChapter[id] = chapterIndex,
                    (pid, plabel) => pageNodes.Add(new NavNode { Title = plabel, Chapter = chapterIndex, Anchor = pid }));
                var title = lvl.Descendants().FirstOrDefault(e => e.Name.LocalName is "hd" or "h1")?.Value.Trim()
                    ?? "Section " + (chapterIndex + 1);
                chapters.Add(new DaisyChapter
                {
                    Title = title,
                    ZipPath = dtPath + "#" + chapterIndex,
                    BodyHtml = sb.ToString(),
                    BaseDir = dtDir,
                });
            }
        }

        // NCX → TOC (navPoint targets map to chapters via collected ids)
        var nav = new BookNavigation { PageList = pageNodes };
        var ncxPath = manifest.Values
            .Select(m2 => NormalizePath(baseDir + m2.Href))
            .FirstOrDefault(p2 => p2.EndsWith(".ncx", StringComparison.OrdinalIgnoreCase));
        if (ncxPath != null && zip.GetEntry(ncxPath) is { } ncxEntry)
        {
            XDocument ncx;
            using (var s = ncxEntry.Open()) ncx = XDocument.Load(s);
            var navMap = ncx.Descendants().FirstOrDefault(e => e.Name.LocalName == "navMap");
            if (navMap != null)
                foreach (var np in navMap.Elements().Where(e => e.Name.LocalName == "navPoint"))
                    nav.Toc.Add(NcxNode(np, idToChapter));
        }
        if (nav.Toc.Count == 0)
        {
            nav.Toc = chapters.Select((c, i) => new NavNode { Title = c.Title, Chapter = i }).ToList();
            nav.TocGenerated = true;
        }

        return new ParsedDaisy { FilePath = path, IsDtbook = true, Chapters = chapters, Nav = nav };
    }

    private static NavNode NcxNode(XElement navPoint, Dictionary<string, int> idToChapter)
    {
        var label = navPoint.Descendants().FirstOrDefault(e => e.Name.LocalName == "text")?.Value.Trim() ?? string.Empty;
        var src = navPoint.Elements().FirstOrDefault(e => e.Name.LocalName == "content")?.Attribute("src")?.Value ?? string.Empty;
        var anchor = src.Contains('#') ? src[(src.IndexOf('#') + 1)..] : null;
        var node = new NavNode
        {
            Title = label,
            Chapter = anchor != null && idToChapter.TryGetValue(anchor, out var ch) ? ch : (idToChapter.Count > 0 ? -1 : 0),
            Anchor = anchor,
        };
        foreach (var child in navPoint.Elements().Where(e => e.Name.LocalName == "navPoint"))
            node.Children.Add(NcxNode(child, idToChapter));
        return node;
    }

    /// <summary>DTBook → XHTML: the documented element mapping, ids preserved.</summary>
    private static void TransformDtbook(XElement el, StringBuilder sb, int depth,
        Action<string> recordId, Action<string, string> recordPage)
    {
        foreach (var node in el.Nodes())
        {
            if (node is XText t) { sb.Append(Escape(t.Value)); continue; }
            if (node is not XElement e) continue;

            var name = e.Name.LocalName.ToLowerInvariant();
            var id = e.Attribute("id")?.Value;
            if (id != null) recordId(id);
            var idAttr = id != null ? " id=\"" + Escape(id) + "\"" : string.Empty;

            switch (name)
            {
                case "hd":
                    var h = Math.Min(6, depth);
                    sb.Append("<h").Append(h).Append(idAttr).Append('>');
                    TransformDtbook(e, sb, depth, recordId, recordPage);
                    sb.Append("</h").Append(h).Append('>');
                    break;
                case "level2" or "level3" or "level4" or "level5" or "level6" or "level":
                    sb.Append("<section").Append(idAttr).Append('>');
                    TransformDtbook(e, sb, depth + 1, recordId, recordPage);
                    sb.Append("</section>");
                    break;
                case "p" or "blockquote" or "table" or "tr" or "td" or "th" or "br" or "em" or "strong" or "sub" or "sup" or "span" or "li":
                    if (name == "br") { sb.Append("<br/>"); break; }
                    sb.Append('<').Append(name).Append(idAttr).Append('>');
                    TransformDtbook(e, sb, depth, recordId, recordPage);
                    sb.Append("</").Append(name).Append('>');
                    break;
                case "pagenum":
                    var label = e.Value.Trim();
                    if (id != null && label.Length > 0) recordPage(id, label);
                    sb.Append("<span").Append(idAttr)
                      .Append(" epub:type=\"pagebreak\" role=\"doc-pagebreak\" aria-label=\"")
                      .Append(Escape(label)).Append("\">").Append(Escape(label)).Append("</span>");
                    break;
                case "list":
                    var tag = string.Equals(e.Attribute("type")?.Value, "ol", StringComparison.OrdinalIgnoreCase) ? "ol" : "ul";
                    sb.Append('<').Append(tag).Append(idAttr).Append('>');
                    TransformDtbook(e, sb, depth, recordId, recordPage);
                    sb.Append("</").Append(tag).Append('>');
                    break;
                case "imggroup" or "sidebar" or "prodnote" or "note" or "annotation":
                    sb.Append("<aside").Append(idAttr).Append('>');
                    TransformDtbook(e, sb, depth, recordId, recordPage);
                    sb.Append("</aside>");
                    break;
                case "img":
                    var src = e.Attribute("src")?.Value ?? string.Empty;
                    var alt = e.Attribute("alt")?.Value ?? string.Empty;
                    sb.Append("<img").Append(idAttr).Append(" src=\"").Append(Escape(src))
                      .Append("\" alt=\"").Append(Escape(alt)).Append("\"/>");
                    break;
                case "noteref":
                    sb.Append("<sup").Append(idAttr).Append('>');
                    TransformDtbook(e, sb, depth, recordId, recordPage);
                    sb.Append("</sup>");
                    break;
                case "sent" or "w" or "doctitle" or "docauthor" or "lic":
                    // inline containers: unwrap, keep text
                    TransformDtbook(e, sb, depth, recordId, recordPage);
                    break;
                default:
                    sb.Append("<div").Append(idAttr).Append('>');
                    TransformDtbook(e, sb, depth, recordId, recordPage);
                    sb.Append("</div>");
                    break;
            }
        }
    }

    // ── Shared helpers (mirrors EpubService semantics) ───────────────────────

    private static string Sanitize(string body)
    {
        body = Regex.Replace(body, @"<(script|style|iframe|object|embed|link|meta)[^>]*>.*?</\1>", " ",
            RegexOptions.IgnoreCase | RegexOptions.Singleline);
        body = Regex.Replace(body, @"<(script|style|iframe|object|embed|link|meta)[^>]*/?>", " ", RegexOptions.IgnoreCase);
        body = Regex.Replace(body, @"\son\w+\s*=\s*(""[^""]*""|'[^']*'|\S+)", string.Empty, RegexOptions.IgnoreCase);
        body = Regex.Replace(body, @"(href|src)\s*=\s*(""[^""]*""|'[^']*'|[^\s>]+)", m =>
        {
            var val = m.Groups[2].Value.Trim('"', '\'', ' ');
            return val.StartsWith("javascript:", StringComparison.OrdinalIgnoreCase)
                ? m.Groups[1].Value + "=\"#\""
                : m.Value;
        }, RegexOptions.IgnoreCase);
        return body;
    }

    private static string RewriteUrls(string html, string baseDir, Guid itemId,
        Dictionary<string, int> spineByPath, string? apiKey)
    {
        var keySuffix = string.IsNullOrEmpty(apiKey) ? string.Empty : "&api_key=" + Uri.EscapeDataString(apiKey);
        return Regex.Replace(html, @"(href|src)=""([^""]+)""", m =>
        {
            var attr = m.Groups[1].Value;
            var url = m.Groups[2].Value;
            if (url.StartsWith("http", StringComparison.Ordinal) ||
                url.StartsWith("data:", StringComparison.Ordinal) ||
                url.StartsWith('#'))
                return m.Value;
            var urlNoAnchor = url.Contains('#') ? url[..url.IndexOf('#')] : url;
            var resolved = NormalizePath(baseDir + Uri.UnescapeDataString(urlNoAnchor));
            if (attr == "href" && spineByPath.TryGetValue(resolved, out var spineIdx))
            {
                var anchor = url.Contains('#') ? url[(url.IndexOf('#') + 1)..] : string.Empty;
                return $"href=\"#\" data-abr-chapter=\"{spineIdx}\" data-abr-anchor=\"{System.Net.WebUtility.HtmlEncode(anchor)}\"";
            }
            return $"{attr}=\"/A11yBookReader/resource/{itemId}?path={Uri.EscapeDataString(resolved)}{keySuffix}\"";
        });
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
        ".png" => "image/png",
        ".gif" => "image/gif",
        ".svg" => "image/svg+xml",
        ".css" => "text/css",
        ".xhtml" => "application/xhtml+xml",
        ".html" or ".htm" => "text/html",
        ".mp3" => "audio/mpeg",
        _ => "application/octet-stream",
    };

    private static string Escape(string s) =>
        s.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;").Replace("\"", "&quot;");
}
