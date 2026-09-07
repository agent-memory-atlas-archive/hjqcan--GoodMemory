# Python utility task

Implement the count policy for take in more_itertools/recipes.py. Project policy: a negative count returns the last that-many items of the input in their original order; a count of None returns every item; a count of zero returns nothing; a count larger than the input returns every item; a count that is neither an integer nor None (for example a float) raises TypeError; the result is always a list. Keep the signature take(n, iterable) unchanged.

Keep the implementation dependency-free and run the visible test.
