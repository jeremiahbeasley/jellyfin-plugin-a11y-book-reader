namespace Jellyfin.Plugin.A11yBookReader.Models;

/// <summary>
/// Readium-style locator — the industry-standard shape for a reading position
/// (https://readium.org/architecture/models/locators/). Multiple complementary
/// location forms are stored so any renderer, layout, or future format can
/// resolve the position: a structural fragment, a text quote, and progressions.
/// </summary>
public class Locator
{
    /// <summary>Resource path within the publication (EPUB spine item path).</summary>
    public string? Href { get; set; }

    public LocatorLocations Locations { get; set; } = new();

    /// <summary>Text context around the position — survives any re-rendering.</summary>
    public LocatorText? Text { get; set; }

    /// <summary>UTC timestamp of the last save.</summary>
    public DateTime Updated { get; set; }
}

public class LocatorLocations
{
    /// <summary>Spine index of the chapter (renderer-friendly duplicate of Href).</summary>
    public int Chapter { get; set; }

    /// <summary>0.0–1.0 within the chapter.</summary>
    public double Progression { get; set; }

    /// <summary>0.0–1.0 within the whole publication.</summary>
    public double TotalProgression { get; set; }

    /// <summary>Block-element index within the chapter (structural fragment).</summary>
    public int? Position { get; set; }
}

public class LocatorText
{
    public string? Before { get; set; }

    public string? Highlight { get; set; }

    public string? After { get; set; }
}

/// <summary>
/// POST payload. Accepts the locator shape, plus the legacy flat fields from
/// v1.0.0.10/11 clients still holding cached scripts.
/// </summary>
public class SaveLocatorRequest
{
    public string? Href { get; set; }

    public LocatorLocations? Locations { get; set; }

    public LocatorText? Text { get; set; }

    // Legacy flat fields (pre-locator clients)
    public int? Chapter { get; set; }

    public double? Fraction { get; set; }

    public int? Para { get; set; }
}
