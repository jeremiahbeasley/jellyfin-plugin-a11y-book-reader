using Jellyfin.Plugin.A11yBookReader.Configuration;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;

namespace Jellyfin.Plugin.A11yBookReader;

public class A11yBookReaderPlugin : BasePlugin<PluginConfiguration>, IHasWebPages
{
    public static A11yBookReaderPlugin? Instance { get; private set; }

    public A11yBookReaderPlugin(IApplicationPaths appPaths, IXmlSerializer xmlSerializer)
        : base(appPaths, xmlSerializer)
    {
        Instance = this;
    }

    public override string Name => "A11y Book Reader";

    public override string Description => "Accessible book reader for Jellyfin with WCAG 2.2 compliance.";

    public override Guid Id => new("19ba7210-d7de-4c86-afbb-4e3d596abe16");

    public IEnumerable<PluginPageInfo> GetPages()
    {
        return
        [
            new PluginPageInfo
            {
                Name = Name,
                EmbeddedResourcePath = GetType().Namespace + ".Configuration.configPage.html"
            }
        ];
    }
}
