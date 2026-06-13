using Jellyfin.Plugin.A11yBookReader.Services;
using Jellyfin.Plugin.A11yBookReader.Web;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using Microsoft.AspNetCore.Hosting;
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
        serviceCollection.AddSingleton<TextFormatService>();
        serviceCollection.AddSingleton<DaisyFormatService>();
        serviceCollection.AddSingleton<PdfFormatService>();
        serviceCollection.AddSingleton<DocFormatService>();
        serviceCollection.AddSingleton<BrailleFormatService>();

        // Self-contained UI injection: run our own response-rewriting middleware
        // instead of depending on the File Transformation plugin.
        serviceCollection.AddSingleton<IStartupFilter, InjectionStartupFilter>();
    }
}
