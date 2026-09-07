# Python utility task

Add engineering(value, precision=2) to src/humanize/number.py next to scientific and export it from the package (import and __all__ in src/humanize/__init__.py). Engineering-notation policy: the exponent is always a multiple of three, chosen so the mantissa is at least one and below one thousand; the mantissa shows exactly precision digits after the decimal point; when rounding carries the mantissa up to one thousand, the exponent steps up by three and the mantissa is formatted again; the exponent follows the mantissa exactly the way scientific writes its exponent, and a zero exponent is still written; zero renders as a zero mantissa with a zero exponent; a negative sign goes in front of the mantissa; input that cannot be converted comes back as its text form and non-finite values use the module's usual tokens.

Keep the implementation dependency-free and run the visible test.
