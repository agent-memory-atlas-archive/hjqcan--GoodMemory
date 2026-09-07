# TypeScript utility task

Implement the slash-collapse policy for cleanDoubleSlashes in src/utils.ts. Project policy: runs of two or more slashes inside the path collapse to one; the double slash that follows a protocol is preserved; a protocol-relative prefix of two leading slashes without a protocol is preserved; slashes inside the query string or the fragment are never touched; an input made only of slashes becomes a single slash; an empty input stays empty. Keep the exported signature unchanged.

Keep the implementation dependency-free and run the visible test.
