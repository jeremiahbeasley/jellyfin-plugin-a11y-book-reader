using Newtonsoft.Json;

namespace Jellyfin.Plugin.A11yBookReader.Models;

public class PatchRequestPayload
{
    [JsonProperty("contents")]
    public string? Contents { get; set; }
}
