# TypeScript utility task

Implement the sift policy for sift in src/array/sift.ts. Project policy: sift drops only nullish values, empty strings, strings made entirely of whitespace, and NaN; zero and false are kept because they are meaningful values; a nested array, even an empty one, is kept as an item and the list is never flattened; the order of the kept items is preserved; a nullish list yields an empty list. Keep the exported signature unchanged.

Keep the implementation dependency-free and run the visible test.
