namespace Jellyfin.Plugin.A11yBookReader.Models;

/// <summary>
/// Per-user display/reading settings. Cross-device by design (the same user
/// gets their typography on the TV, phone, and desktop). Device-specific
/// values (e.g. TTS voice URIs) deliberately stay client-side.
/// </summary>
public class ReaderSettings
{
    /// <summary>publisher | serif | sans | opendyslexic.</summary>
    public string FontFamily { get; set; } = "publisher";

    /// <summary>Percent of the publisher size, 70–250.</summary>
    public int FontSizePct { get; set; } = 100;

    /// <summary>Line height multiplier ×100 (e.g. 150 = 1.5). 100–250.</summary>
    public int LineHeightPct { get; set; } = 150;

    /// <summary>Letter spacing in 1/100 em. 0–25.</summary>
    public int LetterSpacing { get; set; } = 0;

    /// <summary>Word spacing in 1/100 em. 0–50.</summary>
    public int WordSpacing { get; set; } = 0;

    /// <summary>Paragraph spacing multiplier ×100. 100–300.</summary>
    public int ParaSpacingPct { get; set; } = 100;

    /// <summary>Page margin: percent of frame width per side. 2–20.</summary>
    public int MarginPct { get; set; } = 6;

    /// <summary>left | justify.</summary>
    public string Align { get; set; } = "left";

    /// <summary>light | dark | sepia | contrast | custom.</summary>
    public string Theme { get; set; } = "light";

    /// <summary>Custom foreground, #rrggbb (used when Theme == custom).</summary>
    public string? CustomFg { get; set; }

    /// <summary>Custom background, #rrggbb (used when Theme == custom).</summary>
    public string? CustomBg { get; set; }

    /// <summary>Explicit reduced-motion preference (layered over the OS media query).</summary>
    public bool ReducedMotion { get; set; }

    /// <summary>paged | scroll.</summary>
    public string ViewMode { get; set; } = "scroll";

    /// <summary>Reading ruler enabled.</summary>
    public bool Ruler { get; set; }

    /// <summary>TTS rate ×100 (e.g. 150 = 1.5×). 25–300.</summary>
    public int TtsRatePct { get; set; } = 100;

    public DateTime Updated { get; set; }
}
