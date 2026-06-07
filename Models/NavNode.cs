namespace Jellyfin.Plugin.A11yBookReader.Models;

/// <summary>A node in the book's navigation (TOC, landmarks, or page list).</summary>
public class NavNode
{
    public string Title { get; set; } = string.Empty;

    /// <summary>Spine index the target resolves to; -1 when unresolvable.</summary>
    public int Chapter { get; set; } = -1;

    /// <summary>Fragment id within the chapter document, if any.</summary>
    public string? Anchor { get; set; }

    /// <summary>epub:type for landmarks (cover, bodymatter, glossary, index…).</summary>
    public string? EpubType { get; set; }

    public List<NavNode> Children { get; set; } = new();
}

/// <summary>One in-book search hit, carrying text-quote context (Locator-aligned).</summary>
public class SearchHit
{
    public int Chapter { get; set; }

    public string? ChapterTitle { get; set; }

    public string Before { get; set; } = string.Empty;

    public string Match { get; set; } = string.Empty;

    public string After { get; set; } = string.Empty;

    /// <summary>Quote used to relocate the hit on the client (match + trailing context).</summary>
    public string Quote { get; set; } = string.Empty;

    /// <summary>Occurrence ordinal of this Quote within the chapter (0-based) for disambiguation.</summary>
    public int Ordinal { get; set; }
}

public class SearchResults
{
    public List<SearchHit> Hits { get; set; } = new();

    public int Total { get; set; }

    /// <summary>True when results were capped (more matches exist than returned).</summary>
    public bool Capped { get; set; }
}

/// <summary>Parsed navigation for a publication (EPUB 3 nav doc, NCX fallback).</summary>
public class BookNavigation
{
    public List<NavNode> Toc { get; set; } = new();

    public List<NavNode> Landmarks { get; set; } = new();

    /// <summary>Print page numbers (EPUB page-list), when the book provides them.</summary>
    public List<NavNode> PageList { get; set; } = new();

    /// <summary>True when the TOC was synthesized from content (book had none).</summary>
    public bool TocGenerated { get; set; }
}
