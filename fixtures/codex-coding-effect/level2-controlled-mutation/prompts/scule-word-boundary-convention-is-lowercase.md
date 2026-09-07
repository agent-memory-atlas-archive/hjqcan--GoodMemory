# TypeScript utility task

Implement the lowercase-check policy for a new exported isLowercase in src/index.ts placed next to isUppercase. Project policy: the result is true when the input contains at least one cased letter and every cased letter is lowercase; it is false as soon as any cased letter is uppercase; it is undefined when the input has no cased letter at all, which covers the empty string and inputs made only of digits, punctuation or whitespace; characters without a case distinction never influence the result; every character of the string is inspected, not only the first one; the argument defaults to an empty string. Keep existing exported signatures unchanged.

Keep the implementation dependency-free and run the visible test.
