# Python utility task

Implement the ragged policy for transpose in more_itertools/recipes.py. Project policy: every row must have the same length, and rows of different lengths raise ValueError instead of being truncated to the shortest; the whole input is read before any column is produced, so that error is raised when transpose is called; an empty input produces no columns; rows may be any iterables, including text, whose characters become cells; a flat row of non-iterables raises TypeError as today; columns keep row order. Keep the signature transpose(it) unchanged.

Keep the implementation dependency-free and run the visible test.
