# Preference source evidence

This local follow-on change links newly accepted preference writes and duplicate
confirmations to the immutable, policy-safe source-message records already
prepared by `remember`. It also checks source chronology before an existing
literal preference rule can supersede another record. It does not expand target
matching, infer new preference slots, or route natural-language forget requests.

Each binding uses the preference ID and the set of canonical source-record IDs.
The same source replay preserves the existing evidence record and timestamp;
another source or session adds its own confirmation. Caller message IDs alone
are not sufficient identity. The preference mutation and any new evidence are
in the same conditional document batch, including rollback snapshots. Evidence
IDs are returned on the preference remember event.

The source-message persistence phase still follows candidate writes. Failed
source persistence rolls back this operation's preference and evidence writes;
later failures preserve raw sources according to the existing pipeline policy.
This change does not establish an atomic transaction across the entire remember
pipeline. Category-conditional batches bind the preference decision to the
source/evidence rows read for that decision.

No historical bindings are inferred or backfilled. An existing preference gains
only the evidence of a new confirmation. When policy redaction cannot preserve
a safe source, no source evidence is manufactured. A binding records extraction
provenance; it does not prove that an arbitrary assisted candidate is semantically
entailed by that source or that the source author owns every quoted assertion.

The existing by-ID `forget` operation can now clean up a new preference's linked
evidence and exclusive source records. Shared sources remain while other evidence
still refers to them. Use the durable scope without a session ID to include
confirmations across sessions: the existing session-filtered cleanup remains
session-filtered. This is not a promise to erase independent episodes, chat logs,
exports, external copies, legacy unlinked sources, or future re-ingestion.

## Bounded source chronology

Target selection runs against the full active category and durable scope before
chronology. Existing retirement targets and exact opposite-polarity assertion
targets are kept separate. Opposition requires the same literal object and exact
context; an absent context is not a wildcard. An ordinary old positive assertion
can therefore be rejected after a newer matching withdrawal even without a
"now" or "restore" marker.

For a supported literal withdrawal, restoration, or response-format replacement,
each authoritative user source is checked independently. A newer auxiliary
message or ordinary re-mention cannot lend its timestamp to an older restore
command. Prior support comes from exact linked source records in the same durable
scope; duplicate reaffirmations contribute their latest proven source time.
Extraction time, ingestion time, attributes, and record updatedAt never establish
which user assertion came later.

- When both sides have valid RFC 3339 observation instants, an operation must be
  strictly newer than the target's latest matching support. Older operations
  return `stale_preference_source`; conflicting equal times return
  `unordered_preference_source`.
- A known time on only one side, mixed dated/undated relevant support, missing
  links, malformed dates, or unverifiable supporting records cannot authorize
  replacement. They return `unordered_preference_source`.
- When both actual, validated sources omit time, existing ingestion-order
  behavior remains for compatibility. This is an explicit exception, not a
  guarantee that an undated historical replay is safe.
- Same-value duplicates may retain evidence at an equal or older time, but
  cannot acquire authority to retire a different record through that evidence.
- Opposition-only checks restrict admission and never add retirement writes.
  When a target belongs to both sets, the stricter per-source retirement
  authority takes precedence; an ordinary newer mention cannot lend its clock
  to an older restore operation. A strictly newer ordinary positive remains
  admissible, but does not gain automatic permission to retire an existing
  withdrawal. Existing replacement semantics still apply.

Rejected conflicting candidates do not become active preferences, so they do
not inject a second contradictory current preference. Their policy-safe raw
source remains available as history under the existing retention policy. The
check is recomputed on category-CAS retry, including after a concurrent ordinary
reaffirmation. It does not supply a global transaction or provenance proof for
arbitrary direct storage writes/imported cross-record links.

This boundary applies to existing recognized retirement operations and exact
opposing personal assertions supported by the same literal parser. It does not infer synonymous
withdrawals, repair historical active records, impose a total event order across
unrelated preferences, or solve admission of every historical statement. Legacy
records without evidence can gain a binding from a new confirmation. Existing
unbound audit rows, including explicit revision audits without sourceRecordIds,
remain unorderable; a separate later confirmation does not repair those rows.
Explicit target-based correction remains available. No missing binding is
inferred or backfilled. Source timestamps are host-supplied context, not cryptographic proof
of authorship. Natural-language physical deletion and the separate plural-query
candidate remain outside this change. The prepared 0.8.1 artifacts are unchanged.
