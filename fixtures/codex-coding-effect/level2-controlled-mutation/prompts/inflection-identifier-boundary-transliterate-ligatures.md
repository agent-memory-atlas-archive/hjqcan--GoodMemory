# Python utility task

Implement the transliteration policy for transliterate in inflection/__init__.py. Project policy: the ash and ethel ligatures (æ, œ) expand to two plain letters, and an uppercase ligature expands with only its first letter uppercase; the stroked letters o, l, and d (ø, ł, đ) become the plain letter in the same case; the sharp s (ß) becomes a double s; thorn (þ) becomes th, and its uppercase form becomes th with a capital t; these replacements run before the existing decomposition step, which then strips accents as it does today; any character that is still outside ASCII after decomposition is dropped. Keep the exported signature unchanged.

Keep the implementation dependency-free and run the visible test.
