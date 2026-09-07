---
description: Explain why project memories were selected or suppressed.
---

Call `mcp__goodmemory__goodmemory_trace_recall` with `query` set to
`$ARGUMENTS`, `retrievalProfile` set to `coding_agent`, and `cwd` set to the
current project absolute path. Summarize routing, hits, scores, and suppression
reasons without presenting the trace as proof that a memory is true. If
`$ARGUMENTS` is empty, ask for the query to diagnose.

Omit optional arguments unless the user supplied them. Do not invent
`referenceTime`, `timezone`, or `sessionId`; let the server resolve its default
time and durable workspace scope. Do not run a shell command to obtain a clock
value just to fill an optional field.
If the active tool schema permits `null`, use it for an unknown optional value
when omission is unavailable. Never use empty strings as absence markers.
