# TypeScript utility task

Implement the rounding policy for round in src/number/round.ts. Project policy: the default rounding function rounds a tie away from zero, so a negative value sitting exactly halfway between two candidates moves to the larger magnitude; a caller-supplied rounding function replaces that default entirely; the precision argument keeps its meaning (digits after the point when positive, powers of ten when negative) and its existing clamping; the shift by precision is performed on the decimal text of the value so that binary floating-point noise cannot turn a tie into a non-tie; a non-finite value is returned unchanged. Keep the exported signature unchanged.

Keep the implementation dependency-free and run the visible test.
