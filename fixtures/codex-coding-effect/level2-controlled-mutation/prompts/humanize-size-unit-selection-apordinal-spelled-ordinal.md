# Python utility task

Add apordinal(value) to src/humanize/number.py next to apnumber and export it from the package (import and __all__ in src/humanize/__init__.py). Spelled-ordinal policy: a whole number from one through nine is spelled as its lowercase English ordinal word, the ordinal counterpart of the cardinal words apnumber uses; zero and whole numbers of ten or more use the digit form with the suffix that ordinal produces; a negative value comes back unchanged as its text form; a float whose fractional part is zero counts as that whole number, while one with a non-zero fractional part comes back unchanged as its text form; numeric strings follow the same rules as numbers; anything that cannot be converted comes back as its text form, and non-finite values use the module's usual non-finite tokens.

Keep the implementation dependency-free and run the visible test.
