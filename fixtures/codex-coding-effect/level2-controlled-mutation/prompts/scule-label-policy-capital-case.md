# TypeScript utility task

The team has superseded one rule of the accepted label policy: acronyms are no longer kept uppercase. Under the updated rule an acronym, including a plural acronym, is rendered like any ordinary word, so only its first letter may be uppercase and the rest is lowercase. Every other rule of the label policy stands as accepted. Under the updated label policy add a new exported capitalCase to src/index.ts placed next to titleCase: every word gets an uppercase first letter followed by lowercase letters, words are joined by single spaces, and an empty or non-string input yields an empty string. Keep existing exported signatures unchanged.

Keep the implementation dependency-free and run the visible test.
