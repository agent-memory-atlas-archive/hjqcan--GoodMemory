# Python utility task

Add intabbr(value) to src/humanize/number.py next to intword and export it from the package (import and __all__ in src/humanize/__init__.py). Compact-number policy: the input is coerced to an integer the way intword coerces it, and anything unconvertible comes back as its text form; a magnitude below one thousand renders as the plain integer digits; thousands, millions, billions and trillions use the single letters K, M, B and T attached directly to the amount with no space; the amount shows one decimal digit, and a decimal of zero is dropped together with the point; when the one-decimal amount rounds up to one thousand, the next letter is used instead; beyond trillions the amount stays with T and simply grows; a negative value keeps its sign in front.

Keep the implementation dependency-free and run the visible test.
