# TypeScript utility task

Implement the inversion policy for invert in src/object/invert.ts. Project policy: when several keys share a value, the first key in insertion order wins and later keys are ignored; a nullish value is skipped, so it never becomes a key; an array value is expanded so that each of its elements maps back to the key, and the first-wins rule applies element by element; any other value becomes a key through the usual string conversion of property keys; only own enumerable entries of the input are read; a nullish input yields an empty object. Keep the exported signature unchanged.

Keep the implementation dependency-free and run the visible test.
