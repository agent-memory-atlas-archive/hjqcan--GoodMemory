---
description: Recall durable project context for a concrete question.
---

Call `mcp__goodmemory__goodmemory_get_context` with `query` set to
`$ARGUMENTS`, `retrievalProfile` set to `coding_agent`, and `cwd` set to the
current project absolute path. Present the recalled content together with its
scope and any routing warnings. If `$ARGUMENTS` is empty, ask for a concrete
question before calling the tool.

Omit optional arguments unless the user supplied them. Do not invent
`referenceTime`, `timezone`, or `sessionId`; let the server resolve its default
time and durable workspace scope. Do not run a shell command to obtain a clock
value just to fill an optional field.
If the active tool schema permits `null`, use it for an unknown optional value
when omission is unavailable. Never use empty strings as absence markers.
