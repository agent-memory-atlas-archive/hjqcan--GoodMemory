# TypeScript utility task

Apply the accepted query-serialization policy, as corrected in review, to withQuery in src/utils.ts, changing the query helpers in src/query.ts as needed: both the query already present on the input and the merged values are re-serialized under the policy, a merged key replaces an existing key, and the fragment is preserved. Keep the exported signature unchanged.

Keep the implementation dependency-free and run the visible test.
