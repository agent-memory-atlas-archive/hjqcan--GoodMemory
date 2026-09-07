# Python utility task

Implement the camelize-input policy for camelize in inflection/__init__.py. Project policy: hyphens, spaces, and dots separate words exactly like underscores do; a run of separators is a single boundary, and separators at the start or end of the input are ignored; each word's first letter is uppercased and the remaining letters of the word are kept exactly as given; when uppercase_first_letter is false the entire first word is lowercased, not only its first letter; an input that is empty or made only of separators returns an empty string in both modes; digits stay in place inside their word. Keep the exported signature unchanged.

Keep the implementation dependency-free and run the visible test.
