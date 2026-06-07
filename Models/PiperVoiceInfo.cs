using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.A11yBookReader.Models;

public class PiperVoiceInfo
{
    [JsonPropertyName("key")]
    public string Key { get; set; } = string.Empty;

    [JsonPropertyName("name")]
    public string Name { get; set; } = string.Empty;

    [JsonPropertyName("displayName")]
    public string DisplayName { get; set; } = string.Empty;

    [JsonPropertyName("language")]
    public string Language { get; set; } = string.Empty;

    [JsonPropertyName("quality")]
    public string Quality { get; set; } = string.Empty;

    [JsonPropertyName("downloaded")]
    public bool Downloaded { get; set; }

    [JsonPropertyName("sizeBytes")]
    public long SizeBytes { get; set; }

    [JsonPropertyName("sampleUrl")]
    public string? SampleUrl { get; set; }
}
