# Python utility task

Implement the sizes policy for split_into in more_itertools/more.py. Project policy: each size takes that many items from the input, in order; a None size takes everything that remains and must be the last size, so any size after a None raises ValueError; items left over after the last size form one extra final group instead of being discarded; once the input is exhausted, the remaining sizes produce no groups, so there are no empty tail groups; a negative size raises ValueError; a zero size yields an empty group while items still remain. Keep the signature split_into(iterable, sizes) unchanged.

Keep the implementation dependency-free and run the visible test.
