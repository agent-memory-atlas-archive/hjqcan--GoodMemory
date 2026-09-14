# GoodMemory 0.7 to 0.8 Migration Guide

This guide targets 0.8.0. Install pins apply after publication; source metadata
alone is not publication proof. The Phase 73 internal Level-2 lane is closed
without a positive coding-effect claim. Follow the published release's exact
install pins and verify the upgrade on a separate copy first.

## Before upgrading

Stop writers and back up the canonical database and host configuration using
your storage backend's consistent-backup procedure. Keep an export for
inspection, but do not substitute it for the database backup. Test the upgrade
against a separate copy before pointing installed hosts at valuable memory.
If the existing database reports corruption, diagnose and recover it first;
an upgrade is not a database-repair procedure.

## Removed public fields

| Public type | Removed fields |
|---|---|
| `FactMemory` | `accessCount`, `lastAccessedAt` |
| `FeedbackMemory` | `lastUsedAt` |
| `RecallCandidateTrace` | `usageScore`, `outcomeScore` |
| `ExperienceMetrics` | `touchedFactCount`, `reinforcedFeedbackCount` |

Remove reads and writes of these properties from integrations. Trace consumers
that need evidence quality should use `evidenceScore`, not an alias for the
old score. Retrieval exposure does not reinforce memories or update usage
counters. Freshness remains query-time recall policy; TTL remains maintenance.

Historical stored JSON may retain these extra properties. The 0.8 public
recall and export boundaries omit them without rewriting stored records;
custom keys inside authored `attributes` are not removed. Exporting an old
record and re-importing that unchanged public record remains idempotent.

## Default workspace identity

The 0.8 default workspace ID is `workspace-<sha256>` of the lexically
normalized absolute workspace path (`node:path.resolve`). This replaces the
0.7 basename-only default: `/left/project-a` and `/right/project-a` must not
read or write each other's workspace records just because their names match.
Installed-host global activation, new workspace opt-in, standalone MCP, and
bootstrap share this resolver. Explicit IDs from flags, environment variables,
or existing workspace configuration remain unchanged.

Normalization collapses relative paths, `.` and `..`. It does not resolve
symlinks, fold case, or discover a Git root. Use a consistent project-root
path for every call. Different symlink/case spellings, moved directories,
clones, and worktrees get distinct defaults. Sharing across them requires an
explicit common ID; that deliberately removes their workspace separation.
For host writeback audit commands, `inspect` and `forget` default to the
process cwd. If the hook used another path spelling (for example macOS
`/var/...` versus `/private/var/...`), pass the same `--workspace-root` used
by that hook, or configure an explicit workspace ID for consistent access.

No old records are moved, copied, merged, or deleted. A formerly implicit
basename scope may become invisible to the new default. Existing configured
IDs continue to select their existing scope, including any pre-existing
collision. The ID alone cannot identify which path owns already-mixed records.
Back up and inspect the old scope using its explicit ID before deciding on
record-by-record reconciliation. Do not copy an ambiguous old scope into every
new workspace, and do not treat an empty new scope as database corruption.

## Notes, projections, and context

The new `note` kind stores a titled Markdown body verbatim, up to 8192 UTF-8
bytes. It is distinct from extracted atomic facts. Existing scopes rebuild
their recall projections under `gm-projection-v6`; allow for this first-use
work and verify recall on the upgraded copy. Canonical records remain the
source of truth, not the projection tables or Markdown files.

`MEMORY.md` is now a bounded index with pointers into topic files. Consumers
must follow those pointers instead of assuming all content is inline.
`exportMemory().pages` is an additional active-note page bundle.

Prompt-fragment output adds a localized memory-context frame by default.
Its tokens count toward the same context budget. Set
`governance.contextFrame: false`, or pass `contextFrame: false` to
`buildContext`, if your integration supplies its own frame. JSON and Markdown
outputs do not gain this frame. It describes the recalled data; it does not
make untrusted stored text safe to execute.

Fresh Codex and Claude installations enable `retrieval.longRecordAdmission`
along with BM25 ranking after the full paired Phase 75 protection gate passed.
Reinstallation preserves existing settings (including absence or explicit
`false`). Library configuration and the file mirror remain opt-in. The
[Phase 75 report](../reports/quality-gates/phase-75/default-enablement-20260905.md)
records retrieval protection evidence, not LLM answer-quality or coding uplift.

## Interchange and mirror opt-in

Preview a pages import before applying its returned input hash:

```ts
const source = {
  kind: "pages" as const,
  pages: [{ path: "policy.md", content: "# Policy\n\nPreserve audit history.\n" }],
};
const preview = await memory.importMemory({ scope, source, dryRun: true });
await memory.importMemory({ scope, source, expectedSha256: preview.inputSha256 });
```

The CLI equivalent is `goodmemory import-memory --user-id <id> --input <path>
--dry-run`, followed by the same scoped command with
`--expect-sha256 <hash>`. Use the same user, tenant, workspace, and agent scope
for preview and execution. A hash verifies the bytes, not the input's origin.
Inspect rejected pages and conflicts; a completed request does not mean every
page was imported. Oversized pages require explicit `oversize: "split"`.

The durable form restores the `durable` section of an export by id. Invalid
record shapes, oversized notes, and invalid occurrence intervals fail before
any write. Scope mismatches reject the whole import. It does not extract new
facts or rebuild remember-time claim projections.

The optional `governance.fileMirror: { root, scope }` binds one directory to
one durable scope. Installed hosts can opt in with `--file-mirror`. The mirror
is generated output: editing it never changes canonical memory. Dry-run imports
do not create or replace it. Protect exports and mirrors as sensitive data.

## Failure and rollback

Import rollback restores old records and saved vectors when the backing
adapters permit it. If rollback itself fails, `AggregateError.errors` contains
the original failure and the rollback failures. Inspect both stores before
retrying; re-import of an existing record does not repair a missing embedding.
Mirror failures do not fail a durable mutation. Failed mirror restoration
retains the prior tree. The failed `governance.file_mirror` trace reports
`retainedPreviousRoot` and/or `retainedStagingRoot` when recovery or cleanup
fails, without including raw error messages or memory content.

To roll back the upgrade, stop writers, restore the pre-upgrade database and
configuration backups, and reinstall the prior verified package. Do not point
an old binary at a database containing new note records and assume downgrade
compatibility. Writes after the backup require an explicit reconciliation.

The exact format and failure semantics are in
[Memory Artifact and Interchange Spec](GoodMemory-Memory-Artifact-and-Interchange-Spec.md).
