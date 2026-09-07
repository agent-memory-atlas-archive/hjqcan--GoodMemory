# Python utility task

Implement the exponent-notation policy for scientific in src/humanize/number.py. Policy: when the exponent is zero, only the mantissa is returned, without the multiplication sign or the power; commas inside a numeric string are digit-group separators and are removed before conversion; booleans come back as their text form; the mantissa keeps exactly precision digits after the decimal point; negative exponents keep the superscript minus; anything unconvertible comes back as its text form and non-finite values keep the existing tokens. Keep the exported signature unchanged.

Keep the implementation dependency-free and run the visible test.
