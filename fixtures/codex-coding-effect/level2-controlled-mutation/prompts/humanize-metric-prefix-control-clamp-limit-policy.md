# Python utility task

Implement the limit policy for clamp in src/humanize/number.py. Policy: when both limits are given and the floor is above the ceil, raise ValueError before anything else; a numeric string is converted to a float before comparison and formatting; a string that is not numeric comes back unchanged; a None value still comes back as None; a value exactly equal to a limit is not clamped; a clamped value is rendered as the limit, formatted with the format argument and prefixed by the matching token, as before. Keep the exported signature unchanged.

Keep the implementation dependency-free and run the visible test.
