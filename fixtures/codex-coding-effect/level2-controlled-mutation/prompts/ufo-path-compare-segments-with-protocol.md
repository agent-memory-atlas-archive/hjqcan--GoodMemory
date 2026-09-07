# TypeScript utility task

Implement the protocol-swap policy for withProtocol in src/utils.ts. Project policy: the protocol argument may be a bare scheme, a scheme with a colon, or a scheme with a colon and two slashes, and it is always normalized to the lowercased scheme followed by a colon and two slashes; an empty protocol argument means the protocol is removed; a protocol on the input is recognized only when its scheme is followed by a colon and two slashes or two backslashes, so a bare host followed by a colon and a port has no protocol and keeps its host; a protocol-relative input starting with two slashes receives the new protocol in place of them; surrounding whitespace on the input is trimmed first. Keep the exported signature unchanged.

Keep the implementation dependency-free and run the visible test.
