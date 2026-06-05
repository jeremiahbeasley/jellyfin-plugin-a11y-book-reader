namespace Jellyfin.Plugin.A11yBookReader.Models;

public class SpineItem
{
    public int Index { get; set; }
    public string Title { get; set; } = string.Empty;
    public string ZipPath { get; set; } = string.Empty;
    public string MimeType { get; set; } = string.Empty;
}
