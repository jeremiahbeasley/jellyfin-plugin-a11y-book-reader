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
    private const int CurrentSchema = 2;
    private readonly string _filePath;
    private readonly string _schemaMarkerPath;
    private readonly ILogger<SettingsService> _logger;
    private readonly object _lock = new();

    private static readonly HashSet<string> AllowedViewModes = new() { "page", "chapter", "scroll" };
    private static readonly HashSet<string> AllowedNavUnits = new() { "chapter", "page", "heading", "paragraph", "sentence" };
    private static readonly HashSet<string> AllowedThemes = new() { "light", "dark", "sepia", "contrast", "custom" };
    private static readonly HashSet<string> AllowedFonts = new() { "publisher", "serif", "sans", "opendyslexic" };
    private static readonly System.Text.RegularExpressions.Regex HexColor =
        new("^#[0-9a-fA-F]{6}$", System.Text.RegularExpressions.RegexOptions.Compiled);

    // Pass through null (client uses its default) or a valid #rrggbb; reject anything
    // else so no arbitrary string can reach the client-side CSS.
    private static string? SafeHex(string? value)
        => value != null && HexColor.IsMatch(value) ? value : null;

    private Dictionary<string, ReaderSettings> _data = new();

    public SettingsService(IApplicationPaths appPaths, ILogger<SettingsService> logger)
    {
        _logger = logger;
        var dir = Path.Combine(appPaths.DataPath, "a11ybookreader");
        Directory.CreateDirectory(dir);
        _filePath = Path.Combine(dir, "settings.json");
        _schemaMarkerPath = Path.Combine(dir, "schema-version");
        Load();
        MigrateIfNeeded();
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
            if (!AllowedViewModes.Contains(settings.ViewMode)) settings.ViewMode = "chapter";
            if (!AllowedNavUnits.Contains(settings.NavUnit)) settings.NavUnit = "chapter";
            // Free-form strings are concatenated into a <style> element client-side,
            // so they must be validated server-side to prevent CSS injection.
            if (!AllowedThemes.Contains(settings.Theme)) settings.Theme = "light";
            if (!AllowedFonts.Contains(settings.FontFamily)) settings.FontFamily = "publisher";
            if (settings.Align != "justify") settings.Align = "left";
            settings.CustomFg = SafeHex(settings.CustomFg);
            settings.CustomBg = SafeHex(settings.CustomBg);
            settings.HlBg = SafeHex(settings.HlBg);
            settings.HlFg = SafeHex(settings.HlFg);
            settings.Updated = DateTime.UtcNow;
            _data[userId.ToString("N")] = settings;
            Persist();
        }
    }

    // One-time v1→v2 migration: ViewMode semantics changed to the 3-way set.
    // Legacy 'paged' becomes 'page'; legacy 'scroll' (scroll-within-chapter)
    // becomes 'chapter'. The new full-book 'scroll' is opt-in, so nothing
    // stored at upgrade can legitimately be the new meaning. Gated by a marker
    // file so it runs exactly once and never clobbers a later real 'scroll'.
    private void MigrateIfNeeded()
    {
        lock (_lock)
        {
            var stored = 0;
            try
            {
                if (File.Exists(_schemaMarkerPath))
                    int.TryParse(File.ReadAllText(_schemaMarkerPath).Trim(), out stored);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to read settings schema marker {Path}", _schemaMarkerPath);
            }
            if (stored >= CurrentSchema) return;

            var changed = false;
            foreach (var s in _data.Values)
            {
                if (s.ViewMode == "paged") { s.ViewMode = "page"; changed = true; }
                else if (s.ViewMode == "scroll") { s.ViewMode = "chapter"; changed = true; }
            }
            if (changed) Persist();

            try
            {
                File.WriteAllText(_schemaMarkerPath, CurrentSchema.ToString());
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to write settings schema marker {Path}", _schemaMarkerPath);
            }
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
