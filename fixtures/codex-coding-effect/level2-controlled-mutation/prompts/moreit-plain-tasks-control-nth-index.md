# Python utility task

Add a function nth_index(iterable, value, n) to more_itertools/recipes.py, next to iter_index, and list it in the module's __all__. It returns the zero-based position of the n-th occurrence of value in the iterable, where n counts from one and items are compared by identity or equality. If value occurs fewer than n times, or if n is below one, it raises ValueError. The iterable is consumed only up to the returned position.

Keep the implementation dependency-free and run the visible test.
