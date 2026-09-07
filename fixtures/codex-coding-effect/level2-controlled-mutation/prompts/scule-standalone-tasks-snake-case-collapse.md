# TypeScript utility task

Update snakeCase in src/index.ts so that a run of two or more separators produces a single underscore instead of several, and so that separators at the start or the end of the input produce no leading or trailing underscore. Words are still found by the existing splitter and lowercased. Keep the exported signature unchanged.

Keep the implementation dependency-free and run the visible test.
