# Python utility task

The team has superseded one rule of the accepted number-rendering policy: the plain-digit rule is withdrawn, and the integer part is now grouped in threes with commas whenever it has four or more digits; every other rule of that policy stands as accepted. Under the updated policy add count_noun(count, noun) to inflection/__init__.py, next to pluralize: it renders the count under the policy, then a single space, then the noun, which is singular only when the count is exactly one and plural for every other count including zero and negatives; the noun may arrive in singular or plural form and is normalized with the existing single-word rules; an uncountable noun is left exactly as given. Keep every existing public signature unchanged.

Keep the implementation dependency-free and run the visible test.
