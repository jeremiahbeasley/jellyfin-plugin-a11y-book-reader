using System.Collections.Concurrent;
using System.Text;
using Jellyfin.Plugin.A11yBookReader.Models;
using MediaBrowser.Controller.Library;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.A11yBookReader.Services;

/// <summary>
/// Braille books (F3a): BRF / BRL ASCII-braille files. Each byte is one braille
/// cell in the Braille ASCII encoding; this service renders the cells as real
/// Unicode braille glyphs (U+2800–U+283F) so they display everywhere without a
/// special font, paginated on the embosser form-feeds. Back-translation to
/// print for TTS is a separate layer (F3b). Entirely self-contained — a fixed
/// 64-entry lookup, no linguistics.
/// </summary>
public class BrailleFormatService
{
    private static readonly string[] Extensions = { ".brf", ".brl" };

    // Braille ASCII (a.k.a. North American Braille ASCII): index = braille dot
    // value 0..63 (bit0=dot1 … bit5=dot6), value = the ASCII byte that encodes
    // that cell. Source: the canonical Braille ASCII ordering. The inverse map
    // (ASCII byte → dot value) drives the Unicode braille conversion below.
    private const string BrailleAsciiByValue =
        " A1B'K2L@CIF/MSP\"E3H9O6R^DJG>NTQ,*5<-U8V.%[$+X!&;:4\\0Z7(_?W]#Y)=";

    private static readonly int[] AsciiToCellValue = BuildInverse();

    private const int LinesPerPage = 25; // fallback pagination when no form-feeds

    private readonly ILibraryManager _libraryManager;
    private readonly ILogger<BrailleFormatService> _logger;
    private readonly ConcurrentDictionary<Guid, ParsedBraille?> _cache = new();

    public BrailleFormatService(ILibraryManager libraryManager, ILogger<BrailleFormatService> logger)
    {
        _libraryManager = libraryManager;
        _logger = logger;
    }

    private static int[] BuildInverse()
    {
        var map = new int[128];
        for (var i = 0; i < map.Length; i++) map[i] = -1;
        for (var value = 0; value < BrailleAsciiByValue.Length; value++)
        {
            var c = BrailleAsciiByValue[value];
            map[c] = value;
            // Braille ASCII is uppercase; accept lowercase input as the same cell.
            if (c >= 'A' && c <= 'Z') map[char.ToLowerInvariant(c)] = value;
        }
        return map;
    }

    /// <summary>One ASCII-braille byte → its Unicode braille glyph.</summary>
    private static char CellToGlyph(char ascii)
    {
        var value = ascii < 128 ? AsciiToCellValue[ascii] : -1;
        return value < 0 ? '⠀' : (char)(0x2800 + value);
    }

    private sealed class ParsedBraille
    {
        public string FilePath = string.Empty;
        public string Title = string.Empty;
        public List<BraillePage> Pages = new();
        // Headings detected from braille LAYOUT (centered / blank-surrounded
        // short lines). Titles are braille glyphs — the reader back-translates
        // them to print for the table of contents.
        public List<BrailleHeading> Headings = new();
    }

    private sealed class BrailleHeading
    {
        public string Id = string.Empty;
        public string Glyphs = string.Empty;
    }

    // An embosser (form-feed) page. The whole book is ONE document; these are
    // PAGES in a page list, not chapters — like PDF/DAISY print pages.
    private sealed class BraillePage
    {
        public int Number;
        public string LinesHtml = string.Empty; // the <span class="braille-line"> lines, no <pre>
        public string Glyphs = string.Empty;    // braille glyphs, for search
    }

    public static bool HandlesPath(string? path) =>
        path != null && Extensions.Any(e => path.EndsWith(e, StringComparison.OrdinalIgnoreCase));

    public bool Handles(Guid itemId) => HandlesPath(_libraryManager.GetItemById(itemId)?.Path);

    // One spine entry: the whole braille book is a single continuous document.
    public ParsedEpub? GetParsed(Guid itemId)
    {
        var book = GetBook(itemId);
        if (book == null) return null;
        return new ParsedEpub
        {
            FilePath = book.FilePath,
            Spine = new List<SpineItem>
            {
                new SpineItem { Index = 0, Title = book.Title, ZipPath = "braille-0", MimeType = "application/xhtml+xml" },
            },
        };
    }

    // The whole book in one <pre>, with a doc-pagebreak anchor at each embosser
    // page so go-to-page works and TTS reads straight through every page.
    public string? GetChapterHtml(Guid itemId, int index, string? apiKey = null)
    {
        var book = GetBook(itemId);
        if (book == null || index != 0) return null;
        var sb = new StringBuilder("<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"utf-8\"/><title>");
        sb.Append(Escape(book.Title)).Append("</title></head><body><pre class=\"braille\">");
        foreach (var p in book.Pages)
        {
            sb.Append("<span id=\"pg-").Append(p.Number)
              .Append("\" epub:type=\"pagebreak\" role=\"doc-pagebreak\" aria-label=\"")
              .Append(p.Number).Append("\"></span>").Append(p.LinesHtml);
        }
        sb.Append("</pre></body></html>");
        return sb.ToString();
    }

    public BookNavigation? GetNavigation(Guid itemId)
    {
        var book = GetBook(itemId);
        if (book == null) return null;
        return new BookNavigation
        {
            // TOC from layout-detected headings. Title is braille glyphs; the
            // reader back-translates each to print (and word-matches Chapter/
            // Part patterns) when it renders the book map.
            Toc = book.Headings.Select(h => new NavNode
            {
                Title = h.Glyphs,
                Chapter = 0,
                Anchor = h.Id,
            }).ToList(),
            TocGenerated = true,
            // Embosser pages are PAGES, not chapters: a real page list.
            PageList = book.Pages.Select(p => new NavNode
            {
                Title = p.Number.ToString(),
                Chapter = 0,
                Anchor = "pg-" + p.Number,
            }).ToList(),
        };
    }

    public (Stream? Data, string ContentType) GetResource(Guid itemId, string path) => (null, string.Empty);

    public SearchResults Search(Guid itemId, string query, int cap = 200)
    {
        // Search matches the braille glyphs themselves (print back-translation
        // search arrives with F3b). Querying with print text won't match yet.
        var results = new SearchResults();
        var book = GetBook(itemId);
        if (book == null || string.IsNullOrWhiteSpace(query)) return results;
        var needle = query.Trim();
        // One continuous document → one chapter (0).
        var text = string.Join("\n", book.Pages.Select(p => p.Glyphs));
        int from = 0, ordinal = 0;
        while (true)
        {
            int idx = text.IndexOf(needle, from, StringComparison.Ordinal);
            if (idx < 0) break;
            results.Total++;
            if (results.Hits.Count < cap)
            {
                int bStart = Math.Max(0, idx - 20);
                int aEnd = Math.Min(text.Length, idx + needle.Length + 30);
                results.Hits.Add(new SearchHit
                {
                    Chapter = 0,
                    Before = text[bStart..idx],
                    Match = text.Substring(idx, needle.Length),
                    After = text[(idx + needle.Length)..aEnd],
                    Ordinal = ordinal,
                });
            }
            ordinal++;
            from = idx + needle.Length;
        }
        results.Capped = results.Total > results.Hits.Count;
        return results;
    }

    private ParsedBraille? GetBook(Guid itemId) => _cache.GetOrAdd(itemId, id =>
    {
        try { return Parse(id); }
        catch (Exception ex) { _logger.LogError(ex, "Failed to parse braille {Id}", id); return null; }
    });

    private ParsedBraille? Parse(Guid itemId)
    {
        var item = _libraryManager.GetItemById(itemId);
        var path = item?.Path;
        if (path == null || !HandlesPath(path) || !File.Exists(path)) return null;

        var raw = File.ReadAllText(path, Encoding.ASCII);
        var fallbackTitle = Path.GetFileNameWithoutExtension(path);

        // Embosser pages are delimited by form-feed (0x0C). Without them, fall
        // back to fixed line-count pages so a long file stays navigable.
        var rawPages = raw.Contains('\f')
            ? raw.Split('\f')
            : ChunkByLines(raw, LinesPerPage);

        var pages = new List<BraillePage>();
        var headings = new List<BrailleHeading>();
        var n = 0;
        var hid = 0;
        foreach (var rp in rawPages)
        {
            var lines = rp.Replace("\r\n", "\n").Replace('\r', '\n').Split('\n');
            var lhtml = new StringBuilder();
            var glyphs = new StringBuilder();
            var hasContent = false;
            for (var li = 0; li < lines.Length; li++)
            {
                var line = lines[li];
                var gline = new StringBuilder();
                foreach (var ch in line)
                {
                    if (ch == '\t') { gline.Append(' '); continue; }
                    gline.Append(CellToGlyph(ch));
                }
                var g = gline.ToString();
                var contentLen = line.Trim().Length;
                if (contentLen > 0) hasContent = true;

                // Heading by LAYOUT (braille conventions, no back-translation
                // needed): a short line that is either indented/centered or set
                // off by blank lines above and below. The reader back-translates
                // the heading text for the table of contents.
                var lead = line.Length - line.TrimStart(' ').Length;
                var prevBlank = li == 0 || lines[li - 1].Trim().Length == 0;
                var nextBlank = li == lines.Length - 1 || lines[li + 1].Trim().Length == 0;
                var isHeading = contentLen >= 1 && contentLen <= 35 && (lead >= 4 || (prevBlank && nextBlank));

                // data-braille keeps the cells so the reader can swap the visible
                // text to back-translated print and back without losing them.
                var eg = Escape(g);
                if (isHeading)
                {
                    hid++;
                    var id = "bh-" + hid;
                    lhtml.Append("<span class=\"braille-line braille-heading\" id=\"").Append(id)
                         .Append("\" data-braille=\"").Append(eg).Append("\">").Append(eg).Append("</span>\n");
                    headings.Add(new BrailleHeading { Id = id, Glyphs = g.Trim('⠀', ' ', '\t') });
                }
                else
                {
                    // The trailing \n stays outside the span to keep the grid.
                    lhtml.Append("<span class=\"braille-line\" data-braille=\"").Append(eg).Append("\">").Append(eg).Append("</span>\n");
                }
                glyphs.Append(g).Append('\n');
            }
            if (!hasContent && rawPages.Length > 1) continue; // drop blank embosser pages
            n++;
            pages.Add(new BraillePage { Number = n, LinesHtml = lhtml.ToString(), Glyphs = glyphs.ToString() });
        }

        if (pages.Count == 0)
            pages.Add(new BraillePage { Number = 1, LinesHtml = string.Empty, Glyphs = string.Empty });

        return new ParsedBraille { FilePath = path, Title = fallbackTitle, Pages = pages, Headings = headings };
    }

    private static string[] ChunkByLines(string raw, int linesPerPage)
    {
        var lines = raw.Replace("\r\n", "\n").Replace('\r', '\n').Split('\n');
        var pages = new List<string>();
        for (var i = 0; i < lines.Length; i += linesPerPage)
            pages.Add(string.Join("\n", lines.Skip(i).Take(linesPerPage)));
        return pages.Count > 0 ? pages.ToArray() : new[] { raw };
    }

    private static string Escape(string s) =>
        s.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;");
}
