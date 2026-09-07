# TypeScript utility task

Establish and implement the list-reducer input policy for the numeric reducers in this fork (sum, max, and min share it). Project policy: a nullish or empty list yields the neutral result, which is zero for a sum and null for a selection; a nullish item is skipped; a boolean item is skipped; a string item that, after trimming whitespace, spells a bare decimal number (optional sign, digits, optional fraction) counts as that number, and any other string is skipped; an item that is itself an array contributes its own items one level deep, and those items follow the same rules; any other object item is skipped; when a mapper callback is supplied it is applied to each item first and the rules apply to what it returns; the neutral result is also returned when every item was skipped. Apply this policy to sum in src/number/sum.ts and keep the exported signature unchanged.

Keep the implementation dependency-free and run the visible test.
