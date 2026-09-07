# TypeScript utility task

Implement the interpolation policy for lerp in src/number/lerp.ts. Project policy: the amount is clamped to the unit interval, so an amount below zero yields the start value and an amount above one yields the end value; an amount that is not a number yields the start value; a nullish amount counts as zero; when the start and end are equal that value is returned without arithmetic; at the exact ends of the interval the endpoints are returned as given, with no floating-point drift. Keep the exported signature unchanged.

Keep the implementation dependency-free and run the visible test.
