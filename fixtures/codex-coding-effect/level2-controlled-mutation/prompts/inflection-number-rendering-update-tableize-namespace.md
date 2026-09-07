# Python utility task

Implement the table-name policy for tableize in inflection/__init__.py. Project policy: a namespace prefix separated by double colons is dropped, and only the last segment names the table; surrounding whitespace is trimmed before anything else; every run of spaces or hyphens inside the name becomes one underscore; the remaining name is then underscored and its last word pluralized with the existing rules; uncountable words stay unchanged; an empty input returns an empty string. Keep the exported signature unchanged.

Keep the implementation dependency-free and run the visible test.
