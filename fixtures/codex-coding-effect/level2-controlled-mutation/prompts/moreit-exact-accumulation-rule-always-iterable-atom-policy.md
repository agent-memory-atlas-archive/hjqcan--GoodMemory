# Python utility task

Implement the atom policy for always_iterable in more_itertools/more.py. Project policy: None yields nothing; a mapping is an atom and is yielded as one item, never as its keys; text and bytes are atoms yielded as one item, except that empty text or empty bytes yield nothing; every other iterable yields its own items in order; a non-iterable value is yielded as one item; the base_type argument keeps its meaning for the atom check. Keep the signature always_iterable(obj, base_type) unchanged.

Keep the implementation dependency-free and run the visible test.
