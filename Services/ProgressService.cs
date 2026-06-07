using System.Text.Json;
using Jellyfin.Plugin.A11yBookReader.Models;
using MediaBrowser.Common.Configuration;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.A11yBookReader.Services;

/// <summary>
/// Stores per-user, per-book reading positions as Readium-style locators in
/// JSON under the server data path. All access is serialized through a lock;
/// writes are atomic (temp file + rename) so a crash mid-write can never
/// corrupt existing progress. Legacy flat-shape saves (v1.0.0.10/11) are
/// migrated on load.
/// </summary>
public class ProgressService
{
    private readonly string _filePath;
    private readonly ILogger<ProgressService> _logger;
    private readonly object _lock = new();

    // userId -> (itemId -> locator)
    private Dictionary<string, Dictionary<string, Locator>> _data = new();

    public ProgressService(IApplicationPaths appPaths, ILogger<ProgressService> logger)
    {
        _logger = logger;
        var dir = Path.Combine(appPaths.DataPath, "a11ybookreader");
        Directory.CreateDirectory(dir);
        _filePath = Path.Combine(dir, "progress.json");
        Load();
    }

    public Locator? Get(Guid userId, Guid itemId)
    {
        lock (_lock)
        {
            return _data.TryGetValue(userId.ToString("N"), out var books)
                   && books.TryGetValue(itemId.ToString("N"), out var p)
                ? p
                : null;
        }
    }

    public void Save(Guid userId, Guid itemId, Locator locator)
    {
        lock (_lock)
        {
            var userKey = userId.ToString("N");
            if (!_data.TryGetValue(userKey, out var books))
            {
                books = new Dictionary<string, Locator>();
                _data[userKey] = books;
            }

            locator.Locations.Chapter = Math.Max(0, locator.Locations.Chapter);
            locator.Locations.Progression = Math.Clamp(locator.Locations.Progression, 0.0, 1.0);
            locator.Locations.TotalProgression = Math.Clamp(locator.Locations.TotalProgression, 0.0, 1.0);
            if (locator.Locations.Position is < 0) locator.Locations.Position = null;
            locator.Updated = DateTime.UtcNow;

            books[itemId.ToString("N")] = locator;
            Persist();
        }
    }

    private void Load()
    {
        try
        {
            if (!File.Exists(_filePath)) return;
            var json = File.ReadAllText(_filePath);
            var raw = JsonSerializer.Deserialize<Dictionary<string, Dictionary<string, JsonElement>>>(json);
            if (raw == null) return;

            foreach (var (userKey, books) in raw)
            {
                var converted = new Dictionary<string, Locator>();
                foreach (var (itemKey, el) in books)
                {
                    var locator = el.TryGetProperty("Locations", out _)
                        ? el.Deserialize<Locator>()
                        : MigrateLegacy(el);
                    if (locator != null) converted[itemKey] = locator;
                }
                _data[userKey] = converted;
            }
        }
        catch (Exception ex)
        {
            // Unreadable file: keep an in-memory store rather than failing the plugin.
            _logger.LogError(ex, "Failed to load reading progress from {Path}", _filePath);
        }
    }

    /// <summary>v1.0.0.10/11 flat shape → locator.</summary>
    private static Locator? MigrateLegacy(JsonElement el)
    {
        try
        {
            var chapter = el.TryGetProperty("Chapter", out var c) ? c.GetInt32() : 0;
            var fraction = el.TryGetProperty("Fraction", out var f) ? f.GetDouble() : 0.0;
            int? para = el.TryGetProperty("Para", out var p) && p.ValueKind == JsonValueKind.Number
                ? p.GetInt32() : null;
            var updated = el.TryGetProperty("Updated", out var u) && u.ValueKind == JsonValueKind.String
                ? u.GetDateTime() : DateTime.UtcNow;
            return new Locator
            {
                Locations = new LocatorLocations
                {
                    Chapter = chapter,
                    Progression = fraction,
                    Position = para,
                },
                Updated = updated,
            };
        }
        catch { return null; }
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
