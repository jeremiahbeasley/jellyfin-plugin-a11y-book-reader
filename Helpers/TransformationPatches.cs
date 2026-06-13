namespace Jellyfin.Plugin.A11yBookReader.Helpers;

public static class TransformationPatches
{
    private const string Marker = "/A11yBookReader/a11y-book-reader.js";

    /// <summary>
    /// Inject the reader's stylesheet and script into the web client index.html.
    /// Idempotent — returns the input unchanged if already injected. Used by the
    /// plugin's own response-injection middleware (no File Transformation dependency).
    /// </summary>
    public static string Inject(string html)
    {
        if (string.IsNullOrEmpty(html) || html.Contains(Marker, StringComparison.Ordinal))
            return html;

        var version = typeof(TransformationPatches).Assembly.GetName().Version?.ToString() ?? "1.0.0.0";
        var v = "?v=" + version;
        var css = "<link rel=\"stylesheet\" href=\"/A11yBookReader/a11y-book-reader.css" + v + "\" />";
        var script = "<script defer src=\"/A11yBookReader/a11y-book-reader.js" + v + "\"></script>";

        return html
            .Replace("</head>", css + "</head>", StringComparison.Ordinal)
            .Replace("</body>", script + "</body>", StringComparison.Ordinal);
    }
}
