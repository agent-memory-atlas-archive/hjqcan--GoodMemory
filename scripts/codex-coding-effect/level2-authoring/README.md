# Level-2 controlled-mutation authoring

Authoring inputs for the Phase 73 Level-2 dataset (plan section 0.3). The
builder in `scripts/codex-coding-effect/level2-controlled-dataset.ts` turns
this directory plus the pinned upstream projections into the frozen fixture
at `fixtures/codex-coding-effect/level2-controlled-mutation`.

Check one episode while authoring (fast, local, no Codex):

```
bun scripts/check-codex-coding-effect-level2-authoring.ts --episode=<episode-id>
```

It materializes the repository (projection + overlay), runs the visible test,
the hidden pass-to-pass and fail-to-pass cases on the base tree, applies the
gold tree and runs them again, and scans for leakage. Exit code 1 means the
episode is not acceptable; the JSON report lists every problem.

## Layout

```
level2-authoring/
  <repositoryId>/
    repository.json          repository spec (ecosystem, commands, upstream pin)
    overlay/                 authored files added to the projected tree
      AGENTS.md              contributor instructions (same style as C4)
      tests/...              the visible base-health test
    episodes/
      <episodeId>/
        episode.json         episode spec (strata, history, stages)
        prompts/stage-N.md   prompt BODY for each stage (no title, no trailer)
        gold/stage-N/<path>  gold version of every file the stage changes
```

The builder renders each prompt as `# <Language> utility task`, a blank line,
the body, a blank line, and the fixed trailer `Keep the implementation
dependency-free and run the visible test.` The rendered prompt must stay
within 1,500 characters because the host writeback stores at most that much
of a message; keep declaring prompts near 1,000-1,300 characters.

## Episode design (pre-registered, plan 0.3)

Every episode has exactly four stages on the same repository. Every stage
starts from the same pristine base tree; nothing carries over except memory
(installed arm) or a flat summary of prior stages (comparator arm).

- Stage 1 (mode `none`): the declaring session. The prompt states a
  repository policy for this fork precisely (five to eight concrete rules)
  and asks for one implementation task governed by it.
- Stages 2 and 3 (mode `irrelevant-control` unless the episode's stratum
  needs `required`): intervening sessions on other surfaces of the same
  repository. Each declares its own unrelated policy and asks for a task
  governed by it. They must be solvable from their own prompt alone.
- Stage 4 (mode `required`): the recall session. The prompt names the
  stage-1 policy the way stage 1 named it ("apply the accepted <name>
  policy to ...") and asks for a task that is only solvable with that policy.
  Hidden cases check the specific rules; a summary that blurred them fails.

Strata (set `strata` and `primaryStratum`):

- `project-convention`: stage 1 declares a convention; stage 4 must comply.
- `validated-approach`: stage 1 establishes a working pattern or helper;
  stage 4 must reuse it.
- `failure-avoidance`: stage 1 records an approach that failed and the
  replacement rule; stage 4 must not repeat the failure.
- `open-loop-handoff`: stage 1 finishes part of the work and states the
  concrete deferred next step; stage 4 asks to continue the deferred work.
- `user-correction`: stage 1 declares a policy; stage 2 (mode `required`)
  corrects one rule; stage 4 must follow the corrected rule.
- `stale-update`: stage 1 declares a policy; stage 3 (mode `required`)
  supersedes one rule; stage 4 must follow the newer rule.
- `irrelevant-memory-negative-control`: stages 2-4 are all
  `irrelevant-control`; stage 1's policy is unrelated to them and must not
  mislead.
- `no-history-negative-control`: `primaryStratum` is this stratum; stages
  2-4 are mode `none`; no stage declares a policy (plain self-contained tasks
  whose prompts contain no `Project policy:` or similar durable statement).

`memory.dependencies` on a `required` or `irrelevant-control` stage must list
at least one `{ category, description }` whose category is in `strata`.

## Task rules (the reviewer checks these)

- Real coding work on the real repository: modify an existing exported
  function or add a new exported function next to related ones. Keep
  exported signatures stable when modifying.
- Hidden fail-to-pass cases must FAIL on the base tree and PASS on the gold
  tree; case 1 must fail on the base tree. Hidden pass-to-pass cases must
  pass on both (they protect existing behavior). Three to six cases each.
- The policy must not be derivable from the repository itself: it changes or
  extends upstream behavior in a way the code and manifests do not reveal.
- Rules, not answers. Prompts and history state rules; hidden cases use
  concrete instances. No hidden test scalar (any argument or expected string
  or number) may appear as a whole token in any prompt, feedback line,
  history line, or overlay file unless it already appears in the projected
  repository source. The checker reports every such leak. Avoid fixed literal
  outputs (placeholder strings, magic numbers) in policies; prefer
  transformational rules (ordering, casing, bracketing, trimming, separators,
  precedence, thresholds described in words).
- The gold implementation must be dependency-free and must not import
  anything outside the repository or the standard library.
- Gold trees contain the complete file contents of every changed file
  (including any new file). `expectedChangedFiles` lists exactly those paths.
- A stage may ADD a new exported function. Its fail-to-pass cases target the
  new export (case 1 fails on the base tree because the export is missing);
  its pass-to-pass cases must protect an EXISTING sibling export instead, by
  giving each pass-to-pass case its own `"functionName"` field, because
  pass-to-pass must pass on the base tree.
- `functionName` is the exported symbol the hidden runner calls by default
  (a case may override it with its own `functionName`);
  `modulePath` is the module the runner imports (TypeScript: a path such as
  `src/url.ts` relative to the repository root; Python: the dotted module
  name such as `inflection` or `humanize`).
- Case arguments and expected values are JSON. Python tuples come back as
  lists, sets as sorted lists, generators as lists. An expected exception is
  written as `{ "__error__": "<ExceptionClassName>" }` (Python) or
  `{ "__error__": "<ErrorClassName>" }` (TypeScript).
- Do not name episode ids after upstream issues or commits. Ids are
  `<repository-short>-<topic>` in lower-kebab-case.

## `history`

One or two short user/assistant turns describing how the episode came about
(as in the C4 fixture). It is a leakage-audit reference surface only; it is
never injected into any arm. It must not restate a hidden value or a gold
line.
