namespace Jellyfin.Plugin.A11yBookReader.Models;

public class ParsedEpub
{
    public string FilePath { get; set; } = string.Empty;
    public string OpfBaseDir { get; set; } = string.Empty;
    public List<SpineItem> Spine { get; set; } = new();
    public Dictionary<string, (string Href, string MimeType)> Manifest { get; set; } = new();
}
