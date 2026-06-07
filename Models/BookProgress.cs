namespace Jellyfin.Plugin.A11yBookReader.Models;

/// <summary>Per-user, per-book reading position.</summary>
public class BookProgress
{
    /// <summary>Spine index of the chapter the user was reading.</summary>
    public int Chapter { get; set; }

    /// <summary>Scroll position within the chapter, 0.0 (top) to 1.0 (bottom).</summary>
    public double Fraction { get; set; }

    /// <summary>UTC timestamp of the last save.</summary>
    public DateTime Updated { get; set; }
}

/// <summary>Client payload for saving progress.</summary>
public class SaveProgressRequest
{
    public int Chapter { get; set; }

    public double Fraction { get; set; }
}
