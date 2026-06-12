using System.Diagnostics;
using System.Formats.Tar;
using System.IO.Compression;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using Jellyfin.Plugin.A11yBookReader.Models;
using MediaBrowser.Controller.MediaEncoding;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.A11yBookReader.Services;

public class PiperService
{
    private const string PiperVersion = "2023.11.14-2";
    private const string CatalogUrl = "https://huggingface.co/rhasspy/piper-voices/resolve/main/voices.json";
    private const string VoiceBaseUrl = "https://huggingface.co/rhasspy/piper-voices/resolve/main/";

    private readonly string _binDir;
    private readonly string _voicesDir;
    private readonly HttpClient _http;
    private readonly ILogger<PiperService> _logger;
    private readonly IMediaEncoder _mediaEncoder;

    public PiperService(IHttpClientFactory httpClientFactory, ILogger<PiperService> logger, IMediaEncoder mediaEncoder)
    {
        _http = httpClientFactory.CreateClient("PiperService");
        _http.Timeout = TimeSpan.FromMinutes(15);
        _logger = logger;
        _mediaEncoder = mediaEncoder;

        // Stored next to the plugin DLL so it survives plugin updates
        var pluginDir = Path.GetDirectoryName(typeof(PiperService).Assembly.Location)!;
        _binDir = Path.Combine(pluginDir, "piper-bin");
        _voicesDir = Path.Combine(pluginDir, "piper-voices");
        Directory.CreateDirectory(_binDir);
        Directory.CreateDirectory(_voicesDir);
    }

    // ── Installation ─────────────────────────────────────────────────────────

    public bool IsInstalled() => File.Exists(BinaryPath);

    public string BinaryPath
    {
        get
        {
            var exe = RuntimeInformation.IsOSPlatform(OSPlatform.Windows) ? "piper.exe" : "piper";
            return Path.Combine(_binDir, exe);
        }
    }

    private string DownloadUrl
    {
        get
        {
            string platform;
            string ext;
            if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
            {
                platform = "windows_amd64"; ext = "zip";
            }
            else if (RuntimeInformation.IsOSPlatform(OSPlatform.OSX))
            {
                platform = RuntimeInformation.ProcessArchitecture == Architecture.Arm64 ? "macos_aarch64" : "macos_x64";
                ext = "tar.gz";
            }
            else
            {
                platform = RuntimeInformation.ProcessArchitecture == Architecture.Arm64 ? "linux_aarch64" : "linux_x86_64";
                ext = "tar.gz";
            }
            return $"https://github.com/rhasspy/piper/releases/download/{PiperVersion}/piper_{platform}.{ext}";
        }
    }

    public async Task InstallAsync(CancellationToken ct)
    {
        var url = DownloadUrl;
        _logger.LogInformation("Downloading Piper from {Url}", url);
        var bytes = await _http.GetByteArrayAsync(url, ct).ConfigureAwait(false);

        if (url.EndsWith(".zip", StringComparison.OrdinalIgnoreCase))
        {
            using var zip = new ZipArchive(new MemoryStream(bytes));
            foreach (var entry in zip.Entries)
            {
                var rel = StripTopDir(entry.FullName.Replace('\\', '/'));
                if (string.IsNullOrEmpty(rel) || rel.EndsWith('/')) continue;
                var dest = Path.Combine(_binDir, rel.Replace('/', Path.DirectorySeparatorChar));
                Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
                using var src = entry.Open();
                using var fs = File.Create(dest);
                await src.CopyToAsync(fs, ct).ConfigureAwait(false);
            }
        }
        else
        {
            using var gz = new GZipStream(new MemoryStream(bytes), CompressionMode.Decompress);
            using var tar = new TarReader(gz);
            TarEntry? entry;
            while ((entry = await tar.GetNextEntryAsync(false, ct).ConfigureAwait(false)) != null)
            {
                if (entry.EntryType is not (TarEntryType.RegularFile or TarEntryType.V7RegularFile)) continue;
                var rel = StripTopDir(entry.Name.Replace('\\', '/'));
                if (string.IsNullOrEmpty(rel)) continue;
                var dest = Path.Combine(_binDir, rel.Replace('/', Path.DirectorySeparatorChar));
                Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
                await entry.ExtractToFileAsync(dest, overwrite: true, ct).ConfigureAwait(false);
            }
        }

        // Make binary (and any bundled .so) executable on Unix
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows) && File.Exists(BinaryPath))
        {
            File.SetUnixFileMode(BinaryPath,
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute |
                UnixFileMode.GroupRead | UnixFileMode.GroupExecute |
                UnixFileMode.OtherRead | UnixFileMode.OtherExecute);

            // Create SONAME symlinks: libfoo.so.1.2.3 → libfoo.so.1
            foreach (var lib in Directory.GetFiles(_binDir, "*.so.*"))
            {
                var libName = Path.GetFileName(lib);
                var m = System.Text.RegularExpressions.Regex.Match(libName, @"^(lib.+\.so\.\d+)\.\d+");
                if (!m.Success) continue;
                var linkPath = Path.Combine(_binDir, m.Groups[1].Value);
                if (!Path.Exists(linkPath))
                    File.CreateSymbolicLink(linkPath, libName);
            }
        }

        _logger.LogInformation("Piper installed to {Dir}", _binDir);

        // Ship a working default voice with the engine: without one, a fresh
        // install has ZERO voices and TTS silently routes to the browser/system
        // default, which doesn't exist on TVs and headless platforms. A voice
        // download failure must not roll back the binary install — the UI still
        // offers manual voice downloads.
        if (!HasVoice(DefaultVoiceKey))
        {
            try
            {
                await DownloadVoiceAsync(DefaultVoiceKey, ct).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Default voice '{Key}' download failed; install it manually from the voice catalog", DefaultVoiceKey);
            }
        }
    }

    /// <summary>Voice bundled automatically when Piper is installed.</summary>
    public const string DefaultVoiceKey = "en_US-ryan-medium";

    public bool HasVoice(string key) =>
        !string.IsNullOrWhiteSpace(key) && GetDownloadedKeys().Contains(key);

    // ── Voice catalog ─────────────────────────────────────────────────────────

    public async Task<List<PiperVoiceInfo>> GetCatalogAsync(CancellationToken ct)
    {
        var json = await _http.GetStringAsync(CatalogUrl, ct).ConfigureAwait(false);
        return ParseCatalog(json, GetDownloadedKeys());
    }

    public List<PiperVoiceInfo> GetDownloadedVoices()
    {
        var list = new List<PiperVoiceInfo>();
        foreach (var onnx in Directory.GetFiles(_voicesDir, "*.onnx"))
        {
            var key = Path.GetFileNameWithoutExtension(onnx);
            var (lang, quality, name) = ReadVoiceConfig(onnx + ".json");
            list.Add(new PiperVoiceInfo
            {
                Key = key,
                Name = Capitalize(name),
                DisplayName = BuildDisplayName(name, lang, quality),
                Language = lang,
                Quality = quality,
                Downloaded = true,
                SizeBytes = new FileInfo(onnx).Length,
            });
        }
        return list.OrderBy(v => v.Language).ThenBy(v => v.Key).ToList();
    }

    public Task<byte[]> FetchSampleAsync(string url, CancellationToken ct)
        => _http.GetByteArrayAsync(url, ct);

    public async Task DownloadVoiceAsync(string key, CancellationToken ct)
    {
        var json = await _http.GetStringAsync(CatalogUrl, ct).ConfigureAwait(false);
        using var doc = JsonDocument.Parse(json);

        if (!doc.RootElement.TryGetProperty(key, out var voiceEl))
            throw new InvalidOperationException($"Voice '{key}' not found in catalog");
        if (!voiceEl.TryGetProperty("files", out var files))
            throw new InvalidOperationException($"Voice '{key}' has no files list");

        foreach (var f in files.EnumerateObject())
        {
            var fileName = Path.GetFileName(f.Name);
            if (string.IsNullOrEmpty(fileName)) continue;
            var dest = Path.Combine(_voicesDir, fileName);
            var fileUrl = VoiceBaseUrl + f.Name;
            _logger.LogInformation("Downloading {Url}", fileUrl);
            var data = await _http.GetByteArrayAsync(fileUrl, ct).ConfigureAwait(false);
            await File.WriteAllBytesAsync(dest, data, ct).ConfigureAwait(false);
        }

        _logger.LogInformation("Voice '{Key}' ready", key);
    }

    public void DeleteVoice(string key)
    {
        foreach (var f in new[] { Path.Combine(_voicesDir, key + ".onnx"), Path.Combine(_voicesDir, key + ".onnx.json") })
            if (File.Exists(f)) File.Delete(f);
    }

    // ── Synthesis ─────────────────────────────────────────────────────────────

    public async Task<byte[]> SynthesizeAsync(string text, string voiceKey, CancellationToken ct)
    {
        if (!IsInstalled())
            throw new InvalidOperationException("Piper is not installed");

        var modelPath = Path.Combine(_voicesDir, voiceKey + ".onnx");
        if (!File.Exists(modelPath))
            throw new InvalidOperationException($"Voice model '{voiceKey}' is not downloaded");

        var sampleRate = ReadSampleRate(modelPath + ".json");

        var psi = new ProcessStartInfo
        {
            FileName = BinaryPath,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        psi.ArgumentList.Add("--model");
        psi.ArgumentList.Add(modelPath);
        psi.ArgumentList.Add("--espeak-data");
        psi.ArgumentList.Add(Path.Combine(_binDir, "espeak-ng-data"));
        psi.ArgumentList.Add("--output-raw");

        // Piper needs to find its bundled .so files on Linux
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            var existing = Environment.GetEnvironmentVariable("LD_LIBRARY_PATH") ?? string.Empty;
            psi.Environment["LD_LIBRARY_PATH"] = existing.Length > 0 ? $"{_binDir}:{existing}" : _binDir;
        }

        using var proc = new Process { StartInfo = psi };
        proc.Start();

        await proc.StandardInput.WriteAsync(text).ConfigureAwait(false);
        proc.StandardInput.Close();

        using var ms = new MemoryStream();
        await proc.StandardOutput.BaseStream.CopyToAsync(ms, ct).ConfigureAwait(false);
        await proc.WaitForExitAsync(ct).ConfigureAwait(false);

        if (proc.ExitCode != 0)
        {
            var err = await proc.StandardError.ReadToEndAsync(ct).ConfigureAwait(false);
            throw new InvalidOperationException($"Piper exited {proc.ExitCode}: {err}");
        }

        return BuildWav(ms.ToArray(), sampleRate);
    }

    /// <summary>Raw 16-bit mono PCM for one text fragment (no WAV header), at 1x.</summary>
    private async Task<byte[]> SynthesizePcmAsync(string text, string modelPath, CancellationToken ct)
    {
        var psi = new ProcessStartInfo
        {
            FileName = BinaryPath,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        psi.ArgumentList.Add("--model");
        psi.ArgumentList.Add(modelPath);
        psi.ArgumentList.Add("--espeak-data");
        psi.ArgumentList.Add(Path.Combine(_binDir, "espeak-ng-data"));
        psi.ArgumentList.Add("--output-raw");
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            var existing = Environment.GetEnvironmentVariable("LD_LIBRARY_PATH") ?? string.Empty;
            psi.Environment["LD_LIBRARY_PATH"] = existing.Length > 0 ? $"{_binDir}:{existing}" : _binDir;
        }
        using var proc = new Process { StartInfo = psi };
        proc.Start();
        await proc.StandardInput.WriteAsync(text).ConfigureAwait(false);
        proc.StandardInput.Close();
        using var ms = new MemoryStream();
        await proc.StandardOutput.BaseStream.CopyToAsync(ms, ct).ConfigureAwait(false);
        await proc.WaitForExitAsync(ct).ConfigureAwait(false);
        if (proc.ExitCode != 0)
        {
            var err = await proc.StandardError.ReadToEndAsync(ct).ConfigureAwait(false);
            throw new InvalidOperationException($"Piper exited {proc.ExitCode}: {err}");
        }
        return ms.ToArray();
    }

    /// <summary>What StreamTimedAsync emits (iOS needs MP3 for live streams).</summary>
    public string TimedStreamContentType => FfmpegPath != null ? "audio/mpeg" : "audio/wav";

    /// <summary>
    /// Stream the text as audio, synthesized sentence-by-sentence, recording each
    /// sentence's REAL timing into <paramref name="spansOut"/>. Speed is BAKED in
    /// (ffmpeg atempo) — iOS ignores playbackRate on live streams — and the spans
    /// are in OUTPUT time (already divided by rate) so they align with the audio's
    /// currentTime. First audio flushes after sentence 1; synthesis is ~15x
    /// realtime so it stays far ahead of playback.
    /// </summary>
    public async Task StreamTimedAsync(string text, string voiceKey, double rate, Stream output,
        List<SentenceSpan> spansOut, object spansLock, CancellationToken ct)
    {
        if (!IsInstalled()) throw new InvalidOperationException("Piper is not installed");
        var modelPath = Path.Combine(_voicesDir, voiceKey + ".onnx");
        if (!File.Exists(modelPath))
            throw new InvalidOperationException($"Voice model '{voiceKey}' is not downloaded");
        var sampleRate = ReadSampleRate(modelPath + ".json");
        var ffmpegPath = FfmpegPath;
        var clampedRate = Math.Clamp(rate, 0.25, 3.0);

        long totalSamples = 0;
        void RecordSpan(int len, int start, int end)
        {
            // Output media-time = 1x-time / rate (atempo compresses the audio).
            int startMs = (int)(totalSamples * 1000.0 / sampleRate / clampedRate);
            totalSamples += len / 2; // 16-bit mono
            int endMs = (int)(totalSamples * 1000.0 / sampleRate / clampedRate);
            lock (spansLock)
                spansOut.Add(new SentenceSpan { CharStart = start, CharEnd = end, StartMs = startMs, EndMs = endMs });
        }

        // Need ffmpeg for atempo (exact speed, pitch preserved) and MP3 (iOS).
        if (ffmpegPath == null)
        {
            // Fallback: raw WAV at 1x (desktop only; no speed without ffmpeg)
            await output.WriteAsync(BuildStreamingWavHeader(sampleRate), ct).ConfigureAwait(false);
            await output.FlushAsync(ct).ConfigureAwait(false);
            foreach (var (sentence, start, end) in SplitSentences(text))
            {
                ct.ThrowIfCancellationRequested();
                var pcm = await SynthesizePcmAsync(sentence, modelPath, ct).ConfigureAwait(false);
                RecordSpan(pcm.Length, start, end);
                await output.WriteAsync(pcm, 0, pcm.Length, ct).ConfigureAwait(false);
                await output.FlushAsync(ct).ConfigureAwait(false);
            }
            return;
        }

        var fpsi = new ProcessStartInfo
        {
            FileName = ffmpegPath,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        fpsi.ArgumentList.Add("-hide_banner");
        fpsi.ArgumentList.Add("-loglevel"); fpsi.ArgumentList.Add("error");
        fpsi.ArgumentList.Add("-f"); fpsi.ArgumentList.Add("s16le");
        fpsi.ArgumentList.Add("-ar"); fpsi.ArgumentList.Add(sampleRate.ToString(System.Globalization.CultureInfo.InvariantCulture));
        fpsi.ArgumentList.Add("-ac"); fpsi.ArgumentList.Add("1");
        fpsi.ArgumentList.Add("-i"); fpsi.ArgumentList.Add("pipe:0");
        if (Math.Abs(clampedRate - 1.0) > 0.001)
        {
            fpsi.ArgumentList.Add("-af"); fpsi.ArgumentList.Add(BuildAtempoChain(clampedRate));
        }
        fpsi.ArgumentList.Add("-f"); fpsi.ArgumentList.Add("mp3");
        fpsi.ArgumentList.Add("-b:a"); fpsi.ArgumentList.Add("64k");
        fpsi.ArgumentList.Add("pipe:1");

        using var ff = new Process { StartInfo = fpsi };
        ff.Start();
        var pump = Task.Run(async () =>
        {
            try { await ff.StandardOutput.BaseStream.CopyToAsync(output, ct).ConfigureAwait(false); }
            catch { /* client closed */ }
        }, ct);

        try
        {
            foreach (var (sentence, start, end) in SplitSentences(text))
            {
                ct.ThrowIfCancellationRequested();
                var pcm = await SynthesizePcmAsync(sentence, modelPath, ct).ConfigureAwait(false);
                RecordSpan(pcm.Length, start, end);
                await ff.StandardInput.BaseStream.WriteAsync(pcm, 0, pcm.Length, ct).ConfigureAwait(false);
                await ff.StandardInput.BaseStream.FlushAsync(ct).ConfigureAwait(false);
            }
            ff.StandardInput.Close();
            await pump.ConfigureAwait(false);
            await ff.WaitForExitAsync(ct).ConfigureAwait(false);
        }
        finally
        {
            try { if (!ff.HasExited) ff.Kill(entireProcessTree: true); } catch { }
        }
    }

    /// <summary>Split into sentences, yielding each with its char offsets in the source.</summary>
    private static IEnumerable<(string Text, int Start, int End)> SplitSentences(string text)
    {
        int i = 0, n = text.Length;
        while (i < n)
        {
            while (i < n && char.IsWhiteSpace(text[i])) i++;
            if (i >= n) break;
            int start = i;
            while (i < n)
            {
                char c = text[i];
                if (c is '.' or '!' or '?')
                {
                    int j = i + 1;
                    while (j < n && (text[j] is '"' or '\'' or ')' or ']' or '”' or '’')) j++;
                    if (j >= n || char.IsWhiteSpace(text[j])) { i = j; break; }
                }
                i++;
            }
            int end = i;
            var s = text.Substring(start, end - start).Trim();
            if (s.Length > 0) yield return (s, start, end);
        }
    }

    // Jellyfin's bundled ffmpeg — used to encode the TTS stream as MP3.
    private string? FfmpegPath
    {
        get
        {
            var p = _mediaEncoder.EncoderPath;
            return !string.IsNullOrEmpty(p) && File.Exists(p) ? p : null;
        }
    }

    // What SynthesizeStreamAsync will actually emit (controller sets the header).
    public string StreamContentType => FfmpegPath != null ? "audio/mpeg" : "audio/wav";

    // Streams synthesized audio to <paramref name="output"/> as it is produced —
    // playback can begin after the first synthesized sentence instead of waiting
    // for the whole text.
    // Piper's raw PCM is piped through Jellyfin's ffmpeg into MP3: iOS's
    // AVFoundation refuses chunked unknown-length WAV (it probes with
    // Range: bytes=0-1 and drops the connection on our 200), but plays endless
    // MP3 streams fine — as do Chrome and webOS, so MP3 is the single path for
    // every platform. Falls back to 0xFFFFFFFF-length WAV when ffmpeg is missing.
    // Speed must be applied server-side (browsers ignore playbackRate on
    // unknown-length streams): ffmpeg's atempo gives the exact rate with pitch
    // preserved. Piper's own --length_scale under-applies (a 3.0 request
    // measured ~1.67×) and is used only by the WAV fallback as a best effort.
    public async Task SynthesizeStreamAsync(string text, string voiceKey, double rate, Stream output, CancellationToken ct)
    {
        if (!IsInstalled())
            throw new InvalidOperationException("Piper is not installed");

        var modelPath = Path.Combine(_voicesDir, voiceKey + ".onnx");
        if (!File.Exists(modelPath))
            throw new InvalidOperationException($"Voice model '{voiceKey}' is not downloaded");

        var sampleRate = ReadSampleRate(modelPath + ".json");

        var psi = new ProcessStartInfo
        {
            FileName = BinaryPath,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        psi.ArgumentList.Add("--model");
        psi.ArgumentList.Add(modelPath);
        psi.ArgumentList.Add("--espeak-data");
        psi.ArgumentList.Add(Path.Combine(_binDir, "espeak-ng-data"));
        psi.ArgumentList.Add("--output-raw");

        var ffmpegPath = FfmpegPath;
        var clampedRate = Math.Clamp(rate, 0.25, 3.0);

        // Without ffmpeg the WAV fallback can only approximate speed via piper's
        // --length_scale (the model under-applies it — a 3.0 request measured
        // ~1.67×). With ffmpeg the exact rate is applied by atempo below instead.
        if (ffmpegPath == null && Math.Abs(clampedRate - 1.0) > 0.001)
        {
            psi.ArgumentList.Add("--length_scale");
            psi.ArgumentList.Add((1.0 / clampedRate).ToString("0.###", System.Globalization.CultureInfo.InvariantCulture));
        }

        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            var existing = Environment.GetEnvironmentVariable("LD_LIBRARY_PATH") ?? string.Empty;
            psi.Environment["LD_LIBRARY_PATH"] = existing.Length > 0 ? $"{_binDir}:{existing}" : _binDir;
        }

        using var proc = new Process { StartInfo = psi };
        proc.Start();

        Process? ff = null;
        if (ffmpegPath != null)
        {
            var fpsi = new ProcessStartInfo
            {
                FileName = ffmpegPath,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            var ffArgs = new List<string>
            {
                "-hide_banner", "-loglevel", "error",
                "-f", "s16le", "-ar", sampleRate.ToString(System.Globalization.CultureInfo.InvariantCulture), "-ac", "1",
                "-i", "pipe:0",
            };
            if (Math.Abs(clampedRate - 1.0) > 0.001)
            {
                // Exact speed change with pitch preserved (WSOLA time-stretch)
                ffArgs.Add("-af");
                ffArgs.Add(BuildAtempoChain(clampedRate));
            }
            ffArgs.AddRange(new[] { "-f", "mp3", "-b:a", "64k", "pipe:1" });
            foreach (var arg in ffArgs)
            {
                fpsi.ArgumentList.Add(arg);
            }

            ff = new Process { StartInfo = fpsi };
            ff.Start();
        }

        try
        {
            // Source of the bytes we send to the client: ffmpeg's MP3 when
            // available, otherwise piper's raw PCM behind a streaming WAV header.
            Stream encoded;
            Task? pcmPump = null;
            if (ff != null)
            {
                encoded = ff.StandardOutput.BaseStream;
                // piper PCM → ffmpeg stdin, concurrently with the read loop below
                pcmPump = Task.Run(async () =>
                {
                    try
                    {
                        await proc.StandardOutput.BaseStream.CopyToAsync(ff.StandardInput.BaseStream, ct).ConfigureAwait(false);
                    }
                    finally
                    {
                        ff.StandardInput.Close();   // EOF → ffmpeg flushes its last MP3 frames
                    }
                }, ct);
            }
            else
            {
                encoded = proc.StandardOutput.BaseStream;
                await output.WriteAsync(BuildStreamingWavHeader(sampleRate), ct).ConfigureAwait(false);
                await output.FlushAsync(ct).ConfigureAwait(false);
            }

            // Feed text on a background task so synthesis output can flow concurrently
            var stdinTask = Task.Run(async () =>
            {
                await proc.StandardInput.WriteAsync(text).ConfigureAwait(false);
                proc.StandardInput.Close();
            }, ct);

            var buffer = new byte[16384];
            int read;
            while ((read = await encoded.ReadAsync(buffer, ct).ConfigureAwait(false)) > 0)
            {
                await output.WriteAsync(buffer.AsMemory(0, read), ct).ConfigureAwait(false);
                await output.FlushAsync(ct).ConfigureAwait(false);
            }

            await stdinTask.ConfigureAwait(false);
            if (pcmPump != null) await pcmPump.ConfigureAwait(false);
            await proc.WaitForExitAsync(ct).ConfigureAwait(false);

            if (proc.ExitCode != 0)
            {
                var err = await proc.StandardError.ReadToEndAsync(CancellationToken.None).ConfigureAwait(false);
                _logger.LogError("Piper stream exited {Code}: {Err}", proc.ExitCode, err);
            }

            if (ff != null)
            {
                await ff.WaitForExitAsync(ct).ConfigureAwait(false);
                if (ff.ExitCode != 0)
                {
                    var ferr = await ff.StandardError.ReadToEndAsync(CancellationToken.None).ConfigureAwait(false);
                    _logger.LogError("ffmpeg TTS encode exited {Code}: {Err}", ff.ExitCode, ferr);
                }
            }
        }
        finally
        {
            // Client disconnected or error — don't leave zombie processes running
            if (!proc.HasExited)
            {
                try { proc.Kill(entireProcessTree: true); } catch { /* already gone */ }
            }
            if (ff != null)
            {
                if (!ff.HasExited)
                {
                    try { ff.Kill(entireProcessTree: true); } catch { /* already gone */ }
                }
                ff.Dispose();
            }
        }
    }

    // atempo accepts 0.5–2.0 per instance; chain two equal factors to cover the
    // reader's 0.25–3.0 speed range exactly (√r · √r = r).
    private static string BuildAtempoChain(double rate)
    {
        if (rate >= 0.5 && rate <= 2.0)
            return "atempo=" + rate.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture);
        var f = Math.Sqrt(rate).ToString("0.###", System.Globalization.CultureInfo.InvariantCulture);
        return $"atempo={f},atempo={f}";
    }

    private static byte[] BuildStreamingWavHeader(int sampleRate, int channels = 1, int bitsPerSample = 16)
    {
        using var ms = new MemoryStream(44);
        using var w = new BinaryWriter(ms, Encoding.ASCII, leaveOpen: true);
        w.Write("RIFF"u8);
        w.Write(0xFFFFFFFF);                                      // unknown total size (live stream)
        w.Write("WAVE"u8);
        w.Write("fmt "u8);
        w.Write(16);
        w.Write((short)1);                                        // PCM
        w.Write((short)channels);
        w.Write(sampleRate);
        w.Write(sampleRate * channels * bitsPerSample / 8);      // byte rate
        w.Write((short)(channels * bitsPerSample / 8));          // block align
        w.Write((short)bitsPerSample);
        w.Write("data"u8);
        w.Write(0xFFFFFFFF);                                      // unknown data size
        return ms.ToArray();
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private static string StripTopDir(string path)
    {
        var idx = path.IndexOf('/');
        return idx >= 0 ? path.Substring(idx + 1) : path;
    }

    private HashSet<string> GetDownloadedKeys() =>
        Directory.GetFiles(_voicesDir, "*.onnx")
            .Select(f => Path.GetFileNameWithoutExtension(f))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

    private static List<PiperVoiceInfo> ParseCatalog(string json, HashSet<string> downloaded)
    {
        using var doc = JsonDocument.Parse(json);
        var list = new List<PiperVoiceInfo>();

        foreach (var prop in doc.RootElement.EnumerateObject())
        {
            var key = prop.Name;
            var v = prop.Value;

            var langCode = "unknown";
            var langName = key;
            var country = string.Empty;
            var langFamily = string.Empty;
            if (v.TryGetProperty("language", out var lang))
            {
                langCode   = lang.TryGetProperty("code",            out var c)  ? c.GetString()  ?? key            : key;
                langFamily = lang.TryGetProperty("family",          out var fam) ? fam.GetString() ?? string.Empty : string.Empty;
                langName   = lang.TryGetProperty("name_english",    out var ne) ? ne.GetString()  ?? langCode      : langCode;
                country    = lang.TryGetProperty("country_english", out var cn) ? cn.GetString()  ?? string.Empty  : string.Empty;
            }

            var quality = v.TryGetProperty("quality", out var q) ? q.GetString() ?? "medium" : "medium";
            var name = v.TryGetProperty("name", out var n) ? n.GetString() ?? key : key;

            long sizeBytes = 0;
            if (v.TryGetProperty("files", out var files))
                foreach (var f in files.EnumerateObject())
                    if (f.Name.EndsWith(".onnx", StringComparison.OrdinalIgnoreCase) && f.Value.TryGetProperty("size_bytes", out var sz))
                        sizeBytes = sz.GetInt64();

            // Pre-generated MP3 samples hosted on piper-samples GitHub Pages
            // URL format: samples/{family}/{langCode}/{name}/{quality}/speaker_0.mp3
            var sampleUrl = string.IsNullOrEmpty(langFamily)
                ? null
                : $"https://rhasspy.github.io/piper-samples/samples/{langFamily}/{langCode}/{name}/{quality}/speaker_0.mp3";

            list.Add(new PiperVoiceInfo
            {
                Key = key,
                Name = Capitalize(name),
                DisplayName = BuildDisplayName(name, country.Length > 0 ? $"{langName} ({country})" : langName, quality),
                Language = langName,
                Quality = quality,
                Downloaded = downloaded.Contains(key),
                SizeBytes = sizeBytes,
                SampleUrl = sampleUrl,
            });
        }

        return list.OrderBy(v => v.Language).ThenBy(v => v.Key).ToList();
    }

    private static string Capitalize(string s) =>
        string.IsNullOrEmpty(s) ? s : char.ToUpperInvariant(s[0]) + s[1..];

    private static string BuildDisplayName(string name, string lang, string quality)
        => $"{Capitalize(name)} · {lang} · {quality}";

    private static (string lang, string quality, string name) ReadVoiceConfig(string configPath)
    {
        var fallbackName = Path.GetFileNameWithoutExtension(configPath);
        if (!File.Exists(configPath)) return ("unknown", "medium", fallbackName);
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(configPath));
            var root = doc.RootElement;
            // Piper nests quality under "audio" in the voice config (the
            // catalog has it top-level) — reading the root made every
            // downloaded voice fall back to "medium" in the reader dropdown.
            var quality = root.TryGetProperty("audio", out var audio) && audio.TryGetProperty("quality", out var q)
                ? q.GetString() ?? "medium"
                : (fallbackName.Contains('-') ? fallbackName[(fallbackName.LastIndexOf('-') + 1)..].Replace(".onnx", string.Empty) : "medium");
            var name = root.TryGetProperty("dataset", out var ds) ? ds.GetString() ?? fallbackName : fallbackName;
            string lang = "Unknown";
            if (root.TryGetProperty("language", out var langEl))
            {
                var nameEn  = langEl.TryGetProperty("name_english",    out var ne) ? ne.GetString() : null;
                var country = langEl.TryGetProperty("country_english",  out var cn) ? cn.GetString() : null;
                lang = nameEn != null
                    ? (country != null ? $"{nameEn} ({country})" : nameEn)
                    : (langEl.TryGetProperty("code", out var c) ? c.GetString() ?? "Unknown" : "Unknown");
            }
            return (lang, quality, name);
        }
        catch { return ("unknown", "medium", fallbackName); }
    }

    private static int ReadSampleRate(string configPath)
    {
        try
        {
            if (!File.Exists(configPath)) return 22050;
            using var doc = JsonDocument.Parse(File.ReadAllText(configPath));
            if (doc.RootElement.TryGetProperty("audio", out var audio) &&
                audio.TryGetProperty("sample_rate", out var sr))
                return sr.GetInt32();
        }
        catch { /* ignore */ }
        return 22050;
    }

    private static byte[] BuildWav(byte[] pcm, int sampleRate, int channels = 1, int bitsPerSample = 16)
    {
        using var ms = new MemoryStream(44 + pcm.Length);
        using var w = new BinaryWriter(ms, Encoding.ASCII, leaveOpen: true);
        w.Write("RIFF"u8);
        w.Write(36 + pcm.Length);
        w.Write("WAVE"u8);
        w.Write("fmt "u8);
        w.Write(16);
        w.Write((short)1);                                        // PCM
        w.Write((short)channels);
        w.Write(sampleRate);
        w.Write(sampleRate * channels * bitsPerSample / 8);      // byte rate
        w.Write((short)(channels * bitsPerSample / 8));          // block align
        w.Write((short)bitsPerSample);
        w.Write("data"u8);
        w.Write(pcm.Length);
        ms.Write(pcm);
        return ms.ToArray();
    }
}
