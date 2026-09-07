# TypeScript utility task

Review feedback on the query-serialization policy: the user rejects the rule that an array renders as repeated pairs with bracketed keys. Corrected rule, which replaces it from now on: an array renders as exactly one pair whose value is the entries joined by a comma, where each entry is normalized and encoded on its own and any comma inside an entry is encoded as its percent form before joining; the other array rules stay as accepted, so nullish or empty entries are dropped, a repeated entry keeps only its first occurrence, and an array with nothing left renders as the bare key. Apply the corrected query-serialization policy to stringifyQuery in src/query.ts so that every item it emits follows the corrected policy, and keep the exported signature unchanged.

Keep the implementation dependency-free and run the visible test.
