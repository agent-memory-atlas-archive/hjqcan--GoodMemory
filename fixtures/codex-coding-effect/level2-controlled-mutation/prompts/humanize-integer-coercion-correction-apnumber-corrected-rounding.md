# Python utility task

The user rejected one rule of the accepted integer-coercion policy: a float or numeric string with a non-zero fractional part is no longer returned unchanged. Corrected rule: such a value is first rounded to the nearest integer, with halves resolved away from zero, and the rounded integer is then handled like any other integer. Every other rule of the policy stands as accepted. Apply the corrected policy to apnumber in src/humanize/number.py and keep the exported signature unchanged.

Keep the implementation dependency-free and run the visible test.
