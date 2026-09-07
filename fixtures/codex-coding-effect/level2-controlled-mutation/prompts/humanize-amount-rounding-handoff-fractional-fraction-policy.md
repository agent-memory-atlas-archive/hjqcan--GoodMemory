# Python utility task

Implement the fraction policy for fractional in src/humanize/number.py. Policy: a value that is exactly zero renders as the single digit zero, not as a fraction; a negative value keeps a single minus sign in front of the whole rendering, and both the whole part and the fraction are taken from the magnitude; a fractional part that reduces to nothing renders as the whole number alone; booleans come back as their text form; surrounding whitespace in a numeric string is ignored; anything unconvertible comes back as its text form; the mixed-number layout (whole part, a single space, then the fraction) and the denominator bound stay as they are. Keep the exported signature unchanged.

Keep the implementation dependency-free and run the visible test.
