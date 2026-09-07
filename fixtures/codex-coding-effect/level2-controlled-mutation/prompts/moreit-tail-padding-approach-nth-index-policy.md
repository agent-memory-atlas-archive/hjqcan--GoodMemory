# Python utility task

Implement the index policy for nth in more_itertools/recipes.py. Project policy: a negative index counts from the end of the input, so minus one is the last item and minus the length is the first; an index beyond either end returns the default instead of raising; the default is None unless a third argument is given; an empty input returns the default for every index; an index that is not an integer (for example a float or text) raises TypeError; a non-negative index still consumes the input only as far as needed. Keep the signature nth(iterable, n, default) unchanged.

Keep the implementation dependency-free and run the visible test.
