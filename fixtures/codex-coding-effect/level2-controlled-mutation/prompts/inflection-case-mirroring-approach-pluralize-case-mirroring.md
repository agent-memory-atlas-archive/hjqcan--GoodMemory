# Python utility task

We validated the case-mirroring approach for word inflection in this fork, and it is now the established pattern. Approach: run the existing rule table against the lowercased word, never against the original; letters inside the longest common prefix of the lowercased input and the computed result keep the input's case position by position; the first letter of the result mirrors the case of the input's first letter even when the rule changed that letter; every remaining letter of the result mirrors the case of the input's last letter; the uncountable check compares the lowercased word and returns the input untouched; an input with no letters returns the computed result unchanged; the PLURALS and SINGULARS tables and their order are not modified. Apply this approach to pluralize in inflection/__init__.py, keeping its signature and its behaviour for inputs that are already lowercase or capitalized.

Keep the implementation dependency-free and run the visible test.
