# TypeScript utility task

Implement the file-name policy for parseFilename in src/parse.ts. Project policy: the file name is the final path segment after the query string and fragment are removed; it is percent-decoded and trimmed of surrounding whitespace; an input without any slash is itself a bare file name; when the path ends with a slash, or nothing is left after trimming, the function returns an empty string rather than undefined; in strict mode a name only counts when it has an extension, meaning a dot that is neither its first nor its last character, and otherwise the empty string is returned. Keep the exported signature unchanged.

Keep the implementation dependency-free and run the visible test.
