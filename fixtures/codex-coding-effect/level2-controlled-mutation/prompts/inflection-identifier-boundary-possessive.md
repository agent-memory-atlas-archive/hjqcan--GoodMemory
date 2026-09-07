# Python utility task

Implement the possessive policy for a new possessive(word) function in inflection/__init__.py, placed next to pluralize. Project policy: surrounding whitespace is trimmed first, and an input that is empty after trimming returns an empty string; a word that already ends with an apostrophe, or with an apostrophe followed by the letter s in either case, is returned unchanged; a word whose last character is the letter s in either case receives only an apostrophe; every other word receives an apostrophe followed by the letter s, and that letter is uppercase exactly when the word's last character is an uppercase letter; internal spaces are kept so a multi-word name is treated as one unit. Keep every existing public signature unchanged.

Keep the implementation dependency-free and run the visible test.
