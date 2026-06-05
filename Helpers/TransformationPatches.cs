namespace Jellyfin.Plugin.A11yBookReader.Helpers;

public static class TransformationPatches
{
    public static string IndexHtml(dynamic payload)
    {
        string version = typeof(TransformationPatches).Assembly.GetName().Version?.ToString() ?? "1.0.0.0";
        string v = $"?v={version}";

        string css     = $"<link rel=\"stylesheet\" href=\"/A11yBookReader/a11y-book-reader.css{v}\" />";
        string script  = $"<script defer src=\"/A11yBookReader/a11y-book-reader.js{v}\"></script>";

        string contents = (string)payload.Contents;
        return contents
            .Replace("</head>", $"{css}</head>", StringComparison.Ordinal)
            .Replace("</body>", $"{script}</body>", StringComparison.Ordinal);
    }
}
