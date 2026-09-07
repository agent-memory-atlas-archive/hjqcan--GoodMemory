# TypeScript utility task

Implement the comparison policy for similarity in src/string/similarity.ts. Project policy: letters are compared without regard to case; whitespace at either end of a string is ignored; a run of whitespace inside a string counts as a single space; accents are ignored, so an accented letter and its base letter are the same letter (the deburr helper already exists for that); a nullish argument is treated as an empty string; the result is the edit distance between the normalized strings, and the argument order never matters. Keep the exported signature unchanged.

Keep the implementation dependency-free and run the visible test.
