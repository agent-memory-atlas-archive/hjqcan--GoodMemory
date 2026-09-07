# Python utility task

Add natural_percent(value, precision=0) to src/humanize/number.py next to fractional and export it from the package (import and __all__ in src/humanize/__init__.py). Percentage policy: the input is a ratio of one and is scaled by one hundred; the scaled amount is rounded to precision decimals with halves resolved away from zero, judged on the shortest decimal text of the input; trailing zeros after the point are trimmed and a bare point is dropped; the percent sign is attached directly with no space; a negative value keeps its sign in front; anything unconvertible comes back as its text form, and non-finite values use the module's usual tokens.

Keep the implementation dependency-free and run the visible test.
