# TypeScript utility task

Implement the credential policy for parseAuth in src/parse.ts. Project policy: a leading or trailing at-sign on the input is ignored; the input is split at its first colon only, so the password may itself contain colons; each part is trimmed of surrounding whitespace and then percent-decoded, with a plus kept as a literal plus; a missing password is the empty string; an input that starts with a colon has an empty username. Keep the exported signature unchanged.

Keep the implementation dependency-free and run the visible test.
