using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.A11yBookReader.Configuration;

public class PluginConfiguration : BasePluginConfiguration
{
    public string PiperVoice { get; set; } = string.Empty;
}
