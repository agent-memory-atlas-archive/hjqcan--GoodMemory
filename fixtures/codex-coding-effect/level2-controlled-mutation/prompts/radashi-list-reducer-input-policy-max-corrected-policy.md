# TypeScript utility task

Correction to the accepted list-reducer input policy: the rule that a string spelling a decimal number counts as that number is rejected; strings are never numbers in this fork, so every string item is skipped no matter what it spells. Every other rule of the policy stands unchanged. Apply the corrected policy to max in src/number/max.ts and keep the exported signature unchanged.

Keep the implementation dependency-free and run the visible test.
