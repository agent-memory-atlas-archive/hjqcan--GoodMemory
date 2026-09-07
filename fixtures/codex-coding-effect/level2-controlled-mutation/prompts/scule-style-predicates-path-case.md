# TypeScript utility task

Implement the path policy for a new exported pathCase in src/index.ts placed next to kebabCase. Project policy: words are split on case edges the way the existing splitter does it and on hyphen, underscore, dot, slash and whitespace runs; every word is lowercased and the words are joined by single slashes; empty words are dropped so repeated separators collapse; a leading slash on the input is kept as a leading slash on the output, while a trailing slash is dropped; an input without any word, including the empty string and inputs made only of separators, yields an empty string; an array argument is a list of already split words. Keep existing exported signatures unchanged.

Keep the implementation dependency-free and run the visible test.
