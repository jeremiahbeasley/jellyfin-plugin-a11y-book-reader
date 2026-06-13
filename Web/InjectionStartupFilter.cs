using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;

namespace Jellyfin.Plugin.A11yBookReader.Web;

/// <summary>
/// Inserts <see cref="IndexInjectionMiddleware"/> at the front of the ASP.NET
/// Core request pipeline. Registered as an <see cref="IStartupFilter"/> in
/// <see cref="PluginServiceRegistrator"/>; ASP.NET Core resolves all startup
/// filters from DI and wraps them around the host's own configuration, which is
/// how a plugin can contribute middleware without modifying Jellyfin's startup.
/// </summary>
public class InjectionStartupFilter : IStartupFilter
{
    public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next)
    {
        return app =>
        {
            app.UseMiddleware<IndexInjectionMiddleware>();
            next(app);
        };
    }
}
