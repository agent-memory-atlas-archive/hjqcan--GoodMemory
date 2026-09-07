# TypeScript utility task

Implement the host-literal policy for parseHost in src/parse.ts. Project policy: surrounding whitespace is trimmed first; anything from the first slash, question mark, or hash onward is ignored; a bracketed IPv6 literal is returned as the hostname together with its brackets, and its port is whatever follows the closing bracket and a colon; otherwise the hostname is the text before the first colon; the hostname is percent-decoded, lowercased, and loses a single trailing dot; the port is always returned as a string and is the empty string whenever it is absent or is not made only of digits. Keep the exported signature unchanged.

Keep the implementation dependency-free and run the visible test.
