using Jellyfin.Plugin.A11yBookReader.Services;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using Microsoft.Extensions.DependencyInjection;

namespace Jellyfin.Plugin.A11yBookReader;

public class PluginServiceRegistrator : IPluginServiceRegistrator
{
    public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
    {
        serviceCollection.AddSingleton<EpubService>();
        serviceCollection.AddSingleton<PiperService>();
        serviceCollection.AddSingleton<ProgressService>();
        serviceCollection.AddSingleton<SettingsService>();
        serviceCollection.AddSingleton<AnnotationService>();
    }
}
