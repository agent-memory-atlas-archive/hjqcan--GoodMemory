# TypeScript utility task

Implement the punctuation policy for pascalCase in src/index.ts. Project policy: any character that is neither a letter nor a digit acts as a word separator, whitespace and punctuation included, in addition to the existing case edges; runs of separators never produce empty words, and separators at either end are dropped; with the normalize option every word is lowercased before its first letter is uppercased, and without it the rest of each word is kept as it was; an array argument supplies the words directly and empty items are skipped; an empty or non-string input yields an empty string. Keep the exported signature unchanged.

Keep the implementation dependency-free and run the visible test.
