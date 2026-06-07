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
