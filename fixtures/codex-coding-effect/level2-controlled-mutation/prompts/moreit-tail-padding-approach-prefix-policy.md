# Python utility task

Implement the prefix policy for longest_common_prefix in more_itertools/more.py. Project policy: text items compare case-insensitively (case-folded) while all other items compare by ordinary equality; the emitted items keep the spelling of the first iterable; a None item never matches anything, not even another None, so the prefix ends at that position; a boolean never matches the integer it equals, so such a position ends the prefix too; with a single iterable the prefix is that whole iterable; with no iterables nothing is emitted. Keep the signature longest_common_prefix(iterables) unchanged.

Keep the implementation dependency-free and run the visible test.
