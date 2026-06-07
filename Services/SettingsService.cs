using System.Text.Json;
using Jellyfin.Plugin.A11yBookReader.Models;
using MediaBrowser.Common.Configuration;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.A11yBookReader.Services;

/// <summary>
/// Per-user reader settings, persisted as JSON under the server data path.
/// Same safety properties as ProgressService: lock-serialized access and
/// atomic temp-file writes.
/// </summary>
public class SettingsService
{
    private readonly string _filePath;
    private readonly ILogger<SettingsService> _logger;
    private readonly object _lock = new();

    private Dictionary<string, ReaderSettings> _data = new();

    public SettingsService(IApplicationPaths appPaths, ILogger<SettingsService> logger)
    {
        _logger = logger;
        var dir = Path.Combine(appPaths.DataPath, "a11ybookreader");
        Directory.CreateDirectory(dir);
        _filePath = Path.Combine(dir, "settings.json");
        Load();
    }

    public ReaderSettings? Get(Guid userId)
    {
        lock (_lock)
        {
            return _data.TryGetValue(userId.ToString("N"), out var s) ? s : null;
        }
    }

    public void Save(Guid userId, ReaderSettings settings)
    {
        lock (_lock)
        {
            settings.FontSizePct = Math.Clamp(settings.FontSizePct, 70, 250);
            settings.LineHeightPct = Math.Clamp(settings.LineHeightPct, 100, 250);
            settings.LetterSpacing = Math.Clamp(settings.LetterSpacing, 0, 25);
            settings.WordSpacing = Math.Clamp(settings.WordSpacing, 0, 50);
            settings.ParaSpacingPct = Math.Clamp(settings.ParaSpacingPct, 100, 300);
            settings.MarginPct = Math.Clamp(settings.MarginPct, 2, 20);
            settings.TtsRatePct = Math.Clamp(settings.TtsRatePct, 25, 300);
            settings.Updated = DateTime.UtcNow;
            _data[userId.ToString("N")] = settings;
            Persist();
        }
    }

    private void Load()
    {
        try
        {
            if (!File.Exists(_filePath)) return;
            var data = JsonSerializer.Deserialize<Dictionary<string, ReaderSettings>>(
                File.ReadAllText(_filePath));
            if (data != null) _data = data;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to load reader settings from {Path}", _filePath);
        }
    }

    private void Persist()
    {
        try
        {
            var tmp = _filePath + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(_data));
            File.Move(tmp, _filePath, overwrite: true);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to persist reader settings to {Path}", _filePath);
        }
    }
}
