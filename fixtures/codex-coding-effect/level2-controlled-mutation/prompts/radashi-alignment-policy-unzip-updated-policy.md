# TypeScript utility task

Update to the accepted alignment policy: the padding rule is superseded. An incomplete group is no longer padded; it is dropped instead, so cluster keeps only full groups, and zip and unzip stop at the length of the shortest input list. All other rules of the policy stand. Apply the updated policy to unzip in src/array/unzip.ts and keep the exported signature unchanged.

Keep the implementation dependency-free and run the visible test.
