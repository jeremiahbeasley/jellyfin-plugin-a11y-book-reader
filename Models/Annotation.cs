namespace Jellyfin.Plugin.A11yBookReader.Models;

/// <summary>
/// A user annotation on a book, after the W3C Web Annotation model
/// (https://www.w3.org/TR/annotation-model/): the target is a Locator (the
/// same quote + position selector shape as reading progress, so annotations
/// survive re-rendering and layout changes), the optional body is the user's
/// note. Type maps to the annotation "motivation": bookmark / highlight / note.
/// </summary>
public class Annotation
{
    public Guid Id { get; set; }

    /// <summary>bookmark | highlight | note.</summary>
    public string Type { get; set; } = "bookmark";

    /// <summary>Where in the book this annotation is anchored.</summary>
    public Locator Target { get; set; } = new();

    /// <summary>The user's note text (note type; optional on highlight).</summary>
    public string? Body { get; set; }

    /// <summary>Highlight color name (validated against a fixed set).</summary>
    public string? Color { get; set; }

    public DateTime Created { get; set; }

    public DateTime Updated { get; set; }
}

/// <summary>POST payload for creating an annotation.</summary>
public class SaveAnnotationRequest
{
    public string Type { get; set; } = "bookmark";

    public string? Href { get; set; }

    public LocatorLocations? Locations { get; set; }

    public LocatorText? Text { get; set; }

    public string? Body { get; set; }

    public string? Color { get; set; }
}

/// <summary>POST payload for updating an annotation's body/color.</summary>
public class UpdateAnnotationRequest
{
    public string? Body { get; set; }

    public string? Color { get; set; }
}
