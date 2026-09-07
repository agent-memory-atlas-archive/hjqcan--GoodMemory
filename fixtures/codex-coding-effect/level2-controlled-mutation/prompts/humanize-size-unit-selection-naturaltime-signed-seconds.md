# Python utility task

Implement the signed-seconds tense policy for naturaltime in src/humanize/time.py. Policy: a plain number or numeric string is a count of seconds; a negative count always means the future, and a positive count means the past unless the future flag is set; a count that is under a minute but at least forty-five seconds is treated as a whole minute; booleans are not counts and come back as their text form; surrounding whitespace in a numeric string is ignored; zero and sub-second counts keep their existing rendering; datetimes, timedeltas and unconvertible inputs keep their existing behavior. Keep the exported signature unchanged.

Keep the implementation dependency-free and run the visible test.
