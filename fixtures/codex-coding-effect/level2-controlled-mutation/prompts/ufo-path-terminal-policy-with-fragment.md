# TypeScript utility task

Implement the fragment policy for withFragment in src/utils.ts. Project policy: the fragment argument may arrive with or without its leading hash and is stored with exactly one hash; surrounding whitespace in the fragment argument is trimmed first; an empty or hash-only fragment removes any existing fragment from the input; fragment text is kept verbatim with no percent-encoding; the query string of the input is preserved. Keep the exported signature unchanged.

Keep the implementation dependency-free and run the visible test.
