# Python utility task

Implement the humanize policy for humanize in inflection/__init__.py. Project policy: camel-cased input is first split into underscored words the way underscore does, so an acronym-like capital run becomes a word of its own; a trailing id suffix, either _id or _ids after an underscore, is removed once; leading and trailing underscores are dropped, and every run of underscores becomes a single space; all letters are lowercased and then only the first character of the result is capitalized; digits stay in place; an empty input returns an empty string. Keep the exported signature unchanged.

Keep the implementation dependency-free and run the visible test.
