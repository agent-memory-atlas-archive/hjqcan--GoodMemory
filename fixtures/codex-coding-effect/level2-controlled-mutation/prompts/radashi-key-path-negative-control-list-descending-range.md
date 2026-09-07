# TypeScript utility task

Implement the range policy for list in src/array/list.ts. Project policy: when the start is greater than the end the list counts down, so the direction comes from the bounds and the step is used only as a magnitude; a nullish value-or-mapper yields the positions themselves; a zero step yields a single-item list holding the start; a fractional step is honoured; the end is included when a step lands exactly on it; a single argument means from zero up to that value inclusive. Keep the exported signature unchanged.

Keep the implementation dependency-free and run the visible test.
