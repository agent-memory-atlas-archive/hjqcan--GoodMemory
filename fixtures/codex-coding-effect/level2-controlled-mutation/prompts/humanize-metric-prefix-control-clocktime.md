# Python utility task

Add clocktime(value) to src/humanize/time.py next to precisedelta and export it from the package (import and __all__ in src/humanize/__init__.py). Clock policy: the input is a number of seconds given as a number, a numeric string or a timedelta; fractional seconds are truncated toward zero; the result is hours, minutes and seconds separated by colons, where hours are shown without padding and are always present even when zero, while minutes and seconds always use two digits; whole days fold into the hour count rather than adding a day field; a negative input puts a single minus sign in front; anything that is not a finite number comes back as its text form.

Keep the implementation dependency-free and run the visible test.
