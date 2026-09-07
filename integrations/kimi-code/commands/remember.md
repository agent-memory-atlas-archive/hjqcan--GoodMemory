---
description: Persist one explicit user-originated project memory.
---

Treat `$ARGUMENTS` as one user-originated statement. Reject an empty argument,
multiple unrelated statements, secrets, credentials, raw transcripts, private
file contents, or unconfirmed inference. Otherwise call
`mcp__goodmemory__goodmemory_remember` with `content` set to `$ARGUMENTS`,
`role: "user"`, and `cwd` set to the current project absolute path.
Omit optional arguments unless the user supplied them. Do not invent
`observedAt`, `sessionId`, locale, timezone, or classification hints, and do not
run a shell command merely to fill an optional timestamp. A supplied
`observedAt` must be an RFC 3339 instant with a timezone, not a date-only value.
If the active tool schema permits `null`, use it for an unknown optional value
when omission is unavailable. Never use empty strings as absence markers.
Kimi Code's approval remains the final authorization boundary. Report only
accepted, rejected, merged, and explanation fields actually returned by the
tool; a missing field is not zero. Never claim success before the tool returns
it.
