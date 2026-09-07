# TypeScript utility task

Implement the leading-slash policy for withLeadingSlash in src/utils.ts. Project policy: surrounding whitespace is trimmed first; an empty input becomes a single slash; an input that carries a protocol or a protocol-relative prefix is returned unchanged; an input that starts with a hash or a question mark is returned unchanged; a leading backslash counts as the leading slash and is rewritten as a forward slash; otherwise a single slash is prefixed. Keep the exported signature unchanged.

Keep the implementation dependency-free and run the visible test.
