# TypeScript utility task

Implement the host-strip policy for withoutHost in src/utils.ts. Project policy: the result always starts with exactly one slash, and any run of leading slashes left after the host is removed collapses into it; an empty remaining path becomes a single slash; an input without a protocol or protocol-relative prefix is treated as a bare path and simply gains its leading slash; credentials before the host are discarded along with it; a trailing slash on the path is removed unless the path is only the root; the query string and fragment are preserved verbatim. Keep the exported signature unchanged.

Keep the implementation dependency-free and run the visible test.
