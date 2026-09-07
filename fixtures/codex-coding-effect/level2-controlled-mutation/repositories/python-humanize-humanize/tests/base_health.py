import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))

import humanize  # noqa: E402

assert humanize.intcomma(1234567) == "1,234,567"
assert humanize.apnumber(4) == "four"
assert humanize.naturalsize(2048) == "2.0 kB"
print("visible base health ok")
