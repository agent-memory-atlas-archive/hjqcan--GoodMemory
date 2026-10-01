# GoodMemory LanguagePack Extension Guide

GoodMemory treats language support as a vertical semantic boundary. A language
is not complete when only its labels or stopwords exist: the same
`LanguagePack` must govern write-time extraction, recall planning, lexical
search, entity matching, temporal interpretation, and context rendering.

## Built-in packs

The root package includes:

| Pack id | Locale claims | Compatibility group |
|---|---|---|
| `en` | `en` | `en` |
| `zh-Hans` | `zh-Hans`, `zh-CN`, `zh-SG` | `zh-Hans` |
| `zh-Hant` | `zh-Hant`, `zh-TW`, `zh-HK`, `zh-MO` | `zh-Hant` |
| `ja` | `ja` | `ja` |
| `ko` | `ko` | `ko` |
| `fr` | `fr` | `fr` |
| `es` | `es` | `es` |

Explicit per-call locale wins over detection. With `detection: "auto"`, kana
selects Japanese and script-specific Chinese characters select the matching
Chinese pack. Hangul selects Korean; distinctive French and Spanish grammar,
diacritics, or punctuation select their pack. Text containing only Han
characters, or Latin text without a language-specific signal, remains
ambiguous and resolves with `defaultLocale` instead of guessing.
Bare `zh` uses a configured Chinese default when present and otherwise resolves
to `zh-Hans`. Unsupported explicit locales resolve to the neutral Unicode pack;
they do not inherit English query or content semantics.

```ts
import { createGoodMemory } from "goodmemory";

const memory = createGoodMemory({
  language: {
    defaultLocale: "zh-TW",
    detection: "auto",
  },
});

await memory.remember({
  locale: "ja-JP",
  scope: { userId: "u-1" },
  messages: [{ role: "user", content: "現在の役割はリリース責任者です。" }],
});

const recall = await memory.recall({
  locale: "ja-JP",
  scope: { userId: "u-1" },
  query: "現在の役割は何ですか？",
});
```

`remember()` and `recall()` metadata expose the resolved locale, resolution
source, pack id, and analyzer version. Durable provenance stores the same
identity so later projection repair can reproduce the original analysis.
For a mixed-language `remember()` batch, each candidate and its evidence use
the pack resolved from that candidate's source message; the operation metadata
still describes the batch as a whole. Session archives persist their resolved
locale instead of trying to infer it later from a rendered summary.

## The extension contract

Custom packs implement the exported `LanguagePack` interface. Its methods form
one contract and should be tested together:

- identity: `id`, `apiVersion`, `analyzerVersion`, `compatibilityGroup`, locale
  claims, and default locale
- routing: language detection and locale ownership
- lexical semantics: equality normalization, scoring tokens, bounded search
  terms, clause splitting, and sentence splitting
- recall semantics: query decomposition, structured query intents, temporal
  parsing and resolution, entity extraction, alias matching, and entity-candidate
  eligibility
- write semantics: structured content signals such as durable/correction cues
  and source-of-truth pointer transitions, plus candidate extraction
- presentation: localized render labels

`analyzeContent()` may set the language-neutral
`LanguageContentAnalysis.interrogative` signal. Every built-in pack returns a
stable boolean for each analyzed clause. A custom pack may leave the optional
field undefined, which means that it does not declare an interrogative
admission boundary; adding that behavior does not require a new `LanguagePack`
method or an `apiVersion` change.

`analyzeContent()` may also set
`behavioralDirective: "none" | "one_off" | "durable"`. Every built-in pack
classifies each clause; an older or custom pack may leave the optional field
undefined, meaning that it does not declare this admission boundary. A polite
or pack-recognized imperative construction alone is `one_off`, not durable
intent. A standing cue such as “always”, “from now on”, or its pack-owned
equivalent can upgrade an actual behavioral directive; it does not turn an
ordinary assertion into feedback. A quoted, reported, or explicitly negated
mention of directive words is not itself directive scope. The public
`feedback()` operation and a confirmed `remember: "always"` annotation remain
explicit host-authority paths.

For packs that declare the signal, ordinary interrogative clauses are not
durable input. Clause decomposition must preserve assertion prefixes in mixed
messages while excluding their interrogative tails. Explicit directives,
assignments, quoted question literals, and host-confirmed `remember: "always"`
annotations remain authority-bearing inputs. Use one pack-owned interrogative
lexicon for both clause detection and scoring/search-term noise removal so a
question word cannot become the sole lexical recall anchor. Do not encode this
policy in a recall-wide multilingual word list or by changing the global
lexical threshold.

Ordinary one-off behavioral directives follow the same clause-local producer
boundary: they are removed before deterministic, custom, profile, or assisted
producers run, while an assertion prefix in a mixed message remains eligible.
Each pack must use one private directive classifier for both content analysis
and candidate admission; do not keep a second feedback-admission regex in the
candidate extractor. Changing either admission signal requires an
`analyzerVersion` bump and a rebuild of derived projections. Canonical memories
are not rewritten or deleted by that rebuild.

The shared author-attribution view recognizes a bounded line-based email
container: `From:` followed by an optional header block and `Body:`, closed by
an `End of email` line (also `pasted`, `quoted`, or `forwarded email`). Header
blocks are bounded to 16 lines and nesting to 32 containers. Quoted, code, and
serialized-role spans cannot supply outer markers. Recognized unclosed
containers, unresolved nested boundaries, and exceeded bounds conservatively
withhold the remaining document from personal attribution. Blank lines, sender
display names, and document-local SELF declarations do not restore authorship.
Genuine self-statements outside a balanced container remain eligible.

This view is shared by English/Chinese deterministic personal extraction and
the existing profile/preference source-grounding filter, including assisted
candidates and the marked author-derived branches. Raw source records and
literal non-personal facts remain unchanged. Where this grounding check is
required, original authorship and final policy-safe value support are checked
against the same source index. Removing a container header during redaction
cannot grant original authorship, and original text cannot restore a final value
that redaction removed. Consistent anonymization of genuine self-statements
remains supported. Other email/RFC layouts and
arbitrary producer-supplied fact text are outside this bounded contract.
The change protects new admission; it does not roll back previously stored
contaminated profiles or preferences. Rebuilding recall projections likewise
does not repair those canonical records.

Internally, the existing mask is captured as one immutable restriction snapshot.
Its intervals identify only UTF-16 code units replaced with spaces, not complete
document-origin boundaries; unchanged punctuation or whitespace and the
intervals' complement do not prove authorship. The author and withheld views
are derived from those intervals without changing the masking grammar.
Snapshots use SHA-256 of exact UTF-16LE code units, with no normalization or BOM;
this private digest is distinct from persisted sources' UTF-8 `contentSha256`.
The write operation binds separate original and policy-safe snapshots to their
source index and phase, validates those bindings before reuse, and never accepts
a producer-supplied snapshot. An invalid mask raises an invariant error rather
than falling back to unmasked input. This is behavior-preserving infrastructure,
not a new classifier, origin credential, public configuration, or claim of wider
document coverage. No analyzer-version or canonical-data migration is needed.

Register a custom pack through `GoodMemoryConfig.language.packs`. To replace a
built-in pack, reuse its id and locale claims; a different id that claims an
already-owned locale is rejected at startup.
Pack identity and resolver configuration are canonicalized and snapshotted
when the service is created. Empty identity/default-locale fields are rejected,
and the service snapshots declared callbacks plus top-level enumerable pack
state. Pack callbacks run against that snapshot, so mutating the original
config or top-level pack fields later does not reconfigure the running service.
A pack is still a deterministic, versioned descriptor: its callbacks must not
depend on mutable external state, class-private state, or mutable nested
objects, which cannot be generically snapshotted. Close over immutable analyzer
data and construct a new service with a bumped `analyzerVersion` whenever those
semantics change.

```ts
import {
  createEnglishLanguagePack,
  createGoodMemory,
  type LanguagePack,
} from "goodmemory";

const base = createEnglishLanguagePack();
const productEnglish: LanguagePack = {
  ...base,
  analyzerVersion: "2-product-terms",
  buildSearchTerms(text) {
    return [...new Set([...base.buildSearchTerms(text), ...productTerms(text)])];
  },
};

const memory = createGoodMemory({
  language: {
    defaultLocale: "en-US",
    packs: [productEnglish],
  },
});

function productTerms(text: string): string[] {
  return text.includes("GM") ? ["goodmemory"] : [];
}
```

Keep search-term expansion deterministic and bounded. It is a candidate
generation aid, not a place for remote model calls or unbounded synonym graphs.
Terms are whitespace-delimited canonical tokens and are compared with a
locale-neutral Unicode case fold across storage backends. A pack must emit its
own locale-correct canonical form and must not encode a semantic distinction
only through letter case; storage does not perform language-specific stemming
or CJK segmentation.

If `language.detector` is configured in `auto` mode, also provide a stable
`detectorVersion`. Without it, `getAnalyzerManifest().persistable` is `false`
and a persistent projection proof must fail closed. A detector is ignored in
`default_only` mode, so it does not affect that mode's manifest eligibility.

## Chinese script-local contract

The built-in Chinese analyzers preserve a contiguous Han word plus a digit-bearing
ASCII identifier as an additional retrieval key, for example `项目7` or `專案A7`.
These keys distinguish numbered subjects without changing canonical text,
equality, entity ownership, or recall thresholds. Unsupported separated identifiers
(such as `项目A-7`) retain their previous tokenization; this expansion does not
add a bare-number search channel. Existing search terms keep priority under the
128-term index limit, so long inputs can exhaust the space for new identifier
keys. In overlap scoring, aliases present on only one side do not dilute an
unnumbered question. A custom tokenizer replacing the built-in pack retains its
own token semantics. The analyzer version change rebuilds affected projections.

The two Chinese packs share implementation primitives but have distinct
compatibility groups and analyzer identities. Each pack normalizes and indexes
its own script. GoodMemory 0.7 guarantees Simplified query-to-Simplified source
and Traditional query-to-Traditional source behavior; it does not guarantee
Simplified-to-Traditional or Traditional-to-Simplified lexical recall.

There is no OpenCC dependency, generated conversion variant, or handwritten
partial conversion table. The exact user-authored text remains canonical and
displayable. If a later release adds cross-script expansion, it must do so as a
bounded `buildSearchTerms` change, bump the analyzer version, and rebuild
derived projections. An embedding channel can provide independent semantic
candidate generation, but it does not change the script-local lexical
contract.

## Projection and storage rules

Language-aware projection documents carry:

- raw `text`
- derived `searchText`
- `searchLocale`
- `languagePackId`
- `searchAnalyzerVersion`
- `searchSchemaVersion`

SQLite FTS and PostgreSQL GIN use `searchText` only for candidate admission.
Application-level scoring remains the final cross-backend ranking authority, so
storage-specific tokenizers cannot redefine recall semantics.

Changing normalization, tokenization, search-term generation, entity
canonicalization, interrogative admission, detection, or sentence boundaries
requires an `analyzerVersion` bump.
Existing derived projections must then be rebuilt; canonical memory records and
their raw text remain unchanged. Treat missing or mismatched projection proof
as stale and rebuild fail-closed.

The current 0.7 generation uses recall documents v4, entities/adjacency v2,
claims/status v2, and scope catalog v2. Migration is per scope and may run on
first recall or through the `projectionMigration` maintenance job. Until a new
catalog carries complete, version-matching analyzer/build/source-generation
proof, recall must not use a partial new generation and instead uses the
canonical repository fallback.
Interrupted migration is repeatable; successful cutover removes the old
scope's derived rows and stale FTS entries without changing canonical memory.

`LanguageService.getAnalyzerManifest()` returns a stable, sorted manifest of
the resolver configuration and every active pack, including the neutral
fallback. Its `resolutionOrder` separately preserves the effective pack lookup
order, while the sorted `packs` array keeps serialization deterministic. A
projection build may use the manifest only when `persistable` is `true`.
Projection build identity should hash that manifest together with the
projection/search schema and canonical source-generation proof; it must not
infer analyzer identity from one locale or one indexed document.

## Migration from the former language adapter

There is no compatibility adapter or per-module language switch. Migrate by:

1. moving every language-specific rule into a complete `LanguagePack`;
2. registering it through `language.packs` or replacing a built-in id;
3. passing explicit locale when the host knows it, especially for Han-only
   text;
4. bumping `analyzerVersion` for semantic analyzer changes;
5. versioning any custom locale detector used by auto-detection;
6. rebuilding derived recall projections after analyzer or search-schema
   changes; and
7. verifying provenance, same-script retrieval, explicit cross-script negative
   cases, temporal planning, entity matching, and localized context output.

The optional `language.detector` remains a routing override only. It returns a
locale; it does not replace the pack's semantic responsibilities.

GoodMemory 0.7 does not run alongside a writable 0.6 process. Back up canonical
storage and managed host configuration before cutover; after a completed
migration, a downgrade requires that snapshot rather than a compatibility
adapter. Follow the [0.6 to 0.7 migration guide](./GoodMemory-0.6-to-0.7-Migration-Guide.md)
for the full cutover and rollback procedure.

## Acceptance checklist

The built-in English pack accepts the explicit data form
`Please remember project Cedar-24B: review label=BRONZE.` (optional `please`).
This bounded form requires a complete project identifier, a nonempty field and
value, and no unquoted question or list separator within that clause. The new
request must begin the original user message; splitting an embedded document
does not grant authority to its later `remember` clauses. A second bare project
assignment in the same message does not gain this explicit-fact handling.
Later unquoted
sentences keep their own question, opt-out, or legacy-instruction handling.
It retains the full project
assignment as one fact and binds its subject to the project header. First-person
or directive text in the field value remains literal project data; it does not
create a profile, preference, behavioral rule, or source-of-truth reference.
The existing `remember that`, `remember this`, and counted-fact paths retain
their established behavior. Other bare `remember` phrasing, reminders to act,
and quoted or reported requests do not gain explicit-fact authority from this
form. Normal source policy, redaction, and scope checks still apply. This is an
admission improvement, not a general English understanding or recall guarantee.

A new pack is ready only when tests cover:

- explicit locale, auto-detection, default fallback, and ambiguous text;
- equality normalization and bounded search terms;
- write extraction and durable language provenance;
- query intent, decomposition, temporal expressions, and entity aliases;
- durable/correction cues and source-of-truth pointer transitions;
- a sentinel custom language whose non-English query and content signals drive
  the same selection and remember paths without business-module changes;
- document, entity, and claim retrieval channels;
- SQLite and PostgreSQL `searchText` behavior where applicable;
- Simplified and Traditional same-script positive cases plus explicit
  cross-script negative cases;
- interrupted, repeated, and concurrent projection migration with no orphaned
  new-generation rows;
- context/evidence rendering and CJK token budgeting where applicable; and
- a real `remember -> recall -> buildContext` integration path.

A built-in or custom pack is not release-ready until the shared conformance
suite proves deterministic output, stable ordering, bounded search terms,
complete render keys, and a non-empty analyzer version. PostgreSQL support for
any non-English built-in pack additionally requires a real
`GOODMEMORY_TEST_POSTGRES_URL` functional, migration, scale, and `EXPLAIN`
index run; a skipped suite is not evidence.
