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

## Versioned scope-key safety migration

The scope-key safety update uses `gm2:` keys. Each of the five normalized scope
components (`userId`, `tenantId`, `workspaceId`, `agentId`, `sessionId`) is a
separately encoded JSON string or `null`; components are separated by a single
colon. Arbitrary colons, Unicode, absent dimensions, and field boundaries no
longer alias another user's scope. New keys cannot equal any old `::`-joined
key. Do not parse keys yourself: use `scopeToKey`, `parseScopeKey`, and the
full `MemoryScope` fields. Treat the serialized key as a versioned opaque ID.

Stop **all old and new writers** and take a consistent database backup before
recovery. Do not run old package versions concurrently with the upgraded
package. The new transaction/ownership protocol cannot make an old writer
participate in the new key format. Rollback requires restoring the backup;
pointing an old binary at upgraded state is not a supported downgrade.

### Existing session state

Built-in memory, SQLite, and Postgres adapters use the same compatibility rules:

- Uniquely decodable legacy keys remain readable. Read-only access does not
  mutate the database. On the first successful mutation, a permanent owner
  marker is written atomically with the new state, preventing later fallback
  from resurrecting an older snapshot.
- An unresolved ambiguous legacy key raises `LegacyScopeKeyError`, with code
  `GOODMEMORY_LEGACY_SCOPE_AMBIGUOUS`. The original row is left intact and is
  logically quarantined from normal reads, writes, CAS, and deletes. A bulk
  deletion encountering such a row fails before modifying that state kind.
  A higher-level multi-collection deletion may have its normal recoverable
  deletion journal; do not assume the whole multi-store operation was atomic.
- Explicit empty/blank `sessionId` still means an exact sessionless record.
  Omitted `sessionId` selects all sessions of the exact durable tuple.
- Ordinary deletion of a safe or explicitly confirmed owner erases its current
  and preserved legacy payloads. Payload-free ownership markers remain to
  prevent a later replay from reassigning or resurrecting archived data. This
  is distinct from unresolved quarantine, whose original payload is retained.

The optional `SessionStore.listLegacyScopes()` method lists metadata only:
state kind, old key, provably unique scope (or `null`), and a resolved owner (or
`null`). This is a privileged storage-maintenance API, not a user-facing
endpoint. Custom session adapters need not implement the optional methods;
their operators must provide an equivalent safe migration before upgrading.

For an ambiguous row, independently establish its full owner from a trusted
backup or application source. A session ID, matching payload, or the lossy key
alone is **not** proof. If no such evidence exists, keep the row quarantined.
Once the owner is known, inspect its original payload through trusted storage
administration and submit exactly that snapshot:

```ts
const restored = await sessionStore.recoverLegacyState?.({
  kind: "buffer", // or "working_memory" / "journal"
  legacyKey: inspectedLegacyKey,
  scope: independentlyVerifiedScope,
  expectedValue: inspectedOriginalBuffer,
});
if (restored !== true) {
  // Missing capability, changed original, different owner, or target conflict.
  // Stop and re-inspect; never retry with a guessed owner or overwrite a target.
}
```

Recovery atomically copies the expected original into the v2 target and records
one durable owner per legacy key/state kind. It leaves the original intact until
normal owner deletion. A content digest pins the inspected original; if an
external restore later changes it, owner deletion fails before erasing either
payload. Stop the old writer/importer and re-inspect the backup rather than
changing the claim to silence the conflict. A second owner cannot claim the
same source after a restart. Repeating the same claim returns true only while the original and
target still match; it never overwrites newer state or resurrects deleted state.
This operation does not claim to split a payload that was already mixed by an
old collision, nor recover an older value overwritten before the upgrade.

### Other persisted consumers

Canonical durable records already carry full scope fields and keep their IDs.
The update verifies those fields when reusing legacy event, trace, review, and
page-import identities. Approved/rejected review candidates keep their status.
New imported pages and review candidates have disjoint `note_v2_` and `rc_v2_`
ID namespaces. Existing historical-ID page-import idempotency is preserved.

Recall projections and Inspector catalogs are rebuildable from canonical
records; old key strings are not ownership evidence. Allow first-use rebuild
work, and verify paginated scope listing and recall on the upgraded copy.
Spill pointers and payloads use separate `gm2spill:` / `gm2payload:` namespaces;
old payload URIs are readable only after full stored scope and content-integrity
checks. New requests issue new progressive-record HMAC references and scope digests;
previous references/cache entries must be refreshed through normal index
retrieval. They are not accepted as aliases for an ambiguous legacy scope.

Extraction cursors and interrupted deletion fences can also require explicit
ownership recovery. Use `createExtractionCursorStore(...).recoverLegacyCursor`
with the independently verified scope, source ID, original cursor snapshot,
and `confirmTrustedOwnership: true`. This public cursor boundary enforces the
normal storage-safe text contract (no NUL or unpaired surrogate characters)
before any storage access. Use
`createScopeDeletionCoordinator(...).recoverLegacyDeletionJournal` for a
legacy deletion journal after inspecting its original lock/barrier snapshots,
with both `confirmTrustedOwnership: true` and
`confirmPriorRuntimesStopped: true`.
Both are privileged maintenance operations: retain the originals, reject
conflicting targets/owners, and use compare-and-swap. Mapping a journal does
not remove its fence; resume the normal deletion coordinator only after
confirming that the original deletion intent still applies. Never edit away
an active lock or reset a cursor merely to suppress a migration error.

No automatic scan can determine whether pre-upgrade collisions already mixed
or overwrote user data. The affected quantity is installation-specific and
unknown until inspected; a passing migration test is not proof that existing
production data is unmixed.

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
