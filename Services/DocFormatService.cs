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
/// Document formats (F1): FictionBook (.fb2), OpenDocument text and
/// presentations (.odt/.fodt/.odp/.fodp), Word and PowerPoint OOXML
/// (.docx/.docm/.pptx/.pptm), and RTF — presented through the same surface
/// as EpubService so TTS, search, bookmarks, highlights and settings work
/// unchanged. Office formats are text views only (no layout fidelity).
/// Entirely self-contained: XDocument + ZipArchive + the managed RtfPipe DLL.
/// </summary>
public class DocFormatService
{
    private static readonly string[] Extensions =
    {
        ".fb2", ".odt", ".fodt", ".odp", ".fodp",
        ".docx", ".docm", ".pptx", ".pptm", ".rtf",
    };

    private const int MaxChapterChars = 24_000;
    private const int MaxImageBytes = 1_500_000;

    private readonly ILibraryManager _libraryManager;
    private readonly ILogger<DocFormatService> _logger;
    private readonly ConcurrentDictionary<Guid, ParsedDoc?> _cache = new();

    public DocFormatService(ILibraryManager libraryManager, ILogger<DocFormatService> logger)
    {
        _libraryManager = libraryManager;
        _logger = logger;
    }

    private sealed class ParsedDoc
    {
        public string FilePath = string.Empty;
        public string Lang = "en";
        public List<DocChapter> Chapters = new();
    }

    private sealed class DocChapter
    {
        public string Title = string.Empty;
        public string BodyHtml = string.Empty;
        public string PlainText = string.Empty;
    }

    public static bool HandlesPath(string? path) =>
        path != null && Extensions.Any(e => path.EndsWith(e, StringComparison.OrdinalIgnoreCase));

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
        var lang = Escape(book.Lang);
        return "<!DOCTYPE html><html lang=\"" + lang + "\" xml:lang=\"" + lang
            + "\" xmlns=\"http://www.w3.org/1999/xhtml\"><head><meta charset=\"utf-8\"/><title>"
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

    /// <summary>Images are inlined as data: URIs — no packaged resources.</summary>
    public (Stream? Data, string ContentType) GetResource(Guid itemId, string path) => (null, string.Empty);

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

    // ── Parsing dispatch ─────────────────────────────────────────────────────

    private ParsedDoc? GetBook(Guid itemId)
    {
        return _cache.GetOrAdd(itemId, id =>
        {
            try { return Parse(id); }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to parse document {Id}", id);
                return null;
            }
        });
    }

    private ParsedDoc? Parse(Guid itemId)
    {
        var item = _libraryManager.GetItemById(itemId);
        var path = item?.Path;
        if (path == null || !HandlesPath(path) || !File.Exists(path)) return null;

        var ext = Path.GetExtension(path).ToLowerInvariant();
        var fallbackTitle = Path.GetFileNameWithoutExtension(path);
        var lang = "en";
        var sections = ext switch
        {
            ".fb2" => ParseFb2(path, fallbackTitle, ref lang),
            ".odt" or ".fodt" => ParseOdfText(path, ext == ".fodt", fallbackTitle),
            ".odp" or ".fodp" => ParseOdfPresentation(path, ext == ".fodp", fallbackTitle),
            ".docx" or ".docm" => ParseDocx(path, fallbackTitle),
            ".pptx" or ".pptm" => ParsePptx(path, fallbackTitle),
            ".rtf" => ParseRtf(path, fallbackTitle),
            _ => new List<Section>(),
        };

        var chapters = FinishSections(sections, fallbackTitle);
        if (chapters.Count == 0)
        {
            chapters.Add(new DocChapter { Title = fallbackTitle, BodyHtml = "<p>(no readable text)</p>", PlainText = string.Empty });
        }

        return new ParsedDoc { FilePath = path, Lang = lang, Chapters = chapters };
    }

    // ── Section accumulation (shared by every parser) ────────────────────────

    private sealed class Section
    {
        public string Title = string.Empty;
        public List<(string Html, string Plain)> Blocks = new();
    }

    /// <summary>Drop empty sections; split oversized ones at block boundaries.</summary>
    private static List<DocChapter> FinishSections(List<Section> sections, string fallbackTitle)
    {
        var outChapters = new List<DocChapter>();
        foreach (var s in sections)
        {
            // keep sections that carry text OR an inline image block
            if (s.Blocks.Count == 0 || s.Blocks.All(b => string.IsNullOrWhiteSpace(b.Plain) && !b.Html.Contains("img src", StringComparison.Ordinal)))
                continue;
            var title = string.IsNullOrWhiteSpace(s.Title) ? fallbackTitle : s.Title.Trim();
            var html = new StringBuilder();
            var plain = new StringBuilder();
            var size = 0;
            var part = 1;

            void Flush()
            {
                if (html.Length == 0) return;
                outChapters.Add(new DocChapter
                {
                    Title = part == 1 ? title : title + " · part " + part,
                    BodyHtml = html.ToString(),
                    PlainText = Regex.Replace(plain.ToString(), @"\s+", " ").Trim(),
                });
                html.Clear(); plain.Clear(); size = 0; part++;
            }

            foreach (var b in s.Blocks)
            {
                if (size + b.Plain.Length > MaxChapterChars && size > 0) Flush();
                html.Append(b.Html);
                plain.Append(b.Plain).Append(' ');
                size += b.Plain.Length;
            }

            Flush();
        }

        return outChapters;
    }

    // ── FictionBook 2 ────────────────────────────────────────────────────────

    private static List<Section> ParseFb2(string path, string fallbackTitle, ref string lang)
    {
        var doc = XDocument.Load(path, LoadOptions.None);
        var root = doc.Root!;

        // Book language from description/title-info/lang
        var langEl = root.Descendants().FirstOrDefault(e => e.Name.LocalName == "lang"
            && e.Parent?.Name.LocalName == "title-info");
        if (!string.IsNullOrWhiteSpace(langEl?.Value)) lang = langEl!.Value.Trim();

        // Binaries (images) by id → data URI
        var binaries = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var bin in root.Elements().Where(e => e.Name.LocalName == "binary"))
        {
            var id = (string?)bin.Attribute("id");
            var ctype = (string?)bin.Attribute("content-type") ?? "image/jpeg";
            var b64 = Regex.Replace(bin.Value, @"\s+", string.Empty);
            if (id != null && !string.IsNullOrEmpty(b64) && b64.Length * 3 / 4 <= MaxImageBytes && ctype.StartsWith("image/", StringComparison.OrdinalIgnoreCase))
                binaries["#" + id] = "data:" + ctype + ";base64," + b64;
        }

        var sections = new List<Section>();
        var bodies = root.Elements().Where(e => e.Name.LocalName == "body").ToList();
        foreach (var body in bodies)
        {
            var isNotes = string.Equals((string?)body.Attribute("name"), "notes", StringComparison.OrdinalIgnoreCase);
            var topSections = body.Elements().Where(e => e.Name.LocalName == "section").ToList();
            if (topSections.Count == 0)
            {
                // body without sections: render directly
                var s = new Section { Title = isNotes ? "Notes" : fallbackTitle };
                Fb2Render(body, s, binaries, 1);
                sections.Add(s);
                continue;
            }

            var n = 0;
            foreach (var sec in topSections)
            {
                n++;
                var s = new Section { Title = Fb2Title(sec) ?? (isNotes ? "Notes" : "Section " + n) };
                Fb2Render(sec, s, binaries, 1);
                sections.Add(s);
            }
        }

        return sections;
    }

    private static string? Fb2Title(XElement section)
    {
        var t = section.Elements().FirstOrDefault(e => e.Name.LocalName == "title");
        if (t == null) return null;
        var text = Regex.Replace(t.Value, @"\s+", " ").Trim();
        return string.IsNullOrWhiteSpace(text) ? null : text;
    }

    private static void Fb2Render(XElement el, Section s, Dictionary<string, string> binaries, int depth)
    {
        foreach (var child in el.Elements())
        {
            switch (child.Name.LocalName)
            {
                case "title":
                    var lvl = Math.Min(6, depth);
                    var titleText = Regex.Replace(child.Value, @"\s+", " ").Trim();
                    s.Blocks.Add(($"<h{lvl}>{Escape(titleText)}</h{lvl}>", titleText));
                    break;
                case "subtitle":
                    var sub = Regex.Replace(child.Value, @"\s+", " ").Trim();
                    s.Blocks.Add(($"<h{Math.Min(6, depth + 1)}>{Escape(sub)}</h{Math.Min(6, depth + 1)}>", sub));
                    break;
                case "p":
                case "v":
                case "text-author":
                    var inline = Fb2Inline(child, binaries);
                    var plain = Regex.Replace(child.Value, @"\s+", " ").Trim();
                    s.Blocks.Add(("<p>" + inline + "</p>", plain));
                    break;
                case "empty-line":
                    s.Blocks.Add(("<br/>", string.Empty));
                    break;
                case "epigraph":
                case "cite":
                case "poem":
                case "stanza":
                case "annotation":
                    s.Blocks.Add(("<blockquote>", string.Empty));
                    Fb2Render(child, s, binaries, depth);
                    s.Blocks.Add(("</blockquote>", string.Empty));
                    break;
                case "section":
                    Fb2Render(child, s, binaries, depth + 1);
                    break;
                case "image":
                    var href = child.Attributes().FirstOrDefault(a => a.Name.LocalName == "href")?.Value;
                    if (href != null && binaries.TryGetValue(href, out var data))
                        s.Blocks.Add(($"<p><img alt=\"Illustration\" src=\"{data}\"/></p>", string.Empty));
                    break;
            }
        }
    }

    private static string Fb2Inline(XElement p, Dictionary<string, string> binaries)
    {
        var sb = new StringBuilder();
        foreach (var node in p.Nodes())
        {
            if (node is XText t) { sb.Append(Escape(t.Value)); continue; }
            if (node is not XElement e) continue;
            switch (e.Name.LocalName)
            {
                case "emphasis": sb.Append("<em>").Append(Fb2Inline(e, binaries)).Append("</em>"); break;
                case "strong": sb.Append("<strong>").Append(Fb2Inline(e, binaries)).Append("</strong>"); break;
                case "strikethrough": sb.Append("<s>").Append(Fb2Inline(e, binaries)).Append("</s>"); break;
                case "sub": sb.Append("<sub>").Append(Fb2Inline(e, binaries)).Append("</sub>"); break;
                case "sup": sb.Append("<sup>").Append(Fb2Inline(e, binaries)).Append("</sup>"); break;
                case "code": sb.Append("<code>").Append(Fb2Inline(e, binaries)).Append("</code>"); break;
                case "image":
                    var href = e.Attributes().FirstOrDefault(a => a.Name.LocalName == "href")?.Value;
                    if (href != null && binaries.TryGetValue(href, out var data))
                        sb.Append($"<img alt=\"Inline illustration\" src=\"{data}\"/>");
                    break;
                default: sb.Append(Escape(e.Value)); break;
            }
        }

        return sb.ToString();
    }

    // ── OpenDocument (odt/fodt text, odp/fodp presentations) ────────────────

    private static XDocument LoadOdfContent(string path, bool flat)
    {
        if (flat) return XDocument.Load(path);
        using var za = ZipFile.OpenRead(path);
        var entry = za.GetEntry("content.xml") ?? throw new InvalidDataException("no content.xml");
        using var stream = entry.Open();
        return XDocument.Load(stream);
    }

    private static List<Section> ParseOdfText(string path, bool flat, string fallbackTitle)
    {
        var doc = LoadOdfContent(path, flat);
        var textRoot = doc.Descendants().FirstOrDefault(e => e.Name.LocalName == "text"
            && e.Parent?.Name.LocalName == "body");
        var sections = new List<Section>();
        var cur = new Section { Title = fallbackTitle };
        sections.Add(cur);
        if (textRoot == null) return sections;

        // Chapter break level: 1 when level-1 headings exist, else any heading
        var headings = textRoot.Descendants().Where(e => e.Name.LocalName == "h").ToList();
        var hasL1 = headings.Any(h => OdfOutlineLevel(h) <= 1);

        foreach (var el in textRoot.Elements())
        {
            switch (el.Name.LocalName)
            {
                case "h":
                    var level = OdfOutlineLevel(el);
                    var text = OdfPlain(el);
                    var breaks = !hasL1 || level <= 1;
                    if (breaks && !string.IsNullOrWhiteSpace(text))
                    {
                        cur = new Section { Title = text };
                        sections.Add(cur);
                    }

                    var hl = Math.Min(6, Math.Max(1, level));
                    cur.Blocks.Add(($"<h{hl}>{Escape(text)}</h{hl}>", text));
                    break;
                case "p":
                    var pt = OdfPlain(el);
                    cur.Blocks.Add(("<p>" + Escape(pt) + "</p>", pt));
                    break;
                case "list":
                    OdfList(el, cur);
                    break;
                case "table":
                    OdfTable(el, cur);
                    break;
            }
        }

        return sections;
    }

    private static int OdfOutlineLevel(XElement h)
    {
        var attr = h.Attributes().FirstOrDefault(a => a.Name.LocalName == "outline-level")?.Value;
        return int.TryParse(attr, out var l) ? l : 1;
    }

    private static string OdfPlain(XElement el)
    {
        // text:tab/text:line-break/text:s carry whitespace semantics
        var sb = new StringBuilder();
        foreach (var node in el.DescendantNodes())
        {
            if (node is XText t) sb.Append(t.Value);
            else if (node is XElement e && e.Name.LocalName is "tab" or "s" or "line-break") sb.Append(' ');
        }

        return Regex.Replace(sb.ToString(), @"\s+", " ").Trim();
    }

    private static void OdfList(XElement list, Section cur)
    {
        cur.Blocks.Add(("<ul>", string.Empty));
        foreach (var item in list.Elements().Where(e => e.Name.LocalName == "list-item"))
        {
            var text = OdfPlain(item);
            cur.Blocks.Add(("<li>" + Escape(text) + "</li>", text));
        }

        cur.Blocks.Add(("</ul>", string.Empty));
    }

    private static void OdfTable(XElement table, Section cur)
    {
        // First row renders as column headers (th scope=col) so screen
        // readers can associate cells with their columns
        cur.Blocks.Add(("<table>", string.Empty));
        var first = true;
        foreach (var row in table.Descendants().Where(e => e.Name.LocalName == "table-row"))
        {
            var open = first ? "<th scope=\"col\">" : "<td>";
            var close = first ? "</th>" : "</td>";
            var sb = new StringBuilder("<tr>");
            var plain = new StringBuilder();
            foreach (var cell in row.Elements().Where(e => e.Name.LocalName == "table-cell"))
            {
                var text = OdfPlain(cell);
                sb.Append(open).Append(Escape(text)).Append(close);
                plain.Append(text).Append(' ');
            }

            sb.Append("</tr>");
            cur.Blocks.Add((sb.ToString(), plain.ToString().Trim()));
            first = false;
        }

        cur.Blocks.Add(("</table>", string.Empty));
    }

    private static List<Section> ParseOdfPresentation(string path, bool flat, string fallbackTitle)
    {
        var doc = LoadOdfContent(path, flat);
        var sections = new List<Section>();
        var pages = doc.Descendants().Where(e => e.Name.LocalName == "page"
            && e.Name.NamespaceName.Contains("drawing", StringComparison.OrdinalIgnoreCase)).ToList();
        var n = 0;
        foreach (var page in pages)
        {
            n++;
            // Title frame: presentation:class="title"
            var title = page.Descendants()
                .Where(e => e.Name.LocalName == "frame"
                    && e.Attributes().Any(a => a.Name.LocalName == "class" && (a.Value == "title" || a.Value == "subtitle")))
                .Select(OdfPlain)
                .FirstOrDefault(t => !string.IsNullOrWhiteSpace(t));
            var s = new Section { Title = "Slide " + n + (string.IsNullOrWhiteSpace(title) ? string.Empty : ": " + title) };
            s.Blocks.Add(($"<h1>{Escape(s.Title)}</h1>", s.Title));
            foreach (var p in page.Descendants().Where(e => e.Name.LocalName == "p"))
            {
                var text = OdfPlain(p);
                if (string.IsNullOrWhiteSpace(text) || text == title) continue;
                s.Blocks.Add(("<p>" + Escape(text) + "</p>", text));
            }

            sections.Add(s);
        }

        return sections;
    }

    // ── OOXML Word ───────────────────────────────────────────────────────────

    private static List<Section> ParseDocx(string path, string fallbackTitle)
    {
        using var za = ZipFile.OpenRead(path);
        var entry = za.GetEntry("word/document.xml") ?? throw new InvalidDataException("no word/document.xml");
        XDocument doc;
        using (var stream = entry.Open()) doc = XDocument.Load(stream);

        var body = doc.Descendants().FirstOrDefault(e => e.Name.LocalName == "body");
        var sections = new List<Section>();
        var cur = new Section { Title = fallbackTitle };
        sections.Add(cur);
        if (body == null) return sections;

        bool inList = false;
        void CloseList() { if (inList) { cur.Blocks.Add(("</ul>", string.Empty)); inList = false; } }

        foreach (var el in body.Elements())
        {
            if (el.Name.LocalName == "p")
            {
                var style = el.Descendants().FirstOrDefault(e => e.Name.LocalName == "pStyle")
                    ?.Attributes().FirstOrDefault(a => a.Name.LocalName == "val")?.Value ?? string.Empty;
                var text = DocxPlain(el);
                var hMatch = Regex.Match(style, @"^[Hh]eading(\d)$");
                if (hMatch.Success)
                {
                    CloseList();
                    var lvl = Math.Min(6, int.Parse(hMatch.Groups[1].Value));
                    if (lvl == 1 && !string.IsNullOrWhiteSpace(text))
                    {
                        cur = new Section { Title = text };
                        sections.Add(cur);
                    }

                    if (!string.IsNullOrWhiteSpace(text))
                        cur.Blocks.Add(($"<h{lvl}>{Escape(text)}</h{lvl}>", text));
                    continue;
                }

                var isListItem = el.Descendants().Any(e => e.Name.LocalName == "numPr");
                if (isListItem && !string.IsNullOrWhiteSpace(text))
                {
                    if (!inList) { cur.Blocks.Add(("<ul>", string.Empty)); inList = true; }
                    cur.Blocks.Add(("<li>" + Escape(text) + "</li>", text));
                    continue;
                }

                CloseList();
                if (!string.IsNullOrWhiteSpace(text))
                    cur.Blocks.Add(("<p>" + Escape(text) + "</p>", text));
            }
            else if (el.Name.LocalName == "tbl")
            {
                CloseList();
                cur.Blocks.Add(("<table>", string.Empty));
                var first = true;
                foreach (var row in el.Elements().Where(e => e.Name.LocalName == "tr"))
                {
                    var open = first ? "<th scope=\"col\">" : "<td>";
                    var close = first ? "</th>" : "</td>";
                    var sb = new StringBuilder("<tr>");
                    var plain = new StringBuilder();
                    foreach (var cell in row.Elements().Where(e => e.Name.LocalName == "tc"))
                    {
                        var text = string.Join(" ", cell.Elements().Where(e => e.Name.LocalName == "p").Select(DocxPlain));
                        sb.Append(open).Append(Escape(text)).Append(close);
                        plain.Append(text).Append(' ');
                    }

                    sb.Append("</tr>");
                    cur.Blocks.Add((sb.ToString(), plain.ToString().Trim()));
                    first = false;
                }

                cur.Blocks.Add(("</table>", string.Empty));
            }
        }

        CloseList();
        return sections;
    }

    private static string DocxPlain(XElement p)
    {
        var sb = new StringBuilder();
        foreach (var node in p.Descendants())
        {
            if (node.Name.LocalName == "t") sb.Append(node.Value);
            else if (node.Name.LocalName is "tab" or "br" or "cr") sb.Append(' ');
        }

        return Regex.Replace(sb.ToString(), @"\s+", " ").Trim();
    }

    // ── OOXML PowerPoint ─────────────────────────────────────────────────────

    private static List<Section> ParsePptx(string path, string fallbackTitle)
    {
        using var za = ZipFile.OpenRead(path);

        // Slide order: presentation.xml sldIdLst r:id order → rels target
        var slidePaths = new List<string>();
        var relsEntry = za.GetEntry("ppt/_rels/presentation.xml.rels");
        var presEntry = za.GetEntry("ppt/presentation.xml");
        if (relsEntry != null && presEntry != null)
        {
            XDocument rels, pres;
            using (var s = relsEntry.Open()) rels = XDocument.Load(s);
            using (var s = presEntry.Open()) pres = XDocument.Load(s);
            var relMap = rels.Descendants().Where(e => e.Name.LocalName == "Relationship")
                .ToDictionary(
                    e => (string?)e.Attribute("Id") ?? string.Empty,
                    e => (string?)e.Attribute("Target") ?? string.Empty);
            foreach (var sldId in pres.Descendants().Where(e => e.Name.LocalName == "sldId"))
            {
                var rid = sldId.Attributes().FirstOrDefault(a => a.Name.LocalName == "id" && a.Name.NamespaceName.Length > 0)?.Value;
                if (rid != null && relMap.TryGetValue(rid, out var target))
                    slidePaths.Add("ppt/" + target.TrimStart('/').Replace("../", string.Empty));
            }
        }

        if (slidePaths.Count == 0)
        {
            slidePaths = za.Entries
                .Where(e => Regex.IsMatch(e.FullName, @"^ppt/slides/slide\d+\.xml$"))
                .OrderBy(e => int.Parse(Regex.Match(e.FullName, @"(\d+)\.xml$").Groups[1].Value))
                .Select(e => e.FullName).ToList();
        }

        var sections = new List<Section>();
        var n = 0;
        foreach (var slidePath in slidePaths)
        {
            var entry = za.GetEntry(slidePath);
            if (entry == null) continue;
            n++;
            XDocument slide;
            using (var s = entry.Open()) slide = XDocument.Load(s);

            string? title = null;
            var bodyTexts = new List<string>();
            foreach (var sp in slide.Descendants().Where(e => e.Name.LocalName == "sp"))
            {
                var phType = sp.Descendants().FirstOrDefault(e => e.Name.LocalName == "ph")
                    ?.Attributes().FirstOrDefault(a => a.Name.LocalName == "type")?.Value;
                var paras = sp.Descendants().Where(e => e.Name.LocalName == "p" && e.Name.NamespaceName.Contains("drawingml", StringComparison.OrdinalIgnoreCase))
                    .Select(p => Regex.Replace(string.Concat(
                        p.Descendants().Where(t => t.Name.LocalName == "t").Select(t => t.Value)), @"\s+", " ").Trim())
                    .Where(t => t.Length > 0)
                    .ToList();
                if (paras.Count == 0) continue;
                if (title == null && phType is "title" or "ctrTitle") title = string.Join(" ", paras);
                else bodyTexts.AddRange(paras);
            }

            var sec = new Section { Title = "Slide " + n + (title != null ? ": " + title : string.Empty) };
            sec.Blocks.Add(($"<h1>{Escape(sec.Title)}</h1>", sec.Title));
            foreach (var t in bodyTexts) sec.Blocks.Add(("<p>" + Escape(t) + "</p>", t));
            sections.Add(sec);
        }

        return sections;
    }

    // ── RTF ──────────────────────────────────────────────────────────────────

    private List<Section> ParseRtf(string path, string fallbackTitle)
    {
        var rtf = File.ReadAllText(path);
        var html = RtfPipe.Rtf.ToHtml(rtf);

        // Sanitize with the same rules as single-file HTML, then split into
        // blocks at element boundaries so the size splitter has seams
        html = Regex.Replace(html, @"<(script|style|iframe|object|embed|link|meta)[^>]*>.*?</\1>", " ",
            RegexOptions.IgnoreCase | RegexOptions.Singleline);
        html = Regex.Replace(html, @"<(script|style|iframe|object|embed|link|meta)[^>]*/?>", " ", RegexOptions.IgnoreCase);
        html = Regex.Replace(html, @"\son\w+\s*=\s*(""[^""]*""|'[^']*'|\S+)", string.Empty, RegexOptions.IgnoreCase);

        var s = new Section { Title = fallbackTitle };
        foreach (var piece in Regex.Split(html, @"(?<=</p>|</h[1-6]>|</li>|</div>|<br\s*/?>)"))
        {
            if (string.IsNullOrWhiteSpace(piece)) continue;
            var plain = Regex.Replace(System.Net.WebUtility.HtmlDecode(Regex.Replace(piece, "<[^>]+>", " ")), @"\s+", " ").Trim();
            s.Blocks.Add((piece, plain));
        }

        return new List<Section> { s };
    }

    private static string Escape(string s) =>
        s.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;").Replace("\"", "&quot;");
}
