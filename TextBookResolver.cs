using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Resolvers;

namespace Jellyfin.Plugin.A11yBookReader;

/// <summary>
/// Lets book libraries index formats the core BookResolver ignores: plain
/// text (.txt/.md/.html/.xml), documents (.fb2/.odt/.odp/.docx/.pptx/.rtf
/// families) and text DAISY zips. The reader serves them through the
/// matching format service.
/// </summary>
public class TextBookResolver : ItemResolver<Book>
{
    /// <inheritdoc />
    public override ResolverPriority Priority => ResolverPriority.Plugin;

    /// <inheritdoc />
    protected override Book? Resolve(ItemResolveArgs args)
    {
        if (args.IsDirectory) return null;
        if (args.CollectionType != CollectionType.books) return null;

        var isText = Services.TextFormatService.HandlesPath(args.Path);
        var isDoc = !isText && Services.DocFormatService.HandlesPath(args.Path);
        // .zip only when it actually sniffs as DAISY — generic zips (and
        // renamed comic archives) stay untouched
        var isDaisy = !isText && !isDoc && Services.DaisyFormatService.SniffsAsDaisy(args.Path);
        if (!isText && !isDoc && !isDaisy) return null;

        return new Book
        {
            Path = args.Path,
            IsInMixedFolder = true,
        };
    }
}
