# TypeScript utility task

Implement the fragment-encoding policy for encodeHash in src/encoding.ts. Project policy: surrounding whitespace is trimmed before encoding; a single leading hash is preserved verbatim, while every other hash in the text encodes as its percent form; a percent sign followed by two hex digits is already encoded and is never encoded again; spaces encode as their percent form; curly braces, caret, pipe, and backtick stay literal; non-ASCII text is UTF-8 percent-encoded. Keep the exported signature unchanged.

Keep the implementation dependency-free and run the visible test.
