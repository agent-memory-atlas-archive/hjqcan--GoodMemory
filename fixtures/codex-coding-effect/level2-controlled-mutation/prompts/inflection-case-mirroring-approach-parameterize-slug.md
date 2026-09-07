# Python utility task

Implement the slug policy for parameterize in inflection/__init__.py. Project policy: apostrophes are deleted before any other step so a contraction stays one word; an ampersand is spelled out as the word and, set off from its neighbours as a word of its own; underscores count as unwanted characters and turn into the separator like any other punctuation; hyphens already present are kept; every run of unwanted characters becomes exactly one separator, and separators at the start or end of the result are removed; non-ASCII letters are transliterated first and the result is lowercase, as today; when the separator argument is empty the unwanted characters are simply removed. Keep the exported signature unchanged.

Keep the implementation dependency-free and run the visible test.
