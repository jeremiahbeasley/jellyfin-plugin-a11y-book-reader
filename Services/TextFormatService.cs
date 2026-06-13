using System.Collections.Concurrent;
using System.Text;
using System.Text.RegularExpressions;
using Jellyfin.Plugin.A11yBookReader.Models;
using MediaBrowser.Controller.Library;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.A11yBookReader.Services;

/// <summary>
/// Tier-1 text formats (.txt, .md, .html/.htm) presented through the same
/// surface as EpubService: chapters of XHTML that every downstream feature
/// (TTS, search, bookmarks, highlights, settings) consumes unchanged.
/// </summary>
public class TextFormatService
{
    private static readonly string[] Extensions = { ".txt", ".md", ".markdown", ".html", ".htm", ".xml" };

    // Chapters bigger than this get split at a paragraph boundary so huge
    // plain-text files stay navigable (and paged layout stays responsive).
    private const int MaxChapterChars = 24_000;

    private readonly ILibraryManager _libraryManager;
    private readonly ILogger<TextFormatService> _logger;
    private readonly ConcurrentDictionary<Guid, ParsedTextBook?> _cache = new();

    public TextFormatService(ILibraryManager libraryManager, ILogger<TextFormatService> logger)
    {
        _libraryManager = libraryManager;
        _logger = logger;
    }

    private sealed class ParsedTextBook
    {
        public string FilePath = string.Empty;
        public List<TextChapter> Chapters = new();
    }

    private sealed class TextChapter
    {
        public string Title = string.Empty;
        public string BodyHtml = string.Empty;   // inner-body XHTML
        public string PlainText = string.Empty;  // for search
    }

    public static bool HandlesPath(string? path) =>
        path != null && Extensions.Any(e => path.EndsWith(e, StringComparison.OrdinalIgnoreCase));

    /// <summary>Whether this service owns the item (by file extension).</summary>
    public bool Handles(Guid itemId)
    {
        var item = _libraryManager.GetItemById(itemId);
        return HandlesPath(item?.Path);
    }

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
                ZipPath = "chapter-" + i,
                MimeType = "application/xhtml+xml",
            }).ToList(),
        };
    }

    public string? GetChapterHtml(Guid itemId, int index, string? apiKey = null)
    {
        var book = GetBook(itemId);
        if (book == null || index < 0 || index >= book.Chapters.Count) return null;
        var c = book.Chapters[index];
        return "<!DOCTYPE html><html xmlns=\"http://www.w3.org/1999/xhtml\"><head><meta charset=\"utf-8\"/><title>"
            + Escape(c.Title) + "</title></head><body>" + c.BodyHtml + "</body></html>";
    }

    public BookNavigation? GetNavigation(Guid itemId)
    {
        var book = GetBook(itemId);
        if (book == null) return null;
        return new BookNavigation
        {
            Toc = book.Chapters.Select((c, i) => new NavNode { Title = c.Title, Chapter = i }).ToList(),
            TocGenerated = true,
        };
    }

    /// <summary>No packaged resources in plain-text formats.</summary>
    public (Stream? Data, string ContentType) GetResource(Guid itemId, string path) => (null, string.Empty);

    // Same scan/snippet semantics as the EPUB search so the client treats hits
    // identically (quote relocation, ordinals).
    public SearchResults Search(Guid itemId, string query, int cap = 200)
    {
        var results = new SearchResults();
        var book = GetBook(itemId);
        if (book == null || string.IsNullOrWhiteSpace(query)) return results;
        var needle = query.Trim();

        for (var ci = 0; ci < book.Chapters.Count; ci++)
        {
            var text = book.Chapters[ci].PlainText;
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
                        ChapterTitle = book.Chapters[ci].Title,
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

    private ParsedTextBook? GetBook(Guid itemId)
    {
        return _cache.GetOrAdd(itemId, id =>
        {
            try { return Parse(id); }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to parse text-format book {Id}", id);
                return null;
            }
        });
    }

    private ParsedTextBook? Parse(Guid itemId)
    {
        var item = _libraryManager.GetItemById(itemId);
        var path = item?.Path;
        if (path == null || !HandlesPath(path) || !File.Exists(path)) return null;

        // BOM-aware read, UTF-8 default
        string raw;
        using (var reader = new StreamReader(path, Encoding.UTF8, detectEncodingFromByteOrderMarks: true))
            raw = reader.ReadToEnd();

        var ext = Path.GetExtension(path).ToLowerInvariant();
        var fallbackTitle = Path.GetFileNameWithoutExtension(path);
        var chapters = ext switch
        {
            ".md" or ".markdown" => ParseMarkdown(raw, fallbackTitle),
            ".html" or ".htm" => ParseHtml(raw, fallbackTitle),
            ".xml" => ParseXml(raw, fallbackTitle),
            _ => ParseTxt(raw, fallbackTitle),
        };
        if (chapters.Count == 0)
        {
            chapters.Add(new TextChapter { Title = fallbackTitle, BodyHtml = "<p>(empty file)</p>", PlainText = string.Empty });
        }

        return new ParsedTextBook { FilePath = path, Chapters = chapters };
    }

    // ── Plain text ───────────────────────────────────────────────────────────

    private static readonly Regex ChapterHeading = new(
        @"^\s*((chapter|part|book|section)\b[\s.:\-]*([0-9]+|[ivxlcdm]+|[a-z])?\b.*|[IVXLCDM]+\.?)\s*$",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private static List<TextChapter> ParseTxt(string raw, string fallbackTitle)
    {
        var paragraphs = Regex.Split(raw.Replace("\r\n", "\n"), @"\n\s*\n")
            .Select(p => Regex.Replace(p.Trim(), @"\s*\n\s*", " "))
            .Where(p => p.Length > 0)
            .ToList();

        var chapters = new List<TextChapter>();
        var bodyParas = new List<string>();
        var title = fallbackTitle;
        var size = 0;
        var partN = 1;

        void Flush(string nextTitle)
        {
            if (bodyParas.Count > 0)
            {
                chapters.Add(MakeChapter(title, bodyParas));
                bodyParas = new List<string>();
            }
            title = nextTitle;
            size = 0;
        }

        foreach (var p in paragraphs)
        {
            // Heading-like: short single line matching a chapter pattern
            if (p.Length <= 80 && ChapterHeading.IsMatch(p))
            {
                Flush(p);
                continue;
            }
            if (size + p.Length > MaxChapterChars && bodyParas.Count > 0)
            {
                partN++;
                Flush(title.Length > 0 ? fallbackTitle + " · part " + partN : fallbackTitle);
            }
            bodyParas.Add(p);
            size += p.Length;
        }

        Flush(string.Empty);
        return chapters;
    }

    private static TextChapter MakeChapter(string title, List<string> paragraphs)
    {
        var sb = new StringBuilder();
        if (!string.IsNullOrWhiteSpace(title)) sb.Append("<h1>").Append(Escape(title)).Append("</h1>");
        foreach (var p in paragraphs) sb.Append("<p>").Append(Escape(p)).Append("</p>");
        return new TextChapter
        {
            Title = string.IsNullOrWhiteSpace(title) ? "Text" : title.Trim(),
            BodyHtml = sb.ToString(),
            PlainText = (title + " " + string.Join(" ", paragraphs)).Trim(),
        };
    }

    // ── Markdown (deliberately small: the constructs books actually use) ─────

    private static List<TextChapter> ParseMarkdown(string raw, string fallbackTitle)
    {
        var lines = raw.Replace("\r\n", "\n").Split('\n');
        var sections = new List<(string Title, List<string> Lines)> { (fallbackTitle, new List<string>()) };

        foreach (var line in lines)
        {
            var h = Regex.Match(line, @"^(#{1,2})\s+(.+)$");
            if (h.Success)
            {
                // New chapter at every H1/H2 (but reuse the implicit first
                // section if it holds no content yet)
                if (sections[^1].Lines.All(string.IsNullOrWhiteSpace))
                    sections[^1] = (h.Groups[2].Value.Trim(), sections[^1].Lines);
                else
                    sections.Add((h.Groups[2].Value.Trim(), new List<string>()));
                sections[^1].Lines.Add(line);
                continue;
            }
            sections[^1].Lines.Add(line);
        }

        return sections
            .Where(s => s.Lines.Any(l => !string.IsNullOrWhiteSpace(l)))
            .Select(s => new TextChapter
            {
                Title = s.Title,
                BodyHtml = MarkdownToHtml(string.Join("\n", s.Lines)),
                PlainText = Regex.Replace(
                    System.Net.WebUtility.HtmlDecode(Regex.Replace(MarkdownToHtml(string.Join("\n", s.Lines)), "<[^>]+>", " ")),
                    @"\s+", " ").Trim(),
            })
            .ToList();
    }

    private static string MarkdownToHtml(string md)
    {
        var sb = new StringBuilder();
        var lines = md.Split('\n');
        bool inCode = false, inUl = false, inOl = false, inQuote = false, inPara = false;

        void CloseBlocks()
        {
            if (inPara) { sb.Append("</p>"); inPara = false; }
            if (inUl) { sb.Append("</ul>"); inUl = false; }
            if (inOl) { sb.Append("</ol>"); inOl = false; }
            if (inQuote) { sb.Append("</blockquote>"); inQuote = false; }
        }

        foreach (var rawLine in lines)
        {
            var line = rawLine;

            if (line.TrimStart().StartsWith("```", StringComparison.Ordinal))
            {
                if (inCode) { sb.Append("</pre>"); inCode = false; }
                else { CloseBlocks(); sb.Append("<pre>"); inCode = true; }
                continue;
            }
            if (inCode) { sb.Append(Escape(line)).Append('\n'); continue; }

            var h = Regex.Match(line, @"^(#{1,6})\s+(.+)$");
            if (h.Success)
            {
                CloseBlocks();
                var lvl = h.Groups[1].Value.Length;
                sb.Append("<h").Append(lvl).Append('>').Append(Inline(h.Groups[2].Value)).Append("</h").Append(lvl).Append('>');
                continue;
            }
            if (Regex.IsMatch(line, @"^\s*([-*_])\s*\1\s*\1[\s\-*_]*$")) { CloseBlocks(); sb.Append("<hr/>"); continue; }

            var ul = Regex.Match(line, @"^\s*[-*+]\s+(.+)$");
            if (ul.Success)
            {
                if (inPara) { sb.Append("</p>"); inPara = false; }
                if (inOl) { sb.Append("</ol>"); inOl = false; }
                if (!inUl) { sb.Append("<ul>"); inUl = true; }
                sb.Append("<li>").Append(Inline(ul.Groups[1].Value)).Append("</li>");
                continue;
            }
            var ol = Regex.Match(line, @"^\s*\d+[.)]\s+(.+)$");
            if (ol.Success)
            {
                if (inPara) { sb.Append("</p>"); inPara = false; }
                if (inUl) { sb.Append("</ul>"); inUl = false; }
                if (!inOl) { sb.Append("<ol>"); inOl = true; }
                sb.Append("<li>").Append(Inline(ol.Groups[1].Value)).Append("</li>");
                continue;
            }
            var q = Regex.Match(line, @"^\s*>\s?(.*)$");
            if (q.Success)
            {
                if (inPara) { sb.Append("</p>"); inPara = false; }
                if (!inQuote) { sb.Append("<blockquote>"); inQuote = true; }
                sb.Append(Inline(q.Groups[1].Value)).Append(' ');
                continue;
            }
            if (string.IsNullOrWhiteSpace(line)) { CloseBlocks(); continue; }

            if (inQuote) { sb.Append("</blockquote>"); inQuote = false; }
            if (!inPara && !inUl && !inOl) { sb.Append("<p>"); inPara = true; }
            sb.Append(Inline(line)).Append(' ');
        }

        if (inCode) sb.Append("</pre>");
        CloseBlocks();
        return sb.ToString();
    }

    /// <summary>Inline markdown on an UNESCAPED source line: escape first, then transform.</summary>
    private static string Inline(string text)
    {
        var s = Escape(text);
        s = Regex.Replace(s, @"!\[([^\]]*)\]\(([^)\s]+)\)", m =>
            IsSafeUrl(m.Groups[2].Value) ? "<img alt=\"" + m.Groups[1].Value + "\" src=\"" + m.Groups[2].Value + "\"/>" : m.Groups[1].Value);
        s = Regex.Replace(s, @"\[([^\]]+)\]\(([^)\s]+)\)", m =>
            IsSafeUrl(m.Groups[2].Value) ? "<a href=\"" + m.Groups[2].Value + "\">" + m.Groups[1].Value + "</a>" : m.Groups[1].Value);
        s = Regex.Replace(s, @"\*\*([^*]+)\*\*", "<strong>$1</strong>");
        s = Regex.Replace(s, @"(?<!\*)\*([^*\s][^*]*)\*(?!\*)", "<em>$1</em>");
        s = Regex.Replace(s, "`([^`]+)`", "<code>$1</code>");
        return s;
    }

    private static bool IsSafeUrl(string url) =>
        url.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ||
        url.StartsWith("https://", StringComparison.OrdinalIgnoreCase);

    // ── HTML (single file) ───────────────────────────────────────────────────

    private static List<TextChapter> ParseHtml(string raw, string fallbackTitle)
    {
        var bodyMatch = Regex.Match(raw, @"<body[^>]*>(.*)</body>", RegexOptions.IgnoreCase | RegexOptions.Singleline);
        var body = bodyMatch.Success ? bodyMatch.Groups[1].Value : raw;

        // Sanitize: no scripts/styles/iframes/objects, no inline handlers, no
        // javascript: URLs. The result renders inside the reader's iframe with
        // the same trust level as EPUB chapter content.
        body = Regex.Replace(body, @"<(script|style|iframe|object|embed|link|meta)[^>]*>.*?</\1>", " ",
            RegexOptions.IgnoreCase | RegexOptions.Singleline);
        body = Regex.Replace(body, @"<(script|style|iframe|object|embed|link|meta)[^>]*/?>", " ", RegexOptions.IgnoreCase);
        body = Regex.Replace(body, @"\son\w+\s*=\s*(""[^""]*""|'[^']*'|\S+)", string.Empty, RegexOptions.IgnoreCase);
        // Quote-aware: a backreference pattern breaks when the URL itself
        // contains the other quote character (javascript:alert('x'))
        body = Regex.Replace(body, @"(href|src)\s*=\s*(""[^""]*""|'[^']*'|[^\s>]+)", m =>
        {
            var val = m.Groups[2].Value.Trim('"', '\'', ' ');
            return val.StartsWith("javascript:", StringComparison.OrdinalIgnoreCase)
                ? m.Groups[1].Value + "=\"#\""
                : m.Value;
        }, RegexOptions.IgnoreCase);

        var titleMatch = Regex.Match(raw, @"<title[^>]*>(.*?)</title>", RegexOptions.IgnoreCase | RegexOptions.Singleline);
        var title = titleMatch.Success && !string.IsNullOrWhiteSpace(titleMatch.Groups[1].Value)
            ? System.Net.WebUtility.HtmlDecode(titleMatch.Groups[1].Value.Trim())
            : fallbackTitle;

        var plain = Regex.Replace(System.Net.WebUtility.HtmlDecode(Regex.Replace(body, "<[^>]+>", " ")), @"\s+", " ").Trim();
        return new List<TextChapter>
        {
            new() { Title = title, BodyHtml = body, PlainText = plain },
        };
    }

    // ── Generic XML documents ────────────────────────────────────────────────
    // Rendered as a readable hierarchy: element names become headings/labels,
    // text content becomes paragraphs. Top-level children become chapters
    // when the document is large enough to need navigation.

    private static List<TextChapter> ParseXml(string raw, string fallbackTitle)
    {
        System.Xml.Linq.XDocument doc;
        try { doc = System.Xml.Linq.XDocument.Parse(raw); }
        catch
        {
            // Not well-formed: fall back to plain text so the file still opens
            return ParseTxt(raw, fallbackTitle);
        }

        var root = doc.Root;
        if (root == null) return ParseTxt(raw, fallbackTitle);

        var topChildren = root.Elements().ToList();
        var useChildrenAsChapters = topChildren.Count > 1 && raw.Length > MaxChapterChars;

        var chapters = new List<TextChapter>();
        if (useChildrenAsChapters)
        {
            var n = 0;
            foreach (var child in topChildren)
            {
                n++;
                var sb = new StringBuilder();
                var plain = new StringBuilder();
                XmlRender(child, sb, plain, 2);
                chapters.Add(new TextChapter
                {
                    Title = Humanize(child.Name.LocalName) + " " + n,
                    BodyHtml = "<h1>" + Escape(Humanize(child.Name.LocalName)) + "</h1>" + sb,
                    PlainText = Regex.Replace(plain.ToString(), @"\s+", " ").Trim(),
                });
            }
        }
        else
        {
            var sb = new StringBuilder();
            var plain = new StringBuilder();
            XmlRender(root, sb, plain, 2);
            chapters.Add(new TextChapter
            {
                Title = fallbackTitle,
                BodyHtml = "<h1>" + Escape(Humanize(root.Name.LocalName)) + "</h1>" + sb,
                PlainText = Regex.Replace(plain.ToString(), @"\s+", " ").Trim(),
            });
        }

        return chapters;
    }

    private static void XmlRender(System.Xml.Linq.XElement el, StringBuilder sb, StringBuilder plain, int depth)
    {
        foreach (var node in el.Nodes())
        {
            if (node is System.Xml.Linq.XText t)
            {
                var text = Regex.Replace(t.Value, @"\s+", " ").Trim();
                if (text.Length == 0) continue;
                sb.Append("<p>").Append(Escape(text)).Append("</p>");
                plain.Append(text).Append(' ');
            }
            else if (node is System.Xml.Linq.XElement child)
            {
                var hasElementChildren = child.Elements().Any();
                var text = hasElementChildren ? null : Regex.Replace(child.Value, @"\s+", " ").Trim();
                if (hasElementChildren)
                {
                    var lvl = Math.Min(6, depth);
                    var name = Humanize(child.Name.LocalName);
                    sb.Append("<h").Append(lvl).Append('>').Append(Escape(name)).Append("</h").Append(lvl).Append('>');
                    plain.Append(name).Append(' ');
                    XmlRender(child, sb, plain, depth + 1);
                }
                else if (!string.IsNullOrEmpty(text))
                {
                    var name = Humanize(child.Name.LocalName);
                    sb.Append("<p><strong>").Append(Escape(name)).Append(":</strong> ").Append(Escape(text)).Append("</p>");
                    plain.Append(name).Append(' ').Append(text).Append(' ');
                }
            }
        }
    }

    private static string Humanize(string name) =>
        Regex.Replace(Regex.Replace(name, "([a-z0-9])([A-Z])", "$1 $2"), "[_-]+", " ").Trim();

    private static string Escape(string s) =>
        s.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;").Replace("\"", "&quot;");
}
