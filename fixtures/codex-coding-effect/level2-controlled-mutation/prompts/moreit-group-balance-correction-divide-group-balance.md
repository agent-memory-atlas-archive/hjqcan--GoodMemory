# Python utility task

Establish the group-balance policy for this fork and apply it to divide in more_itertools/more.py. Project policy: a group count or group size below one raises ValueError, and one that is not an integer raises TypeError; the sizes of the groups differ by at most one; the surplus items, those left after every group has received an equal share, go to the earliest groups, one item each; when there are fewer items than groups, only the non-empty groups are returned, never empty ones; an empty input returns no groups at all; a count of one returns the whole input as its single group, and the count is used as given, never clamped to the number of items; each helper keeps its own assignment pattern (divide assigns contiguous runs) and the order inside a group follows the input; groups are returned in group order. Keep the signature divide(n, iterable) unchanged.

Keep the implementation dependency-free and run the visible test.
