# TypeScript utility task

Implement the fragment-removal policy for withoutFragment in src/utils.ts. Project policy: surrounding whitespace is trimmed first; everything from the first hash onward is removed; a question mark left dangling at the end, meaning an empty query, is removed as well; an input that is empty or consists only of a fragment becomes a single slash; the protocol, host, path, and any non-empty query are otherwise preserved verbatim. Keep the exported signature unchanged.

Keep the implementation dependency-free and run the visible test.
