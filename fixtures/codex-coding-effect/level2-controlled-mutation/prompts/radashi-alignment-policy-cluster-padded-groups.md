# TypeScript utility task

Establish and implement the alignment policy for the grouping helpers in this fork (cluster, zip, and unzip share it). Project policy: every group has a fixed width, which is the requested size for cluster and the number of input lists for zip and unzip; an incomplete group is padded with null until it reaches full width, so a caller can index any group safely; a requested width below one, or a fractional one, is rounded down and then treated as at least one; a nullish list, whether it is the whole input or one of several input lists, counts as an empty list rather than an error; a nullish item that is part of the input is kept in place; an empty input yields an empty result; every group is a fresh array that does not alias the input. Apply this policy to cluster in src/array/cluster.ts and keep the exported signature unchanged.

Keep the implementation dependency-free and run the visible test.
