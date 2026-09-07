# TypeScript utility task

Implement the inclusive-bounds policy for inRange in src/number/inRange.ts. Project policy: both ends of the range are inclusive, so a value equal to either bound is in range; the two bounds may be given in either order; when only one bound is given the range runs from zero to that bound, in whichever direction; a range whose bounds are equal contains exactly that value; a value or bound that is not a number, or is NaN, makes the check return false; a nullish bound also returns false. Keep the exported signature unchanged.

Keep the implementation dependency-free and run the visible test.
