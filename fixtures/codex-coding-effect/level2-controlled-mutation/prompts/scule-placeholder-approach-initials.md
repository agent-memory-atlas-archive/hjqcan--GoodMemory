# TypeScript utility task

Implement the initials policy for a new exported initials in src/index.ts placed next to lowerFirst. Project policy: words are split on case edges the way the existing splitter does it and on hyphen, underscore, dot, slash and whitespace runs; the first character of each word is taken and uppercased, and the initials are joined with nothing between them; a word that starts with a digit contributes nothing; empty words are skipped; at most two initials are returned by default, and an optional second argument sets a different maximum; an empty or non-string input yields an empty string. Keep existing exported signatures unchanged.

Keep the implementation dependency-free and run the visible test.
