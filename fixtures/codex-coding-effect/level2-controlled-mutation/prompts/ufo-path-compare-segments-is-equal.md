# TypeScript utility task

Apply the accepted path-comparison rule to isEqual in src/utils.ts so that isEqual compares two inputs the way the rule set for isSamePath and never repeats the approach that was rejected there. The options keep their meaning: a strict trailingSlash option makes a trailing slash significant, a strict leadingSlash option makes a leading slash significant, and a strict encoding option compares segments as written without decoding. Keep the exported signature unchanged.

Keep the implementation dependency-free and run the visible test.
