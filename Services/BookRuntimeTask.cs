using System;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Tasks;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.A11yBookReader.Services;

/// <summary>
/// Gives Book items a reading-time runtime estimate when they have none (or
/// the one-second placeholder many books carry). The reader reports playback
/// position against this runtime, which is what puts books on the resume
/// rows with a meaningful progress bar instead of a 0/1-second sliver.
/// Estimates are deliberately cheap: PDF page count, or text bytes from the
/// zip central directory / file size at ~220 wpm — no full parsing.
/// (A scheduled task, not a metadata provider: plugin ICustomMetadataProvider
/// instances are constructed but never invoked by the refresh pipeline here.)
/// </summary>
public class BookRuntimeTask : IScheduledTask
{
    private const double WordsPerMinute = 220.0;
    private const double CharsPerWord = 6.0;
    private const double SecondsPerPdfPage = 40.0;

    private readonly ILibraryManager _libraryManager;
    private readonly ILogger<BookRuntimeTask> _logger;

    public BookRuntimeTask(ILibraryManager libraryManager, ILogger<BookRuntimeTask> logger)
    {
        _libraryManager = libraryManager;
        _logger = logger;
    }

    public string Name => "Estimate book reading times";

    public string Key => "Jellyfin.Plugin.A11yBookReader.BookRuntime";

    public string Description => "Sets a reading-time runtime on books that have none, so resume rows show meaningful progress.";

    public string Category => "Library";

    public async Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
    {
        var books = _libraryManager.GetItemList(new InternalItemsQuery
        {
            IncludeItemTypes = new[] { BaseItemKind.Book },
            Recursive = true
        });

        int done = 0, set = 0;
        foreach (var item in books)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                // Respect any real runtime; only fill in missing/placeholder values
                if (!(item.RunTimeTicks.HasValue && item.RunTimeTicks.Value > TimeSpan.TicksPerSecond * 10))
                {
                    var ticks = EstimateTicks(item.Path);
                    if (ticks > 0)
                    {
                        item.RunTimeTicks = ticks;
                        await item.UpdateToRepositoryAsync(ItemUpdateType.MetadataEdit, cancellationToken).ConfigureAwait(false);
                        set++;
                    }
                }
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception ex)
            {
                _logger.LogDebug(ex, "Reading-time estimate failed for {Path}", item.Path);
            }

            progress.Report(++done * 100.0 / Math.Max(1, books.Count));
        }

        _logger.LogInformation("Reading-time estimates set on {Set} of {Total} books", set, books.Count);
    }

    public IEnumerable<TaskTriggerInfo> GetDefaultTriggers()
    {
        yield return new TaskTriggerInfo { Type = TaskTriggerInfoType.StartupTrigger };
        yield return new TaskTriggerInfo { Type = TaskTriggerInfoType.DailyTrigger, TimeOfDayTicks = TimeSpan.FromHours(5).Ticks };
    }

    private static long EstimateTicks(string? path)
    {
        if (string.IsNullOrEmpty(path) || !File.Exists(path))
        {
            return 0;
        }

        var ext = Path.GetExtension(path).ToLowerInvariant();
        double minutes;
        switch (ext)
        {
            case ".pdf":
                using (var pdf = UglyToad.PdfPig.PdfDocument.Open(path))
                {
                    minutes = pdf.NumberOfPages * SecondsPerPdfPage / 60.0;
                }

                break;

            case ".epub":
            case ".zip":
                long textBytes;
                using (var za = ZipFile.OpenRead(path))
                {
                    textBytes = za.Entries
                        .Where(e => e.Name.EndsWith(".html", StringComparison.OrdinalIgnoreCase)
                                 || e.Name.EndsWith(".xhtml", StringComparison.OrdinalIgnoreCase)
                                 || e.Name.EndsWith(".htm", StringComparison.OrdinalIgnoreCase)
                                 || e.Name.EndsWith(".xml", StringComparison.OrdinalIgnoreCase)
                                 || e.Name.EndsWith(".txt", StringComparison.OrdinalIgnoreCase))
                        .Sum(e => e.Length);
                }

                minutes = textBytes / CharsPerWord / WordsPerMinute;
                break;

            case ".txt":
            case ".md":
            case ".markdown":
            case ".html":
            case ".htm":
            case ".xhtml":
                minutes = new FileInfo(path).Length / CharsPerWord / WordsPerMinute;
                break;

            default:
                return 0; // audiobooks/comics/etc.: not ours to estimate
        }

        minutes = Math.Max(5, Math.Min(minutes, 6000));
        return (long)(minutes * TimeSpan.TicksPerMinute);
    }
}
