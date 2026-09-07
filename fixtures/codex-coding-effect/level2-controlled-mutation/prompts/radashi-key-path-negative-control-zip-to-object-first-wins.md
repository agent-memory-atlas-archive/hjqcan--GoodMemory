# TypeScript utility task

Implement the key-assignment policy for zipToObject in src/array/zipToObject.ts. Project policy: when the same key appears more than once, the first occurrence wins and later ones are ignored; when the values are given as a list, a key with no value at its position is omitted from the result rather than mapped to undefined; extra values beyond the keys are ignored; a nullish key is skipped; a mapper function is called once per kept key with the key and its position; a scalar value is assigned to every kept key; a nullish or empty key list yields an empty object. Keep the exported signature unchanged.

Keep the implementation dependency-free and run the visible test.
