using System.Text.Json;
using Jellyfin.Plugin.A11yBookReader.Models;
using MediaBrowser.Common.Configuration;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.A11yBookReader.Services;

/// <summary>
/// Per-user, per-book annotations (bookmarks / highlights / notes), persisted
/// as JSON under the server data path. Same safety properties as
/// SettingsService and ProgressService: lock-serialized access and atomic
/// temp-file writes.
/// </summary>
public class AnnotationService
{
    private const int MaxPerBook = 500;
    private const int MaxBodyLength = 4000;
    private const int MaxQuoteLength = 300;

    private static readonly HashSet<string> AllowedTypes = new() { "bookmark", "highlight", "note" };
    private static readonly HashSet<string> AllowedColors = new() { "yellow", "green", "blue", "pink", "orange" };

    private readonly string _filePath;
    private readonly ILogger<AnnotationService> _logger;
    private readonly object _lock = new();

    // userId(N) → itemId(N) → annotations
    private Dictionary<string, Dictionary<string, List<Annotation>>> _data = new();

    public AnnotationService(IApplicationPaths appPaths, ILogger<AnnotationService> logger)
    {
        _logger = logger;
        var dir = Path.Combine(appPaths.DataPath, "a11ybookreader");
        Directory.CreateDirectory(dir);
        _filePath = Path.Combine(dir, "annotations.json");
        Load();
    }

    public List<Annotation> List(Guid userId, Guid itemId)
    {
        lock (_lock)
        {
            if (_data.TryGetValue(userId.ToString("N"), out var books) &&
                books.TryGetValue(itemId.ToString("N"), out var list))
            {
                // Snapshot so callers can't mutate the stored list outside the lock
                return new List<Annotation>(list);
            }

            return new List<Annotation>();
        }
    }

    /// <summary>Validates, stores, and returns the created annotation (with id), or null when the per-book cap is hit.</summary>
    public Annotation? Add(Guid userId, Guid itemId, Annotation annotation)
    {
        lock (_lock)
        {
            var books = GetOrAddUser(userId);
            var key = itemId.ToString("N");
            if (!books.TryGetValue(key, out var list))
            {
                list = new List<Annotation>();
                books[key] = list;
            }

            if (list.Count >= MaxPerBook) return null;

            annotation.Id = Guid.NewGuid();
            Sanitize(annotation);
            annotation.Created = DateTime.UtcNow;
            annotation.Updated = annotation.Created;
            list.Add(annotation);
            Persist();
            return annotation;
        }
    }

    public Annotation? Update(Guid userId, Guid itemId, Guid id, string? body, string? color)
    {
        lock (_lock)
        {
            var a = Find(userId, itemId, id);
            if (a == null) return null;
            a.Body = Truncate(body, MaxBodyLength);
            a.Color = color != null && AllowedColors.Contains(color) ? color : a.Color;
            a.Updated = DateTime.UtcNow;
            Persist();
            return a;
        }
    }

    public bool Delete(Guid userId, Guid itemId, Guid id)
    {
        lock (_lock)
        {
            if (!_data.TryGetValue(userId.ToString("N"), out var books) ||
                !books.TryGetValue(itemId.ToString("N"), out var list))
            {
                return false;
            }

            var removed = list.RemoveAll(a => a.Id == id) > 0;
            if (removed) Persist();
            return removed;
        }
    }

    private Annotation? Find(Guid userId, Guid itemId, Guid id)
    {
        return _data.TryGetValue(userId.ToString("N"), out var books) &&
               books.TryGetValue(itemId.ToString("N"), out var list)
            ? list.FirstOrDefault(a => a.Id == id)
            : null;
    }

    private Dictionary<string, List<Annotation>> GetOrAddUser(Guid userId)
    {
        var key = userId.ToString("N");
        if (!_data.TryGetValue(key, out var books))
        {
            books = new Dictionary<string, List<Annotation>>();
            _data[key] = books;
        }

        return books;
    }

    // The body and quote are rendered into the reader UI as textContent (never
    // HTML), but cap lengths server-side so the store can't be ballooned.
    private static void Sanitize(Annotation a)
    {
        if (!AllowedTypes.Contains(a.Type)) a.Type = "bookmark";
        if (a.Color != null && !AllowedColors.Contains(a.Color)) a.Color = null;
        a.Body = Truncate(a.Body, MaxBodyLength);
        a.Target.Locations.Progression = Math.Clamp(a.Target.Locations.Progression, 0.0, 1.0);
        a.Target.Locations.TotalProgression = Math.Clamp(a.Target.Locations.TotalProgression, 0.0, 1.0);
        if (a.Target.Text != null)
        {
            a.Target.Text.Before = Truncate(a.Target.Text.Before, MaxQuoteLength);
            a.Target.Text.Highlight = Truncate(a.Target.Text.Highlight, MaxQuoteLength);
            a.Target.Text.After = Truncate(a.Target.Text.After, MaxQuoteLength);
        }
    }

    private static string? Truncate(string? s, int max)
        => s != null && s.Length > max ? s[..max] : s;

    private void Load()
    {
        try
        {
            if (!File.Exists(_filePath)) return;
            var data = JsonSerializer.Deserialize<Dictionary<string, Dictionary<string, List<Annotation>>>>(
                File.ReadAllText(_filePath));
            if (data != null) _data = data;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to load annotations from {Path}", _filePath);
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
            _logger.LogError(ex, "Failed to persist annotations to {Path}", _filePath);
        }
    }
}
