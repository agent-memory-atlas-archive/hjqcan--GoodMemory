# TypeScript utility task

Implement the leading-acronym policy for lowerFirst in src/index.ts. Project policy: a single leading uppercase letter is lowercased as before; a leading run of two or more uppercase letters that is followed by a lowercase letter lowercases every letter of the run except the last one, because that last letter starts the next word; a leading uppercase run that is followed by a digit, by a non-letter or by the end of the string is lowercased entirely; no character after the leading run changes; an empty input yields an empty string. Keep the exported signature unchanged.

Keep the implementation dependency-free and run the visible test.
