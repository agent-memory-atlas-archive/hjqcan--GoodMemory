import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import inflection  # noqa: E402

assert inflection.underscore("VisibleHealth") == "visible_health"
assert inflection.pluralize("checkup") == "checkups"
assert inflection.dasherize("visible_health") == "visible-health"
print("visible base health ok")
