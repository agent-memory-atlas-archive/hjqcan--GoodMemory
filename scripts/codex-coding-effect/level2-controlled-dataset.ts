// Level-2 controlled-mutation dataset builder (plan section 0.3).
//
// The dataset is assembled from three inputs:
// - an authoring root (`scripts/codex-coding-effect/level2-authoring`): one
//   directory per repository holding `repository.json`, an `overlay/` tree
//   of authored files (contributor instructions, visible base-health test,
//   any import shim), and `episodes/<id>/` directories with `episode.json`,
//   stage prompts, and per-stage gold file trees;
// - a sources root holding the source-only projection of each upstream
//   repository at its pinned commit (built outside the repository; the
//   upstream commit, tree, and projection policy are recorded in the
//   dataset's provenance so the projection can be re-derived);
// - the Level-2 profile in `controlled-dataset-profile.ts`.
//
// The output root has the same shape as the C4 fixture so the C4 readiness,
// leakage, review, and C5 paired-run machinery consume it unchanged.
import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { z } from "zod";

import {
  buildC4AssetLock,
  initC4ControlledRepository,
  serializeC4AssetLock,
} from "./c4-controlled-dataset";
import type { C4AssetLock } from "./c4-controlled-dataset";
import { validateC4ControlledPilotDataset } from "./c4-contracts";
import {
  c4HiddenValueAppearsInSurfaces,
  c4HiddenValueRelationAppearsInSurfaces,
} from "./c4-leakage";
import { LEVEL2_CONTROLLED_MUTATION_PROFILE } from "./controlled-dataset-profile";
import type { ControlledDatasetProfile } from "./controlled-dataset-profile";
import {
  CODEX_CODING_EFFECT_MEMORY_STRATA,
  parseCodexCodingEffectDataset,
} from "./dataset";
import type { CodexCodingEffectDatasetV2 } from "./dataset";
import { LEVEL2_EVALUATOR_RUNNER_SOURCE } from "./level2-evaluator-runner";
import { runBoundaryProcess } from "./process";

export const LEVEL2_DATASET_AUTHOR = "GoodMemory Level-2 dataset author";
export const LEVEL2_DATASET_AUTHOR_TASK_NAME = "/root";
export const LEVEL2_MAX_PROMPT_CHARS = 1_500;
export const LEVEL2_STAGE_TIMEOUT_MS = 60_000;
const OWNERSHIP_MARKER = ".goodmemory-level2-controlled-dataset-owned";
const PROMPT_TRAILER =
  "Keep the implementation dependency-free and run the visible test.";
const PROJECTION_POLICY = "source-only-no-upstream-tests-v1";
const LEVEL2_MIT_LICENSE = [
  "MIT License",
  "",
  "Copyright (c) 2026 GoodMemory contributors",
  "",
  "Permission is hereby granted, free of charge, to any person obtaining a copy",
  'of this software and associated documentation files (the "Software"), to deal',
  "in the Software without restriction, including without limitation the rights",
  "to use, copy, modify, merge, publish, distribute, sublicense, and/or sell",
  "copies of the Software, and to permit persons to whom the Software is",
  "furnished to do so, subject to the following conditions:",
  "",
  "The above copyright notice and this permission notice shall be included in all",
  "copies or substantial portions of the Software.",
  "",
  'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
  "IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,",
  "FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE",
  "AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER",
  "LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,",
  "OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE",
  "SOFTWARE.",
  "",
].join("\n");

const identifierSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/u);
const relativePathSchema = z.string().min(1).refine(
  (value) =>
    !value.startsWith("/") && !value.includes("\\") &&
    !value.split("/").some((segment) => segment === "." || segment === ".."),
  "path must be a relative POSIX path without traversal",
);
const memoryStratumSchema = z.enum(CODEX_CODING_EFFECT_MEMORY_STRATA);
const evaluatorCaseSchema = z.object({
  args: z.array(z.unknown()),
  expected: z.unknown(),
  functionName: z.string().min(1).optional(),
}).strict();

const repositoryAuthoringSchema = z.object({
  ecosystem: z.enum(["bun", "python"]),
  language: z.enum(["typescript", "python"]),
  licensePath: relativePathSchema,
  notes: z.array(z.string().min(1)).optional(),
  packageRoot: z.string().optional(),
  preparation: z.array(z.string().min(1)).min(1),
  repositoryId: identifierSchema,
  upstream: z.object({
    canonicalUrl: z.url(),
    commit: z.string().regex(/^[a-f0-9]{40}$/u),
    licenseSpdx: z.literal("MIT"),
    ref: z.string().min(1),
    tree: z.string().regex(/^[a-f0-9]{40}$/u),
  }).strict(),
  visibleTest: z.array(z.string().min(1)).min(1),
}).strict();

const stageAuthoringSchema = z.object({
  allowedFeedback: z.array(z.string().min(1)).default([]),
  expectedChangedFiles: z.array(relativePathSchema).min(1),
  failToPass: z.array(evaluatorCaseSchema).min(1),
  forbiddenStrings: z.array(z.string().min(1)).default([]),
  functionName: z.string().min(1),
  gold: relativePathSchema,
  id: z.string().regex(/^stage-[1-9]$/u),
  memory: z.object({
    dependencies: z.array(z.object({
      category: memoryStratumSchema,
      description: z.string().min(1),
    }).strict()).default([]),
    mode: z.enum(["none", "required", "irrelevant-control"]),
  }).strict(),
  modulePath: z.string().min(1),
  passToPass: z.array(evaluatorCaseSchema).min(1),
  prompt: relativePathSchema,
  taskId: identifierSchema,
}).strict();

const episodeAuthoringSchema = z.object({
  history: z.array(z.object({
    role: z.enum(["assistant", "user"]),
    text: z.string().min(1),
  }).strict()).min(1),
  id: identifierSchema,
  primaryStratum: memoryStratumSchema,
  repositoryId: identifierSchema,
  stages: z.array(stageAuthoringSchema).min(1),
  strata: z.array(memoryStratumSchema).min(1),
}).strict().superRefine((episode, context) => {
  if (!episode.strata.includes(episode.primaryStratum)) {
    context.addIssue({
      code: "custom",
      message: `episode ${episode.id} primary stratum must be listed in strata`,
      path: ["primaryStratum"],
    });
  }
  const stageIds = new Set<string>();
  for (const [index, stage] of episode.stages.entries()) {
    if (stage.id !== `stage-${index + 1}`) {
      context.addIssue({
        code: "custom",
        message: `episode ${episode.id} stage ${index + 1} must be stage-${index + 1}`,
        path: ["stages", index, "id"],
      });
    }
    if (stageIds.has(stage.id)) {
      context.addIssue({
        code: "custom",
        message: `episode ${episode.id} repeats ${stage.id}`,
        path: ["stages", index, "id"],
      });
    }
    stageIds.add(stage.id);
    if (stage.memory.mode === "none" && stage.memory.dependencies.length > 0) {
      context.addIssue({
        code: "custom",
        message: `episode ${episode.id}/${stage.id} declares dependencies with mode none`,
        path: ["stages", index, "memory"],
      });
    }
    if (stage.memory.mode !== "none" && stage.memory.dependencies.length === 0) {
      context.addIssue({
        code: "custom",
        message: `episode ${episode.id}/${stage.id} needs at least one dependency`,
        path: ["stages", index, "memory"],
      });
    }
    for (const dependency of stage.memory.dependencies) {
      if (!episode.strata.includes(dependency.category)) {
        context.addIssue({
          code: "custom",
          message:
            `episode ${episode.id}/${stage.id} dependency ${dependency.category} is not a declared stratum`,
          path: ["stages", index, "memory", "dependencies"],
        });
      }
    }
  }
});

export type Level2RepositoryAuthoring = z.infer<typeof repositoryAuthoringSchema>;
export type Level2StageAuthoring = z.infer<typeof stageAuthoringSchema>;
export type Level2EpisodeAuthoring = z.infer<typeof episodeAuthoringSchema>;

export interface Level2Authoring {
  authoringRoot: string;
  episodes: Level2EpisodeAuthoring[];
  repositories: Map<string, {
    overlayRoot: string;
    root: string;
    spec: Level2RepositoryAuthoring;
  }>;
}

export interface Level2ControlledDatasetFixture {
  assetLock: C4AssetLock;
  assetLockSha256: string;
  dataset: CodexCodingEffectDatasetV2;
  root: string;
}

export async function loadLevel2Authoring(
  authoringRoot: string,
): Promise<Level2Authoring> {
  const root = resolve(authoringRoot);
  const repositories = new Map<string, {
    overlayRoot: string;
    root: string;
    spec: Level2RepositoryAuthoring;
  }>();
  const episodes: Level2EpisodeAuthoring[] = [];
  const repositoryEntries = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const repositoryDirectory of repositoryEntries) {
    const repositoryRoot = join(root, repositoryDirectory);
    const specPath = join(repositoryRoot, "repository.json");
    if (!await pathExists(specPath)) {
      continue;
    }
    const spec = parseWithSchema(
      repositoryAuthoringSchema,
      JSON.parse(await readFile(specPath, "utf8")),
      `repository ${repositoryDirectory}`,
    );
    if (spec.repositoryId !== repositoryDirectory) {
      throw new Error(
        `Level-2 repository directory ${repositoryDirectory} must match its id ${spec.repositoryId}`,
      );
    }
    repositories.set(spec.repositoryId, {
      overlayRoot: join(repositoryRoot, "overlay"),
      root: repositoryRoot,
      spec,
    });
    const episodesRoot = join(repositoryRoot, "episodes");
    if (!await pathExists(episodesRoot)) {
      continue;
    }
    const episodeDirectories = (await readdir(episodesRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const episodeDirectory of episodeDirectories) {
      const episodePath = join(episodesRoot, episodeDirectory, "episode.json");
      // An episode directory without its spec is still being authored; the
      // freeze counts episodes against the profile, so skipping here cannot
      // let an unfinished episode into a frozen dataset.
      if (!await pathExists(episodePath)) {
        continue;
      }
      const episode = parseWithSchema(
        episodeAuthoringSchema,
        JSON.parse(await readFile(episodePath, "utf8")),
        `episode ${episodeDirectory}`,
      );
      if (episode.id !== episodeDirectory) {
        throw new Error(
          `Level-2 episode directory ${episodeDirectory} must match its id ${episode.id}`,
        );
      }
      if (episode.repositoryId !== spec.repositoryId) {
        throw new Error(
          `Level-2 episode ${episode.id} belongs to ${episode.repositoryId}, not ${spec.repositoryId}`,
        );
      }
      episodes.push(episode);
    }
  }
  const ids = new Set<string>();
  for (const episode of episodes) {
    if (ids.has(episode.id)) {
      throw new Error(`Level-2 episode id ${episode.id} is repeated`);
    }
    ids.add(episode.id);
  }
  return { authoringRoot: root, episodes, repositories };
}

function episodeRoot(authoring: Level2Authoring, episode: Level2EpisodeAuthoring): string {
  return join(authoring.authoringRoot, episode.repositoryId, "episodes", episode.id);
}

export function level2PromptTitle(ecosystem: "bun" | "python"): string {
  return ecosystem === "python" ? "Python utility task" : "TypeScript utility task";
}

export function renderLevel2Prompt(
  ecosystem: "bun" | "python",
  body: string,
): string {
  return [
    `# ${level2PromptTitle(ecosystem)}`,
    "",
    body.trim(),
    "",
    PROMPT_TRAILER,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Repository materialization: projected upstream tree plus authored overlay.
// ---------------------------------------------------------------------------

export async function materializeLevel2Repository(input: {
  destination: string;
  overlayRoot: string;
  projectedRoot: string;
}): Promise<{ overlayFiles: string[]; projectedFiles: string[] }> {
  await assertAbsent(input.destination, "Level-2 repository destination");
  await mkdir(dirname(input.destination), { recursive: true });
  await cp(input.projectedRoot, input.destination, {
    errorOnExist: true,
    force: false,
    recursive: true,
  });
  const projectedFiles = (await walk(input.destination))
    .map((path) => relative(input.destination, path).split(sep).join("/"))
    .sort();
  const overlayFiles: string[] = [];
  if (await pathExists(input.overlayRoot)) {
    for (const path of await walk(input.overlayRoot)) {
      const relativePath = relative(input.overlayRoot, path).split(sep).join("/");
      if (projectedFiles.includes(relativePath)) {
        throw new Error(
          `Level-2 overlay ${relativePath} would replace a projected upstream file`,
        );
      }
      const target = join(input.destination, relativePath);
      await mkdir(dirname(target), { recursive: true });
      await cp(path, target, { errorOnExist: true, force: false });
      overlayFiles.push(relativePath);
    }
  }
  return { overlayFiles: overlayFiles.sort(), projectedFiles };
}

// Base commits must match the reconstruction readiness and the C5 harness
// perform through materializeC4SourceRepository.
async function initRepository(root: string, id: string): Promise<void> {
  await initC4ControlledRepository(root, id);
}

// Gold patch bytes for one stage: the authored gold tree is copied over the
// base checkout, the patch is captured the way readiness replays it, and the
// checkout is restored to the base commit.
export async function captureLevel2GoldPatch(input: {
  expectedChangedFiles: readonly string[];
  goldRoot: string;
  repositoryRoot: string;
}): Promise<string> {
  const goldFiles = (await walk(input.goldRoot))
    .map((path) => relative(input.goldRoot, path).split(sep).join("/"))
    .sort();
  const expected = [...input.expectedChangedFiles].sort();
  if (JSON.stringify(goldFiles) !== JSON.stringify(expected)) {
    throw new Error(
      `Level-2 gold tree ${input.goldRoot} holds ${JSON.stringify(goldFiles)} but the stage expects ${JSON.stringify(expected)}`,
    );
  }
  for (const file of goldFiles) {
    const target = join(input.repositoryRoot, file);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(input.goldRoot, file), target, { force: true });
  }
  try {
    await git(input.repositoryRoot, ["add", "--all", "--", ...expected]);
    const patch = await gitRaw(input.repositoryRoot, [
      "diff",
      "--cached",
      "--binary",
      "--full-index",
      "HEAD",
      "--",
      ...expected,
    ]);
    if (patch.length === 0) {
      throw new Error(`Level-2 gold patch is empty for ${input.goldRoot}`);
    }
    return patch;
  } finally {
    await git(input.repositoryRoot, ["reset", "--quiet", "--hard", "HEAD"]);
    await git(input.repositoryRoot, ["clean", "--quiet", "-fd"]);
  }
}

// ---------------------------------------------------------------------------
// Leakage allowlists (same rule as C4): a hidden test scalar may only be
// declared public when it already appears in the visible repository.
// ---------------------------------------------------------------------------

type LeakageScalar = string | number | boolean | null;

function collectLeakageScalars(value: unknown): LeakageScalar[] {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(collectLeakageScalars);
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).flatMap(collectLeakageScalars);
  }
  return [];
}

function leakageScalarKey(value: LeakageScalar): string {
  return JSON.stringify({
    type: value === null ? "null" : typeof value,
    value,
  });
}

export async function loadLevel2VisibleSurfaces(
  repositoryRoot: string,
): Promise<string[]> {
  return (await Promise.all(
    (await walk(repositoryRoot)).map(async (path) => [
      relative(repositoryRoot, path).split(sep).join("/"),
      await readFile(path, "utf8"),
    ] as const),
  )).flat();
}

function relationKey(relation: readonly LeakageScalar[]): string {
  return JSON.stringify(relation.map(leakageScalarKey));
}

export function level2HiddenRelations(
  stages: readonly Level2StageAuthoring[],
): LeakageScalar[][] {
  const relations = new Map<string, LeakageScalar[]>();
  for (
    const testCase of stages.flatMap((stage) => [
      ...stage.failToPass,
      ...stage.passToPass,
    ])
  ) {
    for (const argument of collectLeakageScalars(testCase.args)) {
      for (const value of collectLeakageScalars(testCase.expected)) {
        if (leakageScalarKey(value) === leakageScalarKey(argument)) {
          continue;
        }
        const relation = [argument, value];
        relations.set(relationKey(relation), relation);
      }
    }
  }
  return [...relations.values()];
}

export function level2HiddenScalars(
  stages: readonly Level2StageAuthoring[],
): LeakageScalar[] {
  return [...new Map(
    stages.flatMap((stage) => [...stage.failToPass, ...stage.passToPass])
      .flatMap((testCase) => [
        ...collectLeakageScalars(testCase.args),
        ...collectLeakageScalars(testCase.expected),
      ])
      .map((value) => [leakageScalarKey(value), value] as const),
  ).values()];
}

function allowedPublicLeakageValues(
  stages: readonly Level2StageAuthoring[],
  publicSurfaces: readonly string[],
): LeakageScalar[] {
  return level2HiddenScalars(stages)
    .filter((value) => c4HiddenValueAppearsInSurfaces(publicSurfaces, value))
    .sort((left, right) =>
      leakageScalarKey(left).localeCompare(leakageScalarKey(right))
    );
}

// The readiness audit checks argument-to-expected relations of every hidden
// case (fail-to-pass and pass-to-pass) against the visible repository; real
// libraries carry worked examples in docstrings, so relations already present
// there must be declared public up front.
function allowedPublicLeakageRelations(
  stages: readonly Level2StageAuthoring[],
  publicSurfaces: readonly string[],
): LeakageScalar[][] {
  return level2HiddenRelations(stages)
    .filter((relation) =>
      c4HiddenValueRelationAppearsInSurfaces(publicSurfaces, relation)
    )
    .sort((left, right) => relationKey(left).localeCompare(relationKey(right)));
}

// ---------------------------------------------------------------------------
// Dataset assembly.
// ---------------------------------------------------------------------------

function promptPath(episodeId: string, taskId: string): string {
  return `prompts/${episodeId}-${taskId}.md`;
}

function prehistoryPath(episodeId: string): string {
  return `prehistory/${episodeId}.jsonl`;
}

function goldPatchPath(episodeId: string, stageId: string): string {
  return `evaluator/gold/${episodeId}-${stageId}.patch`;
}

function hiddenSentinel(episodeId: string, stageId: string): string {
  return `C4_HIDDEN|${episodeId}|${stageId}`;
}

function rolloutLine(role: "assistant" | "user", text: string): string {
  return JSON.stringify({
    payload: {
      content: [{
        text,
        type: role === "user" ? "input_text" : "output_text",
      }],
      role,
      type: "message",
    },
    type: "response_item",
  });
}

export function level2AuthorAttestation(input: {
  frozenAt: string;
  profile?: ControlledDatasetProfile;
}) {
  const profile = input.profile ?? LEVEL2_CONTROLLED_MUTATION_PROFILE;
  return {
    author: LEVEL2_DATASET_AUTHOR,
    authorTaskName: LEVEL2_DATASET_AUTHOR_TASK_NAME,
    authoredBeforePairedExecution: true,
    c4PairedOutcomesInspectedBeforeFreeze: false,
    c5PairedOutcomesInspectedBeforeFreeze: false,
    datasetId: profile.datasetId,
    frozenAt: input.frozenAt,
    schemaVersion: 3,
    scope: profile.attestationScope,
  } as const;
}

const fixtureOwnership = new WeakMap<Level2ControlledDatasetFixture, string>();

export async function prepareLevel2ControlledDataset(input: {
  authoringRoot: string;
  frozenAt: string;
  profile?: ControlledDatasetProfile;
  root: string;
  sourcesRoot: string;
}): Promise<Level2ControlledDatasetFixture> {
  const profile = input.profile ?? LEVEL2_CONTROLLED_MUTATION_PROFILE;
  const root = resolve(input.root);
  await assertAbsent(root, "Level-2 controlled dataset root");
  await mkdir(root, { recursive: true });
  const ownershipToken = randomUUID();
  await writeFile(join(root, OWNERSHIP_MARKER), `${ownershipToken}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  try {
    const authoring = await loadLevel2Authoring(input.authoringRoot);
    assertProfileRepositories(authoring, profile);
    assertLevel2StratumQuotas(authoring.episodes);
    const buildRoot = join(root, ".materialize");
    await writeText(join(root, "LICENSE"), LEVEL2_MIT_LICENSE);
    const repositoryIdentity = new Map<string, { commit: string; tree: string }>();
    const repositoryFiles = new Map<string, {
      overlayFiles: string[];
      projectedFiles: string[];
    }>();
    for (const [repositoryId, repository] of authoring.repositories) {
      const fixtureRepository = join(root, "repositories", repositoryId);
      const materialized = await materializeLevel2Repository({
        destination: fixtureRepository,
        overlayRoot: repository.overlayRoot,
        projectedRoot: join(resolve(input.sourcesRoot), repositoryId, "projected"),
      });
      repositoryFiles.set(repositoryId, materialized);
      if (!await pathExists(join(fixtureRepository, repository.spec.licensePath))) {
        throw new Error(
          `Level-2 repository ${repositoryId} lacks its license file ${repository.spec.licensePath}`,
        );
      }
      const buildRepository = join(buildRoot, repositoryId);
      await mkdir(buildRoot, { recursive: true });
      await cp(fixtureRepository, buildRepository, { recursive: true });
      await initRepository(buildRepository, repositoryId);
      repositoryIdentity.set(repositoryId, {
        commit: await git(buildRepository, ["rev-parse", "HEAD"]),
        tree: await git(buildRepository, ["rev-parse", "HEAD^{tree}"]),
      });
      for (const episode of authoring.episodes.filter((item) =>
        item.repositoryId === repositoryId
      )) {
        const stageRoot = episodeRoot(authoring, episode);
        for (const stage of episode.stages) {
          const patch = await captureLevel2GoldPatch({
            expectedChangedFiles: stage.expectedChangedFiles,
            goldRoot: join(stageRoot, stage.gold),
            repositoryRoot: buildRepository,
          });
          await writeText(join(root, goldPatchPath(episode.id, stage.id)), patch);
          const promptBody = await readFile(join(stageRoot, stage.prompt), "utf8");
          const rendered = renderLevel2Prompt(repository.spec.ecosystem, promptBody);
          if (rendered.length > LEVEL2_MAX_PROMPT_CHARS) {
            throw new Error(
              `Level-2 prompt ${episode.id}/${stage.id} is ${rendered.length} chars; the writeback keeps at most ${LEVEL2_MAX_PROMPT_CHARS}`,
            );
          }
          await writeText(join(root, promptPath(episode.id, stage.taskId)), rendered);
        }
        await writeText(
          join(root, prehistoryPath(episode.id)),
          `${episode.history.map((record) => rolloutLine(record.role, record.text)).join("\n")}\n`,
        );
      }
      if (await git(buildRepository, ["status", "--porcelain=v1"]) !== "") {
        throw new Error(`Level-2 materializer left repository ${repositoryId} dirty`);
      }
      await writeText(
        join(root, "provenance", "repositories", `${repositoryId}.json`),
        `${JSON.stringify({
          baseCommit: repositoryIdentity.get(repositoryId)!.commit,
          baseTree: repositoryIdentity.get(repositoryId)!.tree,
          canonicalUrl: repository.spec.upstream.canonicalUrl,
          ecosystem: repository.spec.ecosystem,
          licenseSpdx: repository.spec.upstream.licenseSpdx,
          notes: repository.spec.notes ?? [],
          overlayFiles: materialized.overlayFiles,
          projectedFileCount: materialized.projectedFiles.length,
          projectionPolicy: PROJECTION_POLICY,
          repositoryId,
          schemaVersion: 1,
          upstreamCommit: repository.spec.upstream.commit,
          upstreamRef: repository.spec.upstream.ref,
          upstreamTree: repository.spec.upstream.tree,
        }, null, 2)}\n`,
      );
    }
    await rm(buildRoot, { recursive: true });
    await writeEvaluator(root, authoring);
    await writeLicenseReceipt(root, authoring);
    await writeText(
      join(root, "provenance", "author-attestation.json"),
      `${JSON.stringify(level2AuthorAttestation({ frozenAt: input.frozenAt, profile }), null, 2)}\n`,
    );
    const dataset = await writeManifest(root, authoring, profile, repositoryIdentity);
    const assetLock = await buildC4AssetLock(root);
    const assetLockBytes = serializeC4AssetLock(assetLock);
    await writeFile(join(root, "asset-lock.json"), assetLockBytes, {
      encoding: "utf8",
      flag: "wx",
    });
    const fixture: Level2ControlledDatasetFixture = Object.freeze({
      assetLock,
      assetLockSha256: sha256(assetLockBytes),
      dataset,
      root,
    });
    fixtureOwnership.set(fixture, ownershipToken);
    return fixture;
  } catch (error) {
    await rm(root, { force: true, recursive: true });
    throw error;
  }
}

export async function cleanupLevel2ControlledDataset(
  fixture: Level2ControlledDatasetFixture,
): Promise<void> {
  const ownershipToken = fixtureOwnership.get(fixture);
  if (ownershipToken === undefined) {
    throw new Error("Level-2 controlled dataset fixture has no ownership record");
  }
  if (!await pathExists(fixture.root)) {
    return;
  }
  const marker = await readFile(join(fixture.root, OWNERSHIP_MARKER), "utf8");
  if (marker !== `${ownershipToken}\n`) {
    throw new Error("Level-2 controlled dataset ownership marker does not match");
  }
  await rm(fixture.root, { recursive: true });
}

export const LEVEL2_OWNERSHIP_MARKER = OWNERSHIP_MARKER;

// Pre-registered stratum quotas (plan 0.3): four episodes per positive
// stratum, three irrelevant-memory controls, three no-history controls.
export const LEVEL2_PRIMARY_STRATUM_QUOTAS: Readonly<
  Record<(typeof CODEX_CODING_EFFECT_MEMORY_STRATA)[number], number>
> = {
  "failure-avoidance": 4,
  "irrelevant-memory-negative-control": 3,
  "no-history-negative-control": 3,
  "open-loop-handoff": 4,
  "project-convention": 4,
  "stale-update": 4,
  "user-correction": 4,
  "validated-approach": 4,
};

export function assertLevel2StratumQuotas(
  episodes: ReadonlyArray<Pick<Level2EpisodeAuthoring, "id" | "primaryStratum">>,
): void {
  const counts = new Map<string, number>();
  for (const episode of episodes) {
    counts.set(episode.primaryStratum, (counts.get(episode.primaryStratum) ?? 0) + 1);
  }
  for (const [stratum, quota] of Object.entries(LEVEL2_PRIMARY_STRATUM_QUOTAS)) {
    const actual = counts.get(stratum) ?? 0;
    if (actual !== quota) {
      throw new Error(
        `Level-2 stratum ${stratum} has ${actual} primary episodes; the pre-registered quota is ${quota}`,
      );
    }
  }
}

function assertProfileRepositories(
  authoring: Level2Authoring,
  profile: ControlledDatasetProfile,
): void {
  for (const repository of profile.repositories) {
    const authored = authoring.repositories.get(repository.id);
    if (authored === undefined) {
      throw new Error(`Level-2 authoring lacks repository ${repository.id}`);
    }
    if (
      authored.spec.upstream.canonicalUrl !== repository.url ||
      authored.spec.ecosystem !== repository.ecosystem
    ) {
      throw new Error(
        `Level-2 repository ${repository.id} does not match its profile entry`,
      );
    }
  }
  for (const repositoryId of authoring.repositories.keys()) {
    if (!profile.repositories.some((repository) => repository.id === repositoryId)) {
      throw new Error(`Level-2 repository ${repositoryId} is not in the profile`);
    }
  }
}

async function writeEvaluator(root: string, authoring: Level2Authoring): Promise<void> {
  const cases = authoring.episodes.flatMap((episode) => {
    const repository = authoring.repositories.get(episode.repositoryId)!;
    return episode.stages.map((stage) => ({
      ecosystem: repository.spec.ecosystem,
      episodeId: episode.id,
      failToPass: stage.failToPass,
      functionName: stage.functionName,
      hiddenSentinel: hiddenSentinel(episode.id, stage.id),
      modulePath: stage.modulePath,
      ...(repository.spec.ecosystem === "python"
        ? { packageRoot: repository.spec.packageRoot ?? "." }
        : {}),
      passToPass: stage.passToPass,
      stageId: stage.id,
    }));
  });
  await Promise.all([
    writeText(
      join(root, "evaluator", "cases.json"),
      `${JSON.stringify({ cases, schemaVersion: 1 }, null, 2)}\n`,
    ),
    writeText(join(root, "evaluator", "runner.ts"), LEVEL2_EVALUATOR_RUNNER_SOURCE),
  ]);
}

async function writeLicenseReceipt(
  root: string,
  authoring: Level2Authoring,
): Promise<void> {
  const repositories = await Promise.all(
    [...authoring.repositories.values()]
      .sort((left, right) => left.spec.repositoryId.localeCompare(right.spec.repositoryId))
      .map(async (repository) => ({
        dependencyLock: "not-required-no-dependencies",
        licensePath: `repositories/${repository.spec.repositoryId}/${repository.spec.licensePath}`,
        licenseSha256: sha256(await readFile(join(
          root,
          "repositories",
          repository.spec.repositoryId,
          repository.spec.licensePath,
        ))),
        repositoryId: repository.spec.repositoryId,
        sourceLicense: "MIT",
        sourceUrl: repository.spec.upstream.canonicalUrl,
      })),
  );
  const receipt = {
    datasetLicense: "MIT",
    datasetLicensePath: "LICENSE",
    datasetLicenseSha256: sha256(LEVEL2_MIT_LICENSE),
    patchRedistribution: "permitted-under-source-mit-license",
    rawLogs: "internal-only-not-part-of-dataset",
    repositories,
    sanitizedReadinessReportRedistribution: "permitted",
    schemaVersion: 1,
    taskMaterialLicense: "MIT",
  };
  await writeText(
    join(root, "licenses", "receipt.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
}

async function writeManifest(
  root: string,
  authoring: Level2Authoring,
  profile: ControlledDatasetProfile,
  identities: ReadonlyMap<string, { commit: string; tree: string }>,
): Promise<CodexCodingEffectDatasetV2> {
  const evaluatorCasesSha256 = sha256(
    await readFile(join(root, "evaluator", "cases.json")),
  );
  const surfacesByRepository = new Map<string, string[]>();
  const episodes = [];
  for (const episode of [...authoring.episodes].sort((left, right) =>
    left.id.localeCompare(right.id)
  )) {
    const repository = authoring.repositories.get(episode.repositoryId)!;
    const identity = identities.get(episode.repositoryId);
    if (identity === undefined) {
      throw new Error(`missing Level-2 repository identity ${episode.repositoryId}`);
    }
    let surfaces = surfacesByRepository.get(episode.repositoryId);
    if (surfaces === undefined) {
      surfaces = await loadLevel2VisibleSurfaces(
        join(root, "repositories", episode.repositoryId),
      );
      surfacesByRepository.set(episode.repositoryId, surfaces);
    }
    const historyPath = prehistoryPath(episode.id);
    const historySha256 = sha256(await readFile(join(root, historyPath)));
    const forbiddenFileSha256 = [evaluatorCasesSha256];
    const stages = [];
    for (const [index, stage] of episode.stages.entries()) {
      const patchPath = goldPatchPath(episode.id, stage.id);
      const patchSha256 = sha256(await readFile(join(root, patchPath)));
      forbiddenFileSha256.push(patchSha256);
      stages.push({
        allowedFeedback: [...stage.allowedFeedback],
        expectedChangedFiles: [...stage.expectedChangedFiles].sort(),
        goldPatch: { path: patchPath, sha256: patchSha256 },
        hiddenFailToPass: [
          "bun",
          "{evaluatorRoot}/runner.ts",
          "fail-to-pass",
          episode.id,
          stage.id,
        ],
        hiddenPassToPass: [
          "bun",
          "{evaluatorRoot}/runner.ts",
          "pass-to-pass",
          episode.id,
          stage.id,
        ],
        id: stage.id,
        memoryExpectation: {
          dependencies: stage.memory.dependencies.map((dependency) => ({
            category: dependency.category,
            description: dependency.description,
          })),
          mode: stage.memory.mode,
        },
        position: index + 1,
        promptPath: promptPath(episode.id, stage.taskId),
        snapshot: identity.commit,
        timeoutMs: LEVEL2_STAGE_TIMEOUT_MS,
        visibleTest: [...repository.spec.visibleTest],
      });
    }
    episodes.push({
      allowedPublicLeakageRelations: allowedPublicLeakageRelations(
        episode.stages,
        surfaces,
      ),
      allowedPublicLeakageValues: allowedPublicLeakageValues(
        episode.stages,
        surfaces,
      ),
      author: LEVEL2_DATASET_AUTHOR,
      claimEligibility: "pilot-only",
      ecosystem: repository.spec.ecosystem,
      forbiddenLeakage: {
        fileSha256: [...new Set(forbiddenFileSha256)].sort(),
        strings: episode.stages.flatMap((stage) => [
          ...stage.forbiddenStrings,
          hiddenSentinel(episode.id, stage.id),
        ]),
      },
      id: episode.id,
      language: repository.spec.language,
      preparation: {
        command: [...repository.spec.preparation],
        networkMode: "disabled",
      },
      prehistory: {
        forbiddenLeakageSha256: [...new Set(forbiddenFileSha256)].sort(),
        path: historyPath,
        sha256: historySha256,
        source: "frozen-artifact",
      },
      primaryStratum: episode.primaryStratum,
      provenance:
        "Controlled tasks authored over pinned upstream projections and frozen before any paired execution.",
      repository: {
        baseCommit: identity.commit,
        license: "MIT",
        url: repository.spec.upstream.canonicalUrl,
      },
      sourceType: "controlled-mutation",
      stages,
      stateMode: "canonical-snapshot",
      strata: [...episode.strata],
    });
  }
  const manifest = {
    datasetId: profile.datasetId,
    episodes,
    schemaVersion: 2,
  } as const;
  const dataset = validateC4ControlledPilotDataset(
    parseCodexCodingEffectDataset(manifest),
  );
  await writeText(join(root, "manifest.json"), `${JSON.stringify(dataset, null, 2)}\n`);
  return dataset;
}

// ---------------------------------------------------------------------------
// Authoring checker: fast, local, per-episode verification for authors.
// ---------------------------------------------------------------------------

export interface Level2EpisodeCheckStage {
  baseFailToPass: { fingerprint: string | null; status: string };
  basePassToPass: string;
  baseVisible: string;
  goldFailToPass: string;
  goldPassToPass: string;
  goldVisible: string;
  leakedHiddenValues: string[];
  leakedGoldLines: string[];
  problems: string[];
  promptChars: number;
  stageId: string;
}

export interface Level2EpisodeCheck {
  episodeId: string;
  ok: boolean;
  problems: string[];
  stages: Level2EpisodeCheckStage[];
}

export async function checkLevel2Episode(input: {
  authoringRoot: string;
  bunExecutable?: string;
  episodeId: string;
  sourcesRoot: string;
  workspaceRoot: string;
}): Promise<Level2EpisodeCheck> {
  const authoring = await loadLevel2Authoring(input.authoringRoot);
  const episode = authoring.episodes.find((item) => item.id === input.episodeId);
  if (episode === undefined) {
    throw new Error(`unknown Level-2 episode ${input.episodeId}`);
  }
  const repository = authoring.repositories.get(episode.repositoryId);
  if (repository === undefined) {
    throw new Error(`Level-2 episode ${episode.id} names unknown repository`);
  }
  const workspace = resolve(input.workspaceRoot);
  await rm(workspace, { force: true, recursive: true });
  const repositoryRoot = join(workspace, "repository");
  await materializeLevel2Repository({
    destination: repositoryRoot,
    overlayRoot: repository.overlayRoot,
    projectedRoot: join(resolve(input.sourcesRoot), episode.repositoryId, "projected"),
  });
  // Visible surfaces are collected before the scratch git history exists so
  // hook samples and config never count as public repository text.
  const visibleSurfaces = await loadLevel2VisibleSurfaces(repositoryRoot);
  await initRepository(repositoryRoot, episode.repositoryId);
  const evaluatorRoot = join(workspace, "evaluator");
  await mkdir(evaluatorRoot, { recursive: true });
  await writeText(join(evaluatorRoot, "runner.ts"), LEVEL2_EVALUATOR_RUNNER_SOURCE);
  await writeText(
    join(evaluatorRoot, "cases.json"),
    `${JSON.stringify({
      cases: episode.stages.map((stage) => ({
        ecosystem: repository.spec.ecosystem,
        episodeId: episode.id,
        failToPass: stage.failToPass,
        functionName: stage.functionName,
        hiddenSentinel: hiddenSentinel(episode.id, stage.id),
        modulePath: stage.modulePath,
        ...(repository.spec.ecosystem === "python"
          ? { packageRoot: repository.spec.packageRoot ?? "." }
          : {}),
        passToPass: stage.passToPass,
        stageId: stage.id,
      })),
      schemaVersion: 1,
    }, null, 2)}\n`,
  );
  const bunExecutable = input.bunExecutable ?? process.execPath;
  const publicScalars = new Set(
    level2HiddenScalars(episode.stages)
      .filter((value) => c4HiddenValueAppearsInSurfaces(visibleSurfaces, value))
      .map(leakageScalarKey),
  );
  // The readiness audit renders the frozen history as role-labelled hook
  // context, so the role words themselves are part of the audited surface.
  const historySurface = episode.history.map((record) =>
    `[${record.role}] ${record.text}`
  ).join("\n");
  const publicRelationKeys = new Set(
    level2HiddenRelations(episode.stages)
      .filter((relation) =>
        c4HiddenValueRelationAppearsInSurfaces(visibleSurfaces, relation)
      )
      .map(relationKey),
  );
  const stageRoot = episodeRoot(authoring, episode);
  const promptTexts = new Map<string, string>();
  for (const stage of episode.stages) {
    promptTexts.set(
      stage.id,
      renderLevel2Prompt(
        repository.spec.ecosystem,
        await readFile(join(stageRoot, stage.prompt), "utf8"),
      ),
    );
  }
  const overlaySurface = (await Promise.all(
    (await pathExists(repository.overlayRoot) ? await walk(repository.overlayRoot) : [])
      .map((path) => readFile(path, "utf8")),
  )).join("\n");
  const problems: string[] = [];
  const stages: Level2EpisodeCheckStage[] = [];
  const run = async (command: readonly string[], timeoutMs = LEVEL2_STAGE_TIMEOUT_MS) => {
    const resolved = command.map((part) =>
      part === "bun"
        ? bunExecutable
        : part.replaceAll("{evaluatorRoot}", evaluatorRoot)
    );
    const result = await runBoundaryProcess({
      args: resolved.slice(1),
      cwd: repositoryRoot,
      env: { ...process.env, CI: "1", NO_COLOR: "1" },
      executable: resolved[0]!,
      timeoutMs,
    });
    return {
      output: `${result.stdout}\n${result.stderr}`,
      status: result.spawnError !== undefined
        ? "infrastructure-failure"
        : result.timedOut
        ? "timed-out"
        : result.exitCode === 0
        ? "passed"
        : "failed",
    };
  };
  for (const stage of episode.stages) {
    const stageProblems: string[] = [];
    const f2p = ["bun", "{evaluatorRoot}/runner.ts", "fail-to-pass", episode.id, stage.id];
    const p2p = ["bun", "{evaluatorRoot}/runner.ts", "pass-to-pass", episode.id, stage.id];
    const baseVisible = await run(repository.spec.visibleTest);
    const basePassToPass = await run(p2p);
    const baseFailToPass = await run(f2p);
    const fingerprintMatch = baseFailToPass.output.match(
      /C4_F2P\|[^|\n]+\|[^|\n]+\|case-(\d+)/u,
    );
    const fingerprint = fingerprintMatch?.[0] ?? null;
    if (baseVisible.status !== "passed") {
      stageProblems.push(`base visible test did not pass: ${baseVisible.output.slice(-400)}`);
    }
    if (basePassToPass.status !== "passed") {
      stageProblems.push(`base pass-to-pass did not pass: ${basePassToPass.output.slice(-400)}`);
    }
    if (baseFailToPass.status !== "failed") {
      stageProblems.push(`base fail-to-pass must fail (status ${baseFailToPass.status})`);
    } else if (fingerprint !== `C4_F2P|${episode.id}|${stage.id}|case-1`) {
      stageProblems.push(
        `base fail-to-pass must fail on case-1 first (got ${fingerprint ?? "no fingerprint"}); reorder failToPass so the first case fails on the base tree`,
      );
    }
    const goldRoot = join(stageRoot, stage.gold);
    const goldFiles = (await walk(goldRoot))
      .map((path) => relative(goldRoot, path).split(sep).join("/"))
      .sort();
    if (JSON.stringify(goldFiles) !== JSON.stringify([...stage.expectedChangedFiles].sort())) {
      stageProblems.push(
        `gold tree files ${JSON.stringify(goldFiles)} differ from expectedChangedFiles`,
      );
    }
    let goldVisible = { output: "", status: "skipped" };
    let goldPassToPass = { output: "", status: "skipped" };
    let goldFailToPass = { output: "", status: "skipped" };
    let goldLines: string[] = [];
    try {
      const patch = await captureLevel2GoldPatch({
        expectedChangedFiles: stage.expectedChangedFiles,
        goldRoot,
        repositoryRoot,
      });
      goldLines = meaningfulAddedLines(patch);
      for (const file of goldFiles) {
        const target = join(repositoryRoot, file);
        await mkdir(dirname(target), { recursive: true });
        await cp(join(goldRoot, file), target, { force: true });
      }
      goldVisible = await run(repository.spec.visibleTest);
      goldPassToPass = await run(p2p);
      goldFailToPass = await run(f2p);
    } catch (error) {
      stageProblems.push(`gold patch capture failed: ${errorMessage(error)}`);
    } finally {
      await git(repositoryRoot, ["reset", "--quiet", "--hard", "HEAD"]);
      await git(repositoryRoot, ["clean", "--quiet", "-fd"]);
    }
    for (const [label, result] of [
      ["gold visible test", goldVisible],
      ["gold pass-to-pass", goldPassToPass],
      ["gold fail-to-pass", goldFailToPass],
    ] as const) {
      if (result.status !== "passed") {
        stageProblems.push(`${label} did not pass (${result.status}): ${result.output.slice(-400)}`);
      }
    }
    const prompt = promptTexts.get(stage.id)!;
    if (prompt.length > LEVEL2_MAX_PROMPT_CHARS) {
      stageProblems.push(
        `rendered prompt is ${prompt.length} chars; keep it within ${LEVEL2_MAX_PROMPT_CHARS}`,
      );
    }
    const hiddenSurfaces = [
      ...promptTexts.values(),
      ...stage.allowedFeedback,
      historySurface,
      overlaySurface,
    ];
    const leakedHiddenValues = level2HiddenScalars([stage])
      .filter((value) => !publicScalars.has(leakageScalarKey(value)))
      .filter((value) => c4HiddenValueAppearsInSurfaces(hiddenSurfaces, value))
      .map((value) => JSON.stringify(value));
    if (leakedHiddenValues.length > 0) {
      stageProblems.push(
        `hidden test values appear in prompts, feedback, history, or overlay files: ${leakedHiddenValues.join(", ")}`,
      );
    }
    const leakedRelations = level2HiddenRelations([stage])
      .filter((relation) => !publicRelationKeys.has(relationKey(relation)))
      .filter((relation) =>
        c4HiddenValueRelationAppearsInSurfaces(hiddenSurfaces, relation)
      )
      .map((relation) => JSON.stringify(relation));
    if (leakedRelations.length > 0) {
      stageProblems.push(
        `hidden argument-to-expected pairs both appear in prompts, feedback, or history: ${leakedRelations.slice(0, 5).join(", ")}`,
      );
    }
    const leakedGoldLines = goldLines.filter((line) =>
      hiddenSurfaces.some((surface) => surface.includes(line))
    );
    if (leakedGoldLines.length > 0) {
      stageProblems.push(
        `gold patch lines appear in prompts, feedback, history, or overlay files: ${leakedGoldLines.slice(0, 3).join(" | ")}`,
      );
    }
    stages.push({
      baseFailToPass: { fingerprint, status: baseFailToPass.status },
      basePassToPass: basePassToPass.status,
      baseVisible: baseVisible.status,
      goldFailToPass: goldFailToPass.status,
      goldPassToPass: goldPassToPass.status,
      goldVisible: goldVisible.status,
      leakedGoldLines,
      leakedHiddenValues,
      problems: stageProblems,
      promptChars: prompt.length,
      stageId: stage.id,
    });
    problems.push(...stageProblems.map((problem) => `${stage.id}: ${problem}`));
  }
  return { episodeId: episode.id, ok: problems.length === 0, problems, stages };
}

function meaningfulAddedLines(patch: string): string[] {
  return [...new Set(
    patch.split("\n")
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
      .map((line) => line.slice(1).trim())
      .filter((line) =>
        line.length >= 24 &&
        /[A-Za-z]/u.test(line) &&
        !/^[{}()\[\];,]*$/u.test(line)
      ),
  )];
}

// ---------------------------------------------------------------------------
// Utilities.
// ---------------------------------------------------------------------------

function parseWithSchema<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(
      `invalid Level-2 ${label}: ${issue?.message ?? "schema violation"}` +
        (issue && issue.path.length > 0 ? ` at ${issue.path.join(".")}` : ""),
    );
  }
  return result.data;
}

async function walk(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Level-2 asset closure rejects symlink ${path}`);
    }
    if (entry.isDirectory()) {
      files.push(...await walk(path));
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Level-2 asset closure rejects non-file ${path}`);
    }
    files.push(path);
  }
  return files.sort();
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function assertAbsent(path: string, label: string): Promise<void> {
  if (await pathExists(path)) {
    throw new Error(`${label} already exists: ${path}`);
  }
}

async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, { encoding: "utf8", flag: "wx" });
}

async function git(
  cwd: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  return (await gitRaw(cwd, args, env)).trim();
}

async function gitRaw(
  cwd: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  const result = await runBoundaryProcess({
    args: [...args],
    cwd,
    env: {
      ...(env ?? process.env),
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
    executable: "git",
    timeoutMs: 120_000,
  });
  if (result.spawnError !== undefined || result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr}`);
  }
  return result.stdout;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
