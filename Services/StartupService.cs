using System.Runtime.Loader;
using Jellyfin.Plugin.A11yBookReader.Helpers;
using MediaBrowser.Model.Tasks;
using Microsoft.Extensions.Logging;
using Newtonsoft.Json.Linq;

namespace Jellyfin.Plugin.A11yBookReader.Services;

public class StartupService : IScheduledTask
{
    private static readonly Guid TransformationId = Guid.Parse("a3b2c1d0-e4f5-6789-abcd-ef0123456789");

    private readonly ILogger<StartupService> _logger;

    public StartupService(ILogger<StartupService> logger)
    {
        _logger = logger;
    }

    public string Name => "A11y Book Reader Startup";
    public string Key => "Jellyfin.Plugin.A11yBookReader.Startup";
    public string Description => "Registers UI injection for A11y Book Reader";
    public string Category => "Startup Services";

    public Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
    {
        _logger.LogInformation("A11yBookReader: Registering file transformations");

        var fileTransformAssembly = AssemblyLoadContext.All
            .SelectMany(x => x.Assemblies)
            .FirstOrDefault(x => x.FullName?.Contains(".FileTransformation", StringComparison.Ordinal) ?? false);

        if (fileTransformAssembly == null)
        {
            _logger.LogWarning("A11yBookReader: FileTransformation plugin not found — UI injection disabled");
            return Task.CompletedTask;
        }

        var pluginInterface = fileTransformAssembly.GetType("Jellyfin.Plugin.FileTransformation.PluginInterface");
        if (pluginInterface == null)
        {
            _logger.LogWarning("A11yBookReader: FileTransformation.PluginInterface type not found");
            return Task.CompletedTask;
        }

        var payload = new JObject
        {
            ["id"]               = TransformationId,
            ["fileNamePattern"]  = "index.html",
            ["callbackAssembly"] = GetType().Assembly.FullName,
            ["callbackClass"]    = typeof(TransformationPatches).FullName,
            ["callbackMethod"]   = nameof(TransformationPatches.IndexHtml)
        };

        pluginInterface.GetMethod("RegisterTransformation")?.Invoke(null, new object?[] { payload });
        _logger.LogInformation("A11yBookReader: Registered index.html transformation");
        return Task.CompletedTask;
    }

    public IEnumerable<TaskTriggerInfo> GetDefaultTriggers()
    {
        yield return new TaskTriggerInfo { Type = TaskTriggerInfoType.StartupTrigger };
    }
}
