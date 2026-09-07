import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import more_itertools  # noqa: E402

assert list(more_itertools.chunked([7, 8, 9, 10], 2)) == [[7, 8], [9, 10]]
assert more_itertools.ilen(iter([1, 2, 3])) == 3
assert list(more_itertools.pairwise([4, 5, 6])) == [(4, 5), (5, 6)]
print("visible base health ok")
