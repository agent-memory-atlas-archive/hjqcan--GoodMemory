# Python utility task

Implement the separator policy for intersperse in more_itertools/more.py. Project policy: a spacing below one raises ValueError; a separator given as a list is spliced, that is, its items are inserted one by one at every gap, and an empty list inserts nothing; any other separator, including text and None, is inserted as a single item; a separator never appears before the first item or after the last one; the spacing counts input items between separators, and the final run may be shorter; an empty input yields nothing. Keep the signature intersperse(e, iterable, n) unchanged.

Keep the implementation dependency-free and run the visible test.
