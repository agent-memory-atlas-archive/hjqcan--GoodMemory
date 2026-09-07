# TypeScript utility task

Implement the placeholder policy for template in src/string/template.ts. Project policy: the name inside a placeholder is trimmed of surrounding whitespace before lookup; a name containing dots is resolved as a path through nested objects and arrays; a placeholder whose name resolves to undefined is left in the output exactly as it was written; a value of null renders as an empty string; any other value is rendered with its default string conversion; the optional regex argument keeps its meaning, and its first capture group is the placeholder name. Keep the exported signature unchanged.

Keep the implementation dependency-free and run the visible test.
