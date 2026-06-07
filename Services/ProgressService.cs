using System.Text.Json;
using Jellyfin.Plugin.A11yBookReader.Models;
using MediaBrowser.Common.Configuration;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.A11yBookReader.Services;

/// <summary>
/// Stores per-user, per-book reading positions as JSON under the server data path.
/// All access is serialized through a lock; writes are atomic (temp file + rename)
/// so a crash mid-write can never corrupt existing progress.
/// </summary>
public class ProgressService
{
    private readonly string _filePath;
    private readonly ILogger<ProgressService> _logger;
    private readonly object _lock = new();

    // userId -> (itemId -> progress)
    private Dictionary<string, Dictionary<string, BookProgress>> _data = new();

    public ProgressService(IApplicationPaths appPaths, ILogger<ProgressService> logger)
    {
        _logger = logger;
        var dir = Path.Combine(appPaths.DataPath, "a11ybookreader");
        Directory.CreateDirectory(dir);
        _filePath = Path.Combine(dir, "progress.json");
        Load();
    }

    public BookProgress? Get(Guid userId, Guid itemId)
    {
        lock (_lock)
        {
            return _data.TryGetValue(userId.ToString("N"), out var books)
                   && books.TryGetValue(itemId.ToString("N"), out var p)
                ? p
                : null;
        }
    }

    public void Save(Guid userId, Guid itemId, int chapter, double fraction)
    {
        lock (_lock)
        {
            var userKey = userId.ToString("N");
            if (!_data.TryGetValue(userKey, out var books))
            {
                books = new Dictionary<string, BookProgress>();
                _data[userKey] = books;
            }

            books[itemId.ToString("N")] = new BookProgress
            {
                Chapter = Math.Max(0, chapter),
                Fraction = Math.Clamp(fraction, 0.0, 1.0),
                Updated = DateTime.UtcNow
            };

            Persist();
        }
    }

    private void Load()
    {
        try
        {
            if (!File.Exists(_filePath)) return;
            var json = File.ReadAllText(_filePath);
            var data = JsonSerializer.Deserialize<Dictionary<string, Dictionary<string, BookProgress>>>(json);
            if (data != null) _data = data;
        }
        catch (Exception ex)
        {
            // Unreadable file: keep an in-memory store rather than failing the plugin.
            _logger.LogError(ex, "Failed to load reading progress from {Path}", _filePath);
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
            _logger.LogError(ex, "Failed to persist reading progress to {Path}", _filePath);
        }
    }
}
