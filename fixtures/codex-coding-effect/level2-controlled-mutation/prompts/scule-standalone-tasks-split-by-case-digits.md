# TypeScript utility task

Update splitByCase in src/index.ts so that a run of digits becomes its own part: the letters before a digit run and the letters after it end up in separate parts, and the digit run is returned as one part of its own. Keep separator handling and the existing case-edge behaviour otherwise unchanged, and keep the exported signature unchanged.

Keep the implementation dependency-free and run the visible test.
