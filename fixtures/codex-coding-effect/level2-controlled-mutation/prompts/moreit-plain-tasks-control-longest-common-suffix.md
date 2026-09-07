# Python utility task

Add a function longest_common_suffix(iterables) to more_itertools/more.py, next to longest_common_prefix, and list it in the module's __all__. It takes an iterable of iterables and yields the items that every one of them ends with, in forward order, comparing items with ordinary equality and taking the yielded items from the first iterable. When the iterables share no final item it yields nothing, when there are no iterables it yields nothing, and when there is a single iterable it yields that whole iterable. Finite inputs only.

Keep the implementation dependency-free and run the visible test.
