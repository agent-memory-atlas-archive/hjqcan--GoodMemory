# TypeScript utility task

Update flatCase in src/index.ts so that its output contains only lowercase letters and digits: decompose accented letters and drop their combining marks, then remove every remaining character that is neither a letter nor a digit, whitespace and punctuation included, and lowercase the result. Keep the exported signature unchanged.

Keep the implementation dependency-free and run the visible test.
