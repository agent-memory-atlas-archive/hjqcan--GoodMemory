# Phase 75 fresh-host default enablement

Decision date: 2026-09-05 UTC. Status: implementation complete; full diagnostic
protection gate, final main canonical suite, native-Postgres coverage,
typecheck/build, and final-package consumers passed. Unpublished.

## Decision and scope

Fresh Codex and Claude installations now persist
`retrieval: { bm25Ranking: true, longRecordAdmission: true }`. Reinstallation
preserves existing retrieval settings, including an absent object, an absent
long-record key, and explicit `false`. The library default remains opt-in;
file mirroring remains off. Notes use their own recall lane, independently of
this long-fact admission flag. Existing fact selection runs first; added facts
use remaining capacity, and rendered context still obeys its token budget.

This is evidence for an unpublished Phase 75 development default, not an
end-to-end answer-accuracy claim, coding-effect proof, v0.8 release approval,
or permission to reopen withdrawn/paused benchmark declarations. No existing
user configuration was rewritten. No commit, tag, or publication was made.
The separate same-basename workspace-identity P1 and paused Phase 73 work are
not resolved by this change.

## Source and data identity

External evidence root (referred to as `R` below):
`/Volumes/data/GoodMemory-external/phase75-default-20260904-4RFXdy`.
The large external datasets and reports are deliberately not vendored.

- Frozen benchmark source: `R/source`, a dirty-worktree snapshot based on
  HEAD `ef8c84be5ab4cdac09545436cbf269c5431dbcda`, not a clean release commit.
  SHA-256 of sorted `path\0sha256(contents)\n` lines for 1,133 regular files
  under `src/`, `scripts/`, plus `package.json`, `bun.lock`, and `tsconfig.json`:
  `a735f7af8ad3c29c1dc6dcde237c85e1a931616cdab1e5fd01ddedf00e7520d3`.
- LongMemEval: full `longmemeval_s_cleaned.json`, 500 cases, 277,383,467 bytes,
  SHA-256 `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`;
  pinned input revision `98d7416c24c778c2fee6e6f3006e7a073259d48f`.
  Report fingerprint:
  `195fa256c468ff68079f5a05de2572deb47fa2c06b5d48e1d3ad4f3e044a5203`.
- LoCoMo: all 10 conversations, 1,986 questions, and 5,882 turns; upstream
  revision `cbfbc1dba6bc53d00625212a0f22d55ffee7c1fc`; input SHA-256
  `79fa87e90f04081343b8c8debecb80a9a6842b76a7aa537dc9fdf651ea698ff4`.
  CC BY-NC 4.0 data remains external.
- Runtime: Bun 1.3.14; existing installed dependencies were linked into the
  snapshot. Neither arm used a live model or provider embedding.
- Final default candidate: `R/final-verification-RErWjh`, copying the merged
  main worktree plus the exact default/test patch before validation. Its
  3,170-file source/test/fixture/manifest identity is
  `479d39d0556726cf8a0c627b7a40e1eda05ee96ff992c60564e218d208ca4bba`.
  `R/main-default-source-and-config-parity.log` proves byte equality with main
  for those files after enabling the default. Docs are separately verified.
  Compared with benchmark source, recall/eval code is unchanged; the final
  candidate includes the host-default change and structured file-mirror
  recovery-path tracing added by the parallel release-preparation task.
- Final main verification has its own identity in `R/main-final-source.json`:
  `a76872aaa785bcd010c4d1c37987f7027238260417faeabd9c64a027933c19f6`
  (3,472 files). Relative to the copied candidate's listed files, only the
  C5 comparator tracking regression changed. The main identity additionally
  binds `.gitignore`, five fixed-SHA C5 summaries, and 296 existing local
  authoring inputs omitted from the copy. The five summaries are actual test
  dependencies; the authoring files are conservatively bound local material,
  not declared canonical requirements (unit tests create temporary authoring
  fixtures). Their ignored/publication boundary is unchanged. Runtime source is unchanged.
  Main uses its existing Postgres test configuration; the copied candidate
  deliberately did not copy `.env` and had no Postgres test URL.

## Reproducible measurement

LongMemEval used the unchanged `scripts/run-phase-62-recall-diagnostic.ts` in
three disjoint full-root partitions: offsets 0, 167, 334; limit 167; all cases;
`goodmemory-rules-only`; concurrency 1; `bun --smol`. Candidate adds only
`--long-record-admission`. Each arm keeps one stable run-id namespace across
its shards. Completed checkpoints were resumed using the canonical runner.
`R/aggregate-longmemeval.ts` validates config, fingerprint, exact ordered
coverage of all 500 unique IDs, and every case's execution status, then
recomputes the canonical question-weighted summary. Source report hashes are
retained in each aggregate. Final arm configuration is identical except for
the admission flag.

LoCoMo used `R/run-locomo-pair.ts` to call the unchanged canonical smoke
runner once per full conversation and the canonical retrieval summarizer to
combine results. It verifies all question IDs, source fingerprints, and zero
errors; each full report retains per-conversation report hashes. Metadata
apart from run identity, results, and the flag is identical between arms.

The Mac reboot and later resource-limiting stops are documented in `R/README.md`.
Only complete identity-checked checkpoints from the final three LME shards
are scored. Earlier serial attempts are retained but excluded. This was not
a single uninterrupted monolithic run; no execution failure was scored as a
success.

Final reports:

- `R/reports/longmemeval-{baseline,candidate}-full/recall-diagnostic.json`
- `R/reports/locomo-{baseline,candidate}-full/smoke-report.json`
- `R/gate.json`, `R/full-gate.log`

Gate command, run from `R` against the unchanged frozen script:

```sh
bun source/scripts/run-phase-75-long-record-admission-gate.ts \
  --longmemeval-baseline reports/longmemeval-baseline-full/recall-diagnostic.json \
  --longmemeval-candidate reports/longmemeval-candidate-full/recall-diagnostic.json \
  --locomo-baseline reports/locomo-baseline-full/smoke-report.json \
  --locomo-candidate reports/locomo-candidate-full/smoke-report.json \
  --output gate.json
```

Independent verification checked all 26 underlying reports' actual hashes,
exact merged case rows, full configuration parity, and recomputed canonical
summaries, then reran the main gate with a byte-equivalent result. Its log is
`/Volumes/data/GoodMemory-external/v08-validation-20260904-6BPTuA/phase75-independent-check.log`.

## Results

All 22 slices passed; both arms have zero execution errors. Thresholds were
fixed before running: per-type/category recall delta at least -0.01,
LongMemEval wrong-session totals non-increasing, LoCoMo added noise at most
8 per question. These are protection thresholds, not quality targets.

LongMemEval evidence-session recall (not answer accuracy):

| Type | Cases | Baseline | Candidate | Delta (percentage points) | Wrong sessions, both arms |
| --- | ---: | ---: | ---: | ---: | ---: |
| Single-session user | 70 | 0.928571 | 0.928571 | 0 | 53 |
| Multi-session | 133 | 0.687343 | 0.749875 | +6.2531 | 139 |
| Single-session preference | 30 | 0.966667 | 0.966667 | 0 | 17 |
| Temporal reasoning | 133 | 0.829825 | 0.826065 | -0.3759 | 219 |
| Knowledge update | 78 | 0.878205 | 0.923077 | +4.4872 | 107 |
| Single-session assistant | 56 | 0.964286 | 0.964286 | 0 | 100 |
| Overall | 500 | 0.836567 | 0.859200 | +2.2633 | 735 |

Missed evidence sessions decreased from 124 to 109; wrong-recall cases remain
304. Temporal reasoning regresses slightly, within the predefined one-point
protection bound. The nonzero wrong-session totals remain a limitation.

LoCoMo single-hop evidence recall increased from 0.256837 to 0.259215
(+0.2378 percentage points); multi-hop, temporal, open-domain, and adversarial
recall are unchanged. Added noise per question ranges from approximately
0.00448 to 0.02083, below +8. Absolute recall remains low: this measurement
does not establish good answer quality or semantic multi-hop capability.

Provider-free behavioral pairs passed for adaptation (9 cases/arm), Phase 30
(16/arm), and Phase 31 (16/arm). Scored behavior, contexts, traces, patterns,
and summaries match. Only opaque outcome-lineage UUID values are normalized;
cardinality/uniqueness and semantic IDs remain checked. See
`R/reports/behavioral-protection/pair-summary.json`. This is deterministic
fallback regression protection, not live-model behavior proof.

## Hardening and verification

- Exact note bodies are preserved through page export, including an absent
  terminal newline at the 8,192-byte cap. ASCII and multibyte round-trip
  regressions failed before the fix, then passed.
- A user-only `forget` or `deleteAllMemory` refreshes an overlapping
  workspace-bound mirror; export remains confined to the bound scope.
  Unit and integration regressions failed before the fix, then passed.
- Main default tests failed for both hosts before the source flip. The final
  focused four-file run passes 48 tests / 218 assertions; old configuration
  preservation and mirror-off behavior are covered. Library-off behavior
  remains covered by the long-record integration tests.
- The specified protection suite passes 265 tests across 19 files. Merged
  mirror/import/page hardening passes 41 tests across five files.
- Final immutable candidate and main typecheck/build pass. The first copied
  candidate canonical run records 7,122 pass / 65 skip / 2 fail / 1 async
  error (environment details below). Authoritative candidate stage status is
  in `R/final-candidate-validation.json`, with raw stage logs beside it; that
  copied-candidate run is not an all-green suite.
- Final main `bun test` passed: **7,145 pass / 60 skip / 0 fail**, 7,205 tests
  across 799 files, 58,756 assertions and 13 snapshots (648.42s). The
  3,472-file identity was verified before and after the run. See
  `R/main-final-canonical-result.json` and `R/main-final-canonical.log`.
- Final main `bun run test:coverage` passed: **6,993 pass / 60 skip / 0 fail**,
  7,053 tests across 787 files, 53,915 assertions and 13 snapshots (489.12s).
  Overall coverage is **92.45%** (111,951/121,094), storage **94.47%**
  (4,200/4,446); every configured threshold passed. The same 3,472-file source
  identity was verified before and after the run. See
  `R/main-final-coverage-result.json` and `R/main-final-coverage.log`.
- Copied-candidate coverage ran 6,973 passing tests / 65 skips / zero failures,
  but the coverage command exited 1: overall 91.72%, storage 80.00% below its
  90% threshold. The five extra skips are Postgres tests, absent the main
  workspace's test configuration. This failed gate is retained unchanged;
  main canonical and native-Postgres coverage ran sequentially with a separate
  source identity and results, without lowering any threshold. Their passing
  results do not retroactively change the failed copied-candidate gate.

Retained test failures and environment evidence:

- The pre-default main canonical run recorded 7,137 pass / 60 skip / 6 fail;
  all six failures timed out during cold `bun install`, before business
  assertions. The unchanged retry passed the hook case but retained five
  release-consumer install timeouts. Raw logs are
  `main-canonical-predefault.log` and `main-cold-install-replay.log`.
- An independent empty-cache Bun install completed successfully in 133.56s.
  Five release-consumer outer deadlines were raised from 30/60s to 180s;
  cache isolation and every install/runtime assertion are unchanged. All
  five then passed (122 assertions, 396.30s), recorded in
  `main-cold-install-budget-verified.log`. This does not retroactively make
  either failed run green.
- The final candidate canonical run observed one five-second preference
  census timeout during Git provenance collection. Cold Git status measured
  7.704s; warm default status later measured 31ms. The identical main test
  passed in 224ms; candidate replay with a process-only fsmonitor-off override
  passed in 334ms. This does not establish fsmonitor as the cause (it is not
  configured). No persistent Git config or test deadline was changed.
- The copied candidate also lacks five fixed-SHA historical C5 comparator
  reports that existed in main but were ignored and untracked. Its comparator
  test failed `ENOENT`; the unchanged main test passes. Release preparation
  subsequently added an exact five-file whitelist and a red/green regression;
  raw/extra JSON remain ignored. The summaries are now eligible for tracking,
  but are still untracked/uncommitted. Main canonical success is therefore
  not clean-checkout or release proof. Old evidence bytes/protocols were not
  modified; the copied candidate and its failed results were not rewritten.
- The frozen-source unpublished test tarball
  (`6594112bd2ec7a50ab34fbf835fdca5f78fb828ca6f87102eb0bdcb6ea3f2fce`)
  passed Node 20.20.2, 22.14.0, 24.20.0, and Bun 1.3.14 runtime checks for
  note/page round-trip, Markdown/frame rendering, budget enforcement, and
  broad deletion invalidation. Actual packaged CLI, Python bridge, reference
  consumer, and Codex/Claude bootstrap exports also passed, including a real
  fresh cold-Bun consumer. These earlier package checks predate the final
  host-default patch. No package was published.

Final default test package: `R/packages-final/goodmemory-0.7.5.tgz`, SHA-256
`cac92d26a8a4fb4cf9d459bc7632861abb1aa74b07e41ea2ff756c2b57074493`.
It was packed once after the final main build and installed freshly in
`R/consumer-final`; npm dependency downloads may use an existing cache.
Actual packaged CLI installs and reinstalls passed on Node 20.20.2, 22.14.0,
24.20.0, and Bun 1.3.14 for both Codex and Claude: new default on; old absent/false settings
preserved; file mirror off. The final package also passes note/page,
Markdown/frame, packet-budget, and mirror-deletion runtime checks there.
The same runtime checks passed on all four runtimes. All host homes were isolated beneath the
external consumer directory; existing user configurations were not touched.
