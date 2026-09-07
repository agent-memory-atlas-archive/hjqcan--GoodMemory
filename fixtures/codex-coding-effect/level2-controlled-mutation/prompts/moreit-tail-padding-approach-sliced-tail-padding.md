# Python utility task

Extend sliced in more_itertools/more.py using the validated tail-padding approach from the earlier session, so that a sequence whose length is not a multiple of the slice size is handled exactly the way that approach handles grouper's final group, including how the size argument is validated and what the strict flag does. Keep the signature sliced(seq, n, strict) unchanged.

Keep the implementation dependency-free and run the visible test.
