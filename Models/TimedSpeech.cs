namespace Jellyfin.Plugin.A11yBookReader.Models;

/// <summary>One sentence's real audio timing within the streamed output.</summary>
public class SentenceSpan
{
    /// <summary>Character offset (into the streamed text) where the sentence starts.</summary>
    public int CharStart { get; set; }

    /// <summary>Character offset (into the streamed text) where the sentence ends.</summary>
    public int CharEnd { get; set; }

    /// <summary>Media-time milliseconds in the OUTPUT (speed already baked in).</summary>
    public int StartMs { get; set; }

    public int EndMs { get; set; }
}
