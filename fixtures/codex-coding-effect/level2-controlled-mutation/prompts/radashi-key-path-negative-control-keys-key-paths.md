# TypeScript utility task

Establish and implement the key-path policy for the deep object helpers in this fork. Project policy: path segments are joined with a dot; an array index is written in square brackets attached to the preceding segment, and an index at the root has no preceding segment, so the path starts with the bracket; an empty object or empty array below the root is a leaf that contributes its own path; a nullish value is a leaf; a key that itself contains a dot or a bracket is written inside square brackets with double quotes, attached like an index, so it can be read back unambiguously; paths are listed depth first in insertion order; a nullish or empty root yields an empty list; values that are neither plain objects nor arrays (dates, maps, class instances) are leaves. Apply this policy to keys in src/object/keys.ts and keep the exported signature unchanged.

Keep the implementation dependency-free and run the visible test.
