# Python utility task

Add naturalbitrate(value, binary=False, format="%.1f") to src/humanize/filesize.py next to naturalsize and export it from the package (import and __all__ in src/humanize/__init__.py). It renders a number of bits per second: the unit word is always bit/s; decimal prefixes are k, M, G, T, P, E, Z, Y, R and Q, written as a space, the prefix and the unit word (like kbit/s); binary prefixes are Ki, Mi, Gi, Ti, Pi, Ei, Zi, Yi, Ri and Qi (like Kibit/s); below the first prefix the whole count is followed by a space and the unit word. Follow the accepted size-unit selection policy for choosing the prefix, formatting the amount, signs and non-finite input.

Keep the implementation dependency-free and run the visible test.
