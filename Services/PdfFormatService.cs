using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Jellyfin.Plugin.A11yBookReader.Models;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.Library;
using Microsoft.Extensions.Logging;
using UglyToad.PdfPig;
using UglyToad.PdfPig.Content;
using UglyToad.PdfPig.DocumentLayoutAnalysis.TextExtractor;

namespace Jellyfin.Plugin.A11yBookReader.Services;

/// <summary>
/// Reflowed reading for PDFs through the shared format surface. Tagged PDFs
/// reflow from their marked-content structure (paragraphs, headings, lists,
/// figure alt text) with page furniture excluded via Artifact marks — the
/// accessibility payoff of tagged PDF. Untagged PDFs fall back to
/// content-order text extraction with a visible notice. Extraction is
/// expensive on big files, so results persist in a disk cache keyed by the
/// file's identity.
/// </summary>
public class PdfFormatService
{
    // Chapter detection ladder: H1 tags → CHAPTER-pattern artifact headers →
    // fixed page chunks as the floor.
    private const int FallbackPagesPerChapter = 15;
    private const int SafetyPagesPerChapter = 60;
    private static readonly Regex ChapterHeader = new(
        @"^\s*(chapter|part|unit|appendix)\s+([0-9]+|[ivxlcdm]+|[a-z])\b",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private readonly ILibraryManager _libraryManager;
    private readonly ILogger<PdfFormatService> _logger;
    private readonly string _cacheDir;
    private readonly ConcurrentDictionary<Guid, ParsedPdf?> _cache = new();

    public PdfFormatService(ILibraryManager libraryManager, IApplicationPaths appPaths, ILogger<PdfFormatService> logger)
    {
        _libraryManager = libraryManager;
        _logger = logger;
        _cacheDir = Path.Combine(appPaths.DataPath, "a11ybookreader", "pdfcache");
        Directory.CreateDirectory(_cacheDir);
    }

    /// <summary>Cached extraction result (JSON-serializable for the disk cache).</summary>
    public sealed class ParsedPdf
    {
        public string FilePath { get; set; } = string.Empty;
        public bool Tagged { get; set; }
        public int PageCount { get; set; }
        public List<PdfChapter> Chapters { get; set; } = new();
        public List<PdfPageRef> Pages { get; set; } = new();
    }

    public sealed class PdfChapter
    {
        public string Title { get; set; } = string.Empty;
        public string BodyHtml { get; set; } = string.Empty;
        public string PlainText { get; set; } = string.Empty;
        public int FirstPage { get; set; }

        /// <summary>Started from real structure (heading/chapter mark) — only these appear in the TOC.</summary>
        public bool Titled { get; set; }
    }

    public sealed class PdfPageRef
    {
        public int Page { get; set; }
        public int Chapter { get; set; }
    }

    public static bool HandlesPath(string? path) =>
        path != null && path.EndsWith(".pdf", StringComparison.OrdinalIgnoreCase);

    public bool Handles(Guid itemId)
    {
        var item = _libraryManager.GetItemById(itemId);
        return HandlesPath(item?.Path);
    }

    // ── Shared format surface ────────────────────────────────────────────────

    public ParsedEpub? GetParsed(Guid itemId)
    {
        var pdf = GetBook(itemId);
        if (pdf == null) return null;
        return new ParsedEpub
        {
            FilePath = pdf.FilePath,
            Spine = pdf.Chapters.Select((c, i) => new SpineItem
            {
                Index = i,
                Title = c.Title,
                ZipPath = "pdf-" + i,
                MimeType = "application/xhtml+xml",
            }).ToList(),
        };
    }

    public string? GetChapterHtml(Guid itemId, int index, string? apiKey = null)
    {
        var pdf = GetBook(itemId);
        if (pdf == null || index < 0 || index >= pdf.Chapters.Count) return null;
        var c = pdf.Chapters[index];
        return "<!DOCTYPE html><html xmlns=\"http://www.w3.org/1999/xhtml\"><head><meta charset=\"utf-8\"/><title>"
            + Escape(c.Title) + "</title></head><body>" + c.BodyHtml + "</body></html>";
    }

    public BookNavigation? GetNavigation(Guid itemId)
    {
        var pdf = GetBook(itemId);
        if (pdf == null) return null;
        // Clean TOC: only chapters that earned a real title; the page-range
        // and continuation segments stay reachable by paging and go-to-page
        var anyTitled = pdf.Chapters.Any(c => c.Titled);
        var nav = new BookNavigation
        {
            Toc = pdf.Chapters
                .Select((c, i) => (c, i))
                .Where(t => !anyTitled || t.c.Titled)
                .Select(t => new NavNode { Title = t.c.Title, Chapter = t.i })
                .ToList(),
            TocGenerated = true,
            PageList = pdf.Pages.Select(p => new NavNode
            {
                Title = p.Page.ToString(),
                Chapter = p.Chapter,
                Anchor = "pg-" + p.Page,
            }).ToList(),
        };
        return nav;
    }

    public (Stream? Data, string ContentType) GetResource(Guid itemId, string path) => (null, string.Empty);

    public SearchResults Search(Guid itemId, string query, int cap = 200)
    {
        var results = new SearchResults();
        var pdf = GetBook(itemId);
        if (pdf == null || string.IsNullOrWhiteSpace(query)) return results;
        var needle = query.Trim();

        for (var ci = 0; ci < pdf.Chapters.Count; ci++)
        {
            var text = pdf.Chapters[ci].PlainText;
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
                        ChapterTitle = pdf.Chapters[ci].Title,
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

    // ── Extraction ───────────────────────────────────────────────────────────

    private ParsedPdf? GetBook(Guid itemId)
    {
        return _cache.GetOrAdd(itemId, id =>
        {
            try { return LoadOrExtract(id); }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to extract PDF for item {Id}", id);
                return null;
            }
        });
    }

    private ParsedPdf? LoadOrExtract(Guid itemId)
    {
        var path = _libraryManager.GetItemById(itemId)?.Path;
        if (path == null || !HandlesPath(path) || !File.Exists(path)) return null;

        var fi = new FileInfo(path);
        var key = Convert.ToHexString(System.Security.Cryptography.SHA1.HashData(
            Encoding.UTF8.GetBytes(path + "|" + fi.LastWriteTimeUtc.Ticks + "|" + fi.Length + "|v3")));
        var cacheFile = Path.Combine(_cacheDir, key + ".json");

        if (File.Exists(cacheFile))
        {
            try
            {
                var cached = JsonSerializer.Deserialize<ParsedPdf>(File.ReadAllText(cacheFile));
                if (cached != null && cached.Chapters.Count > 0) return cached;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Bad PDF cache entry {File}; re-extracting", cacheFile);
            }
        }

        _logger.LogInformation("Extracting PDF (first open): {Path}", path);
        var sw = System.Diagnostics.Stopwatch.StartNew();
        var parsed = Extract(path);
        _logger.LogInformation("PDF extraction finished in {Ms}ms: {Pages} pages, {Chapters} chapters, tagged={Tagged}",
            sw.ElapsedMilliseconds, parsed.PageCount, parsed.Chapters.Count, parsed.Tagged);

        try
        {
            var tmp = cacheFile + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(parsed));
            File.Move(tmp, cacheFile, overwrite: true);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Could not persist PDF cache {File}", cacheFile);
        }

        return parsed;
    }

    private ParsedPdf Extract(string path)
    {
        using var doc = PdfDocument.Open(path);
        var result = new ParsedPdf { FilePath = path, PageCount = doc.NumberOfPages };

        // Tagged when the catalog says Marked; verified per page by whether
        // marked content with real (non-artifact) tags actually exists.
        result.Tagged = doc.Structure.Catalog.CatalogDictionary.TryGet(
            UglyToad.PdfPig.Tokens.NameToken.Create("MarkInfo"), out _);

        // One pass over pages: collect per-page block lists, then assemble
        // chapters from the detection ladder.
        var pageBlocks = new List<(int Page, List<(string Html, string Text, int HeadingLevel)> Blocks, string? ChapterMark)>();
        var sawMarkedContent = false;

        for (var p = 1; p <= doc.NumberOfPages; p++)
        {
            var page = doc.GetPage(p);
            var blocks = new List<(string, string, int)>();
            string? chapterMark = null;

            IReadOnlyList<MarkedContentElement> marked;
            try { marked = page.GetMarkedContents(); }
            catch { marked = Array.Empty<MarkedContentElement>(); }

            if (marked.Count > 0)
            {
                sawMarkedContent = true;
                foreach (var el in marked)
                {
                    if (el.IsArtifact)
                    {
                        // Page furniture is excluded from reflow, but running
                        // headers often carry the chapter identity — harvest it
                        var art = LettersText(el);
                        if (chapterMark == null && ChapterHeader.IsMatch(art))
                        {
                            // Running headers carry the PAGE NUMBER — and OCR can
                            // split it into several groups — strip them all, or
                            // pages read as new chapters
                            chapterMark = CleanSpace(Regex.Replace(art, @"(\s*\d+)+\s*$", string.Empty));
                        }
                        continue;
                    }
                    EmitElement(el, blocks);
                }
            }
            else
            {
                // Untagged page: content-order extraction, paragraphs by line
                string text;
                try { text = ContentOrderTextExtractor.GetText(page); }
                catch { text = string.Empty; }
                foreach (var para in Regex.Split(text, @"\n\s*\n"))
                {
                    var t = CleanSpace(para);
                    if (t.Length > 0) blocks.Add(("<p>" + Escape(t) + "</p>", t, 0));
                }
            }

            pageBlocks.Add((p, blocks, chapterMark));
        }

        result.Tagged = result.Tagged && sawMarkedContent;

        // ── Assemble chapters ──
        // Pass 1: find pages that START a titled chapter (heading tag, or a
        // running-header chapter mark changing). Untitled stretches between
        // titled starts MERGE into the preceding chapter — the TOC carries
        // only real titles. Page-range chunking survives solely as (a) the
        // whole-book fallback when no structure exists and (b) a "(continued)"
        // safety split for pathologically long chapters, kept out of the TOC.
        var titledStarts = new Dictionary<int, string>(); // page → title
        var seenMarks = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var (pageNo, blocks, mark) in pageBlocks)
        {
            var h1 = blocks.FirstOrDefault(b => b.HeadingLevel == 1);
            // Heading titles need sanity: back matter tags bare numbers as H1
            var h1Ok = h1.Html != null && h1.Text.Length > 2 && !Regex.IsMatch(h1.Text, @"^[\d\s.,;:!-]+$");
            if (h1Ok && !titledStarts.ContainsKey(pageNo)) titledStarts[pageNo] = h1.Text;
            // A mark starts a chapter only the FIRST time it appears — an
            // intervening PART header must not duplicate the chapter when its
            // running header resumes
            else if (mark != null && seenMarks.Add(mark)) titledStarts[pageNo] = mark;
            else if (mark != null) seenMarks.Add(mark);
        }

        var hasStructure = titledStarts.Count > 0;
        var chapters = new List<PdfChapter>();
        var pageRefs = new List<PdfPageRef>();
        StringBuilder html = new(), plain = new();
        string title = Path.GetFileNameWithoutExtension(path);
        bool titled = false;
        int firstPage = 1;

        void Flush(string nextTitle, bool nextTitled, int nextFirstPage)
        {
            if (plain.Length > 0 || chapters.Count == 0)
            {
                chapters.Add(new PdfChapter
                {
                    Title = title,
                    Titled = titled,
                    BodyHtml = html.ToString(),
                    PlainText = CleanSpace(plain.ToString()),
                    FirstPage = firstPage,
                });
            }
            html = new StringBuilder();
            plain = new StringBuilder();
            title = nextTitle;
            titled = nextTitled;
            firstPage = nextFirstPage;
        }

        foreach (var (pageNo, blocks, _) in pageBlocks)
        {
            if (titledStarts.TryGetValue(pageNo, out var newTitle) && (plain.Length > 0 || chapters.Count > 0))
            {
                Flush(newTitle, true, pageNo);
            }
            else if (titledStarts.TryGetValue(pageNo, out var t0) && chapters.Count == 0 && plain.Length == 0)
            {
                title = t0; titled = true; firstPage = pageNo;
            }
            else if (!hasStructure && pageNo - firstPage >= FallbackPagesPerChapter && plain.Length > 0)
            {
                Flush($"Pages {pageNo}–", false, pageNo);
            }
            else if (hasStructure && pageNo - firstPage >= SafetyPagesPerChapter && plain.Length > 0)
            {
                Flush(title + " (continued)", false, pageNo);
            }

            // Visible/announced page break at each PDF page start
            html.Append("<span id=\"pg-").Append(pageNo)
                .Append("\" epub:type=\"pagebreak\" role=\"doc-pagebreak\" aria-label=\"")
                .Append(pageNo).Append("\"></span>");
            pageRefs.Add(new PdfPageRef { Page = pageNo, Chapter = chapters.Count });

            foreach (var (bHtml, bText, _) in blocks)
            {
                html.Append(bHtml);
                plain.Append(bText).Append(' ');
            }
        }
        Flush(string.Empty, false, doc.NumberOfPages);

        // Resolve open-ended chunk titles now that ranges are known
        for (var i = 0; i < chapters.Count; i++)
        {
            if (chapters[i].Title.EndsWith("–", StringComparison.Ordinal))
            {
                var last = i + 1 < chapters.Count ? chapters[i + 1].FirstPage - 1 : doc.NumberOfPages;
                chapters[i].Title = $"Pages {chapters[i].FirstPage}–{last}";
            }
        }

        if (!result.Tagged && chapters.Count > 0)
        {
            chapters[0].BodyHtml = "<p><em>This PDF has no accessibility tags; reading order was inferred and may be imperfect.</em></p>"
                + chapters[0].BodyHtml;
        }

        result.Chapters = chapters;
        result.Pages = pageRefs;
        return result;
    }

    /// <summary>Map one marked-content element (and children) to HTML blocks.</summary>
    private static void EmitElement(MarkedContentElement el, List<(string Html, string Text, int HeadingLevel)> blocks)
    {
        var tag = (el.Tag ?? string.Empty).ToUpperInvariant();
        var text = CleanSpace(LettersText(el) + " " + string.Join(" ", el.Children.Where(c => !c.IsArtifact).Select(LettersTextDeep)));
        text = CleanSpace(text);

        switch (tag)
        {
            case "H1" or "H2" or "H3" or "H4" or "H5" or "H6":
                if (text.Length == 0) return;
                var lvl = tag[1] - '0';
                blocks.Add(($"<h{lvl}>{Escape(text)}</h{lvl}>", text, lvl));
                return;
            case "P":
                if (text.Length == 0) return;
                blocks.Add(("<p>" + Escape(text) + "</p>", text, 0));
                return;
            case "LBL":
            case "LBODY":
            case "LI":
                if (text.Length == 0) return;
                // Lbl bullets fold into the LBody text; emit as list items
                blocks.Add(("<ul><li>" + Escape(text) + "</li></ul>", text, 0));
                return;
            case "FIGURE":
                var alt = CleanSpace(el.AlternateDescription ?? string.Empty);
                if (alt.Length > 0)
                    blocks.Add(("<aside role=\"img\" aria-label=\"" + Escape(alt) + "\"><em>[Image: " + Escape(alt) + "]</em></aside>", alt, 0));
                else if (text.Length > 0)
                    blocks.Add(("<p>" + Escape(text) + "</p>", text, 0));
                return;
            case "ARTIFACT":
                return;
            default:
                // Span/StyleSpan/Link/unknown: inline-ish — keep the text
                if (text.Length == 0)
                {
                    foreach (var c in el.Children.Where(c => !c.IsArtifact)) EmitElement(c, blocks);
                    return;
                }
                blocks.Add(("<p>" + Escape(text) + "</p>", text, 0));
                return;
        }
    }

    private static string LettersText(MarkedContentElement el) =>
        string.Concat(el.Letters.Select(l => l.Value));

    private static string LettersTextDeep(MarkedContentElement el) =>
        LettersText(el) + " " + string.Join(" ", el.Children.Where(c => !c.IsArtifact).Select(LettersTextDeep));

    private static string CleanSpace(string s) => Regex.Replace(s, @"\s+", " ").Trim();

    private static string Escape(string s) =>
        s.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;").Replace("\"", "&quot;");
}
