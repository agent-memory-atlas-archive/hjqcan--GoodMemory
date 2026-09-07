import { createHash } from "node:crypto";
import {
  appendFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { z } from "zod";

import {
  assertC4BaselineCeilingReportBindings,
  buildC4BaselinePrompt,
  c4BaselineStageInputSha256,
  serializeC4BaselineCeilingReport,
  verifyC4BaselineDatasetTargets,
  verifyC4BaselineStageEvidenceFiles,
  buildC4BaselineCeilingPlan,
  c4BaselineStageIsTarget,
  c4BaselineStagePosition,
  c4BaselineTargetLabel,
} from "./c4-baseline-ceiling";
import type {
  C4BaselineCeilingReport,
  C4BaselineCeilingTarget,
  C4BaselineFrozenStageBinding,
  C4BaselineStageEvidenceFile,
} from "./c4-baseline-ceiling";
import {
  buildC4AssetLock,
  c4RepositoryIdForUrl,
  loadC4AssetLock,
  materializeC4SourceRepository,
} from "./c4-controlled-dataset";
import {
  C4_REQUIRED_MEMORY_STRATA,
  parseC4IndependentDatasetReview,
  parseC4IndependentReviewDispatch,
  parseC4IndependentReviewProvenance,
  parseC4ReviewInputBundle,
  validateC4ControlledPilotDataset,
} from "./c4-contracts";
import {
  CONTROLLED_DATASET_PROFILES,
  controlledRepositoryIdForUrl,
  resolveControlledDatasetProfile,
} from "./controlled-dataset-profile";
import type { ControlledDatasetProfile } from "./controlled-dataset-profile";
import {
  auditC4SurfaceHiddenArtifactMatrix,
  c4HiddenValueAppearsInSurfaces,
  c4HiddenValueRelationAppearsInSurfaces,
  C4_HIDDEN_ARTIFACT_IDS,
  C4_LEAKAGE_SURFACE_IDS,
  mutationTestC4SurfaceHiddenArtifactMatrix,
} from "./c4-leakage";
import type {
  C4HiddenArtifact,
  C4HiddenValue,
  C4LeakageMatrixCell,
  C4LeakageMutationCell,
  C4LeakageSurface,
  C4LeakageSurfaceId,
} from "./c4-leakage";
import {
  assertC4CanonicalIndependentReviewInstructions,
} from "./c4-review-artifacts";
import {
  loadCodexCodingEffectDataset,
} from "./dataset";
import type {
  CodexCodingEffectDatasetV2,
  CodexCodingEffectEpisode,
} from "./dataset";
import {
  loadFrozenPrehistory,
} from "./frozen-prehistory";
import { runBoundaryProcess } from "./process";
import {
  runEvaluatorTest,
} from "./test-scoring";
import type { EvaluatorTestResult } from "./test-scoring";
import { prepareC3IsolatedClone } from "./c3-workspace";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const licenseReceiptSchema = z.object({
  datasetLicense: z.literal("MIT"),
  datasetLicensePath: z.literal("LICENSE"),
  datasetLicenseSha256: sha256Schema,
  patchRedistribution: z.literal("permitted-under-source-mit-license"),
  rawLogs: z.literal("internal-only-not-part-of-dataset"),
  repositories: z.array(z.object({
    dependencyLock: z.literal("not-required-no-dependencies"),
    licensePath: z.string().min(1),
    licenseSha256: sha256Schema,
    repositoryId: z.string().min(1),
    sourceLicense: z.literal("MIT"),
    sourceUrl: z.url(),
  }).strict()).min(1),
  sanitizedReadinessReportRedistribution: z.literal("permitted"),
  schemaVersion: z.literal(1),
  taskMaterialLicense: z.literal("MIT"),
}).strict();
const authorAttestationSchema = z.object({
  author: z.string().min(1),
  authorTaskName: z.string().min(1),
  authoredBeforePairedExecution: z.literal(true),
  c4PairedOutcomesInspectedBeforeFreeze: z.literal(false),
  c5PairedOutcomesInspectedBeforeFreeze: z.literal(false),
  datasetId: z.string().min(1).refine(
    (datasetId) =>
      CONTROLLED_DATASET_PROFILES.some((profile) =>
        profile.datasetId === datasetId
      ),
    "C4 author attestation names an unknown dataset",
  ),
  frozenAt: z.string().min(1),
  priorV1BaselineCeiling: z.object({
    attemptedStages: z.literal(6),
    decision: z.literal("redesign-episodes-before-c5"),
    evidenceScope: z.literal("aggregate-ceiling-decision-only"),
    patchesInspected: z.literal(false),
    reportPath: z.literal(
      "reports/quality-gates/phase-73/c4-baseline-ceiling-pilot-v1.json",
    ),
    reportSha256: z.literal(
      "28d3bc535cd1c26ed7e30fc7b541f66e16548ff4219d870050adbd823c71a952",
    ),
    resolvedStages: z.literal(6),
    transcriptsInspected: z.literal(false),
  }).strict().optional(),
  schemaVersion: z.literal(3),
  scope: z.string().min(1),
}).strict();
// C4 cases carry one function per stage on `src/tasks.ts`; Level-2 cases add
// the ecosystem, the module the runner imports, the Python package root, and
// an optional per-case function override for pass-to-pass protection of a
// sibling export.
const evaluatorCaseSchema = z.object({
  args: z.array(z.unknown()),
  expected: z.unknown(),
  functionName: z.string().min(1).optional(),
}).strict();
const evaluatorCasesSchema = z.object({
  cases: z.array(z.object({
    ecosystem: z.enum(["bun", "python"]).optional(),
    episodeId: z.string().min(1),
    failToPass: z.array(evaluatorCaseSchema).min(1),
    functionName: z.string().min(1),
    hiddenSentinel: z.string().min(1),
    modulePath: z.string().min(1).optional(),
    packageRoot: z.string().optional(),
    passToPass: z.array(evaluatorCaseSchema).min(1),
    stageId: z.string().min(1),
  }).strict()).min(1),
  schemaVersion: z.literal(1),
}).strict();
const baselineStageResultSchema = z.object({
  changedFiles: z.array(z.string()),
  codexStatus: z.string().min(1),
  disposition: z.enum(["finalized", "infrastructure-failure"]),
  episodeId: z.string().min(1),
  executionFailureStage: z.string().nullable(),
  failToPassStatus: z.string().min(1),
  passToPassStatus: z.string().min(1),
  patchSha256: sha256Schema.nullable(),
  resolved: z.boolean(),
  stageId: z.string().regex(/^stage-[2-9]$/u),
  stageInputSha256: sha256Schema,
  taskFailureReasons: z.array(z.string()),
  threadId: z.string().nullable(),
  stageEvidenceSha256: sha256Schema,
}).strict();
const baselineRoundSchema = z.object({
  attemptedCount: z.number().int().nonnegative(),
  ceilingThreshold: z.number().int().positive(),
  infrastructureFailureCount: z.number().int().nonnegative(),
  position: z.number().int().min(2),
  resolvedCount: z.number().int().nonnegative(),
  stageId: z.string().regex(/^stage-[2-9]$/u),
}).strict();
const baselineCeilingReportSchema = z.object({
  assetLockSha256: sha256Schema,
  assetRootSha256: sha256Schema,
  attemptedCount: z.number().int().nonnegative(),
  ceilingRisk: z.boolean().nullable(),
  claimBoundary: z.literal("diagnostic-no-memory-ceiling-only"),
  codexExecutableSha256: sha256Schema,
  codexVersion: z.string().min(1),
  datasetSnapshotMode: z.literal("asset-locked-copy"),
  datasetId: z.string().min(1).refine(
    (datasetId) =>
      CONTROLLED_DATASET_PROFILES.some((profile) =>
        profile.datasetId === datasetId
      ),
    "C4 baseline report names an unknown dataset",
  ),
  decision: z.enum([
    "inconclusive",
    "proceed-to-c5-pilot",
    "redesign-episodes-before-c5",
  ]),
  generatedAt: z.string().min(1),
  infrastructureFailureCount: z.number().int().nonnegative(),
  manifestSha256: sha256Schema,
  model: z.string().min(1),
  networkAccess: z.literal(false),
  publicClaimEligible: z.literal(false),
  reasoningEffort: z.string().min(1),
  resolvedCount: z.number().int().nonnegative(),
  results: z.array(baselineStageResultSchema),
  rounds: z.array(baselineRoundSchema).min(1).max(8),
  runIdentitySha256: sha256Schema,
  runId: z.string().min(1),
  schemaVersion: z.literal(2),
  stageEvidenceAggregateSha256: sha256Schema,
  stageTimeoutMs: z.number().int().positive(),
  // The exact thresholds and round labels are re-derived from the dataset's
  // ceiling plan by assertC4BaselineCeilingReportBindings.
  strategy: z.object({
    earlyCeilingThreshold: z.number().int().positive(),
    finalCeilingThreshold: z.number().int().positive(),
    firstRound: z.string().min(1),
    laterRounds: z.string().min(1).optional(),
    secondRound: z.string().min(1),
    stage1Excluded: z.literal(true),
  }).strict(),
  testTimeoutMs: z.number().int().positive(),
}).strict();

export const C4_BASELINE_CEILING_REPORT_PATH =
  "reports/quality-gates/phase-73/c4-baseline-ceiling-pilot/report.json";

export interface C4BaseProbeEvidence {
  commit: string;
  dependencyLock: "not-required-no-dependencies";
  failureFingerprintSha256: string;
  repetition: number;
  semanticFingerprintSha256: string;
  tree: string;
}

export interface C4StageReadiness {
  baseProbeStable: boolean;
  baseProbes: C4BaseProbeEvidence[];
  episodeId: string;
  evaluatorCommitments: C4BaselineFrozenStageBinding["evaluatorCommitments"];
  effectivePromptSha256: string;
  goldChangedFiles: string[];
  goldPassed: boolean;
  goldPatchSha256: string;
  goldReplaySha256: string;
  memoryExpectation: "irrelevant-control" | "none" | "required";
  repositoryCommit: string;
  repositoryTree: string;
  stageId: string;
  stageInputSha256: string;
}

type C4LiveReauditSurfaceId =
  | "effective-codex-input-after-seeding"
  | "flat-summary-after-seeding"
  | "goodmemory-export-after-seeding"
  | "goodmemory-hook-context-after-seeding";

export interface C4LeakageReadiness {
  auditSha256: string;
  auditedHiddenArtifacts: string[];
  auditedSurfaces: C4LeakageSurfaceId[];
  candidateBindingVersion: 1;
  candidateExtractionVersion:
    "semantic-documents-exact-relations-corpus-wide-v9";
  c5LiveReauditSurfaces: C4LiveReauditSurfaceId[];
  deferredC5Surfaces: C4LiveReauditSurfaceId[];
  directFrozenSurfaces: C4LeakageSurfaceId[];
  episodeCount: number;
  stageCount: number;
  stageMatrices: Array<{
    auditSha256: string;
    cells: C4LeakageMatrixCell[];
    episodeId: string;
    mutationAuditSha256: string;
    mutationCells: C4LeakageMutationCell[];
    stageId: string;
  }>;
  matrixCellCount: number;
  mutationApplicableCellCount: number;
  mutationCellCount: number;
  mutationNotApplicableCellCount: number;
  normalizationVersion: "nfkc-lowercase-whitespace-numeric-equivalence-v4";
  overlapCount: number;
  runtimeSurfacePolicy:
    "content-preserving-projection-plus-C5-live-reaudit";
  status: "accepted";
}

export interface C4DatasetCoreReadiness {
  assetFiles: Array<{
    path: string;
    sha256: string;
  }>;
  assetLockSha256: string;
  assetRootSha256: string;
  authorAttestation: {
    authorTaskName: string;
    sha256: string;
    status: "accepted";
  };
  claimBoundary: "dataset-readiness-only-no-coding-uplift";
  counts: {
    baseProbes: number;
    episodes: number;
    repositories: number;
    stages: number;
  };
  datasetId: string;
  episodes: Array<{
    author: string;
    id: string;
    memoryExpectationMode: "irrelevant-control" | "none" | "required";
  }>;
  excludedHosts: ["claude-code"];
  host: "codex";
  leakage: C4LeakageReadiness;
  licenses: {
    receiptSha256: string;
    repositoryLicenseCount: number;
    status: "accepted";
  };
  manifestSha256: string;
  nextEvidencePhase: "C4-no-memory-baseline-ceiling-pilot";
  publicClaimEligible: false;
  publicCodingEffectProof: false;
  readmeRowAllowed: false;
  repositories: Array<{
    commit: string;
    id: string;
    tree: string;
    url: string;
  }>;
  schemaVersion: 1;
  stages: C4StageReadiness[];
  status: "accepted";
  strataCounts: Record<string, number>;
}

export interface C4DatasetCoreReadinessResult {
  core: C4DatasetCoreReadiness;
  coreBytes: string;
  coreSha256: string;
}

export interface C4DatasetReadinessReport {
  assetLockSha256: string;
  assetRootSha256: string;
  authorTaskName: string;
  authorAttestationSha256: string;
  baselineCeiling: {
    ceilingRisk: false;
    decision: "proceed-to-c5-pilot";
    infrastructureFailureCount: 0;
    path: string;
    reportSha256: string;
    runIdentitySha256: string;
    stageEvidenceAggregateSha256: string;
  };
  claimBoundary: "dataset-readiness-only-no-coding-uplift";
  coreSha256: string;
  counts: C4DatasetCoreReadiness["counts"];
  datasetId: string;
  excludedHosts: ["claude-code"];
  host: "codex";
  leakageAuditSha256: string;
  manifestSha256: string;
  nextEvidencePhase: "C5-native-longitudinal-pilot";
  phase: "C4";
  publicClaimEligible: false;
  publicCodingEffectProof: false;
  readmeRowAllowed: false;
  reviewedAt: string;
  reviewer: string;
  reviewerAgentName: string;
  reviewerIdentityEvidence:
    "orchestrator-attestation-not-cryptographic-receipt";
  reviewerRequestedTaskName: string;
  reviewerType: "independent-ai-agent";
  reviewContextPolicy: "fork-turns-none";
  reviewDispatchSha256: string;
  reviewInputBundleSha256: string;
  reviewProvenanceSha256: string;
  reviewRequestSha256: string;
  reviewSha256: string;
  schemaVersion: 3;
  status: "accepted";
}

export interface C4DatasetReadinessResult {
  baselineBytes: string;
  dispatchBytes: string;
  inputBundleBytes: string;
  provenanceBytes: string;
  report: C4DatasetReadinessReport;
  reportBytes: string;
  reportSha256: string;
  requestBytes: string;
  reviewBytes: string;
}

export async function runC4DatasetCoreReadiness(input: {
  datasetRoot: string;
  workspaceRoot: string;
}): Promise<C4DatasetCoreReadinessResult> {
  const datasetRoot = resolve(input.datasetRoot);
  const workspaceRoot = resolve(input.workspaceRoot);
  if (pathsOverlap(datasetRoot, workspaceRoot)) {
    throw new Error("C4 readiness workspace must not overlap the dataset root");
  }

  const { assetLock, assetLockSha256 } = await loadC4AssetLock(datasetRoot);
  const recomputedAssetLock = await buildC4AssetLock(datasetRoot);
  if (JSON.stringify(assetLock) !== JSON.stringify(recomputedAssetLock)) {
    throw new Error("C4 asset lock mismatch");
  }
  const loaded = await loadCodexCodingEffectDataset(datasetRoot);
  const dataset = validateC4ControlledPilotDataset(loaded.dataset);
  const manifestAsset = assetLock.files.find((file) =>
    file.path === "manifest.json"
  );
  if (manifestAsset?.sha256 !== loaded.manifestSha256) {
    throw new Error("C4 manifest hash is not bound by the asset lock");
  }
  const licenses = await verifyLicenses(datasetRoot, dataset);
  const authorAttestation = await verifyAuthorAttestation(datasetRoot, dataset);
  const leakage = await auditC4Leakage(datasetRoot, dataset);

  await assertAbsent(workspaceRoot, "C4 readiness workspace");
  await mkdir(workspaceRoot, { recursive: true });
  const logPath = join(workspaceRoot, "readiness-events.jsonl");
  let completed = false;
  try {
    await logEvent(logPath, "readiness_started", {
      assetRootSha256: assetLock.assetRootSha256,
      datasetId: dataset.datasetId,
      manifestSha256: loaded.manifestSha256,
    });
    const sources = await materializeSources(datasetRoot, workspaceRoot, dataset);
    const stages: C4StageReadiness[] = [];
    for (const episode of dataset.episodes) {
      const source = sources.get(episode.repository.url);
      if (source === undefined) {
        throw new Error(`C4 source repository missing for ${episode.id}`);
      }
      for (const stage of episode.stages) {
        await logEvent(logPath, "stage_started", {
          episodeId: episode.id,
          stageId: stage.id,
        });
        const readiness = await verifyStage({
          datasetRoot,
          episode,
          evaluatorRoot: join(datasetRoot, "evaluator"),
          sourceRepository: source.path,
          sourceTree: source.tree,
          stage,
          workspaceRoot,
        });
        stages.push(readiness);
        await logEvent(logPath, "stage_completed", {
          episodeId: episode.id,
          goldPassed: readiness.goldPassed,
          stageId: stage.id,
        });
      }
    }

    const repositories = [...sources.entries()]
      .map(([url, source]) => ({
        commit: source.commit,
        id: source.id,
        tree: source.tree,
        url,
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
    const core: C4DatasetCoreReadiness = {
      assetFiles: assetLock.files.map((file) => ({
        path: file.path,
        sha256: file.sha256,
      })).sort((first, second) => first.path.localeCompare(second.path)),
      assetLockSha256,
      assetRootSha256: assetLock.assetRootSha256,
      authorAttestation,
      claimBoundary: "dataset-readiness-only-no-coding-uplift",
      counts: {
        baseProbes: stages.reduce(
          (total, stage) => total + stage.baseProbes.length,
          0,
        ),
        episodes: dataset.episodes.length,
        repositories: repositories.length,
        stages: stages.length,
      },
      datasetId: dataset.datasetId,
      episodes: dataset.episodes.map((episode) => ({
        author: episode.author,
        id: episode.id,
        memoryExpectationMode: c4EpisodeMemoryExpectationMode(
          episode,
          resolveControlledDatasetProfile(dataset.datasetId),
        ),
      })),
      excludedHosts: ["claude-code"],
      host: "codex",
      leakage,
      licenses,
      manifestSha256: loaded.manifestSha256,
      nextEvidencePhase: "C4-no-memory-baseline-ceiling-pilot",
      publicClaimEligible: false,
      publicCodingEffectProof: false,
      readmeRowAllowed: false,
      repositories,
      schemaVersion: 1,
      stages,
      status: "accepted",
      strataCounts: Object.fromEntries(C4_REQUIRED_MEMORY_STRATA.map(
        (stratum) => [
          stratum,
          dataset.episodes.filter((episode) => episode.strata.includes(stratum))
            .length,
        ],
      )),
    };
    const coreBytes = serializeC4DatasetCoreReadiness(core);
    const result = {
      core,
      coreBytes,
      coreSha256: sha256(coreBytes),
    };
    await logEvent(logPath, "readiness_completed", {
      coreSha256: result.coreSha256,
      stageCount: stages.length,
    });
    completed = true;
    return result;
  } catch (error) {
    await logEvent(logPath, "readiness_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    if (completed) {
      await rm(workspaceRoot, { recursive: true });
    }
  }
}

export function validateC4BaselineCeilingEvidence(
  baselineBytes: string,
  stageEvidenceFiles: readonly C4BaselineStageEvidenceFile[],
  expectedTargets: readonly C4BaselineCeilingTarget[],
  frozenBindings: readonly C4BaselineFrozenStageBinding[],
): {
  report: C4BaselineCeilingReport;
  reportSha256: string;
} {
  const parsed = baselineCeilingReportSchema.safeParse(
    parseJsonBytes(baselineBytes, "baseline ceiling report"),
  );
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      issue?.message ?? "invalid C4 baseline ceiling report",
    );
  }
  const report: C4BaselineCeilingReport = parsed.data;
  if (serializeC4BaselineCeilingReport(report) !== baselineBytes) {
    throw new Error("C4 baseline ceiling report is not canonically serialized");
  }
  assertC4BaselineCeilingReportBindings(
    report,
    buildC4BaselineCeilingPlan(expectedTargets, {
      targetLabel: c4BaselineTargetLabel(report.datasetId),
    }),
  );
  verifyC4BaselineDatasetTargets(report, expectedTargets);
  verifyC4BaselineStageEvidenceFiles(
    report,
    stageEvidenceFiles,
    frozenBindings,
  );
  if (report.decision === "redesign-episodes-before-c5") {
    throw new Error(
      "C4 baseline ceiling report requires episode redesign before C5",
    );
  }
  if (report.decision === "inconclusive") {
    throw new Error("C4 baseline ceiling report is inconclusive");
  }
  if (
    report.ceilingRisk !== false ||
    report.infrastructureFailureCount !== 0
  ) {
    throw new Error("C4 baseline ceiling report is not eligible for C5");
  }
  return {
    report,
    reportSha256: sha256(baselineBytes),
  };
}

export function finalizeC4DatasetReadiness(input: {
  baselineBytes: string;
  baselinePath?: string;
  baselineStageEvidenceFiles: readonly C4BaselineStageEvidenceFile[];
  dispatchBytes: string;
  inputBundleBytes: string;
  provenanceBytes: string;
  requestBytes: string;
  result: C4DatasetCoreReadinessResult;
  reviewBytes: string;
}): C4DatasetReadinessResult {
  const baselineStages = input.result.core.stages.filter((stage) =>
    c4BaselineStageIsTarget(input.result.core.datasetId, {
      memoryExpectation: stage.memoryExpectation,
      position: c4BaselineStagePosition(stage.stageId),
    })
  );
  const baseline = validateC4BaselineCeilingEvidence(
    input.baselineBytes,
    input.baselineStageEvidenceFiles,
    baselineStages.map((stage) => ({
      episodeId: stage.episodeId,
      position: c4BaselineStagePosition(stage.stageId),
      stageId: stage.stageId,
      stageInputSha256: stage.stageInputSha256,
    })),
    baselineStages.map((stage) => ({
      episodeId: stage.episodeId,
      evaluatorCommitments: stage.evaluatorCommitments,
      promptSha256: stage.effectivePromptSha256,
      repositoryCommit: stage.repositoryCommit,
      repositoryTree: stage.repositoryTree,
      stageId: stage.stageId,
    })),
  );
  assertC4CanonicalIndependentReviewInstructions({
    dispatchBytes: input.dispatchBytes,
    inputBundleBytes: input.inputBundleBytes,
    requestBytes: input.requestBytes,
  });
  const review = parseC4IndependentDatasetReview(
    parseJsonBytes(input.reviewBytes, "review response"),
  );
  const inputBundle = parseC4ReviewInputBundle(
    parseJsonBytes(input.inputBundleBytes, "review input bundle"),
  );
  const dispatch = parseC4IndependentReviewDispatch(
    parseJsonBytes(input.dispatchBytes, "review dispatch"),
  );
  const provenance = parseC4IndependentReviewProvenance(
    parseJsonBytes(input.provenanceBytes, "review provenance"),
  );
  if (input.requestBytes.trim().length === 0) {
    throw new Error("C4 independent review request must not be empty");
  }
  if (review.status !== "accepted") {
    throw new Error("C4 independent review requested changes");
  }
  const requestSha256 = sha256(input.requestBytes);
  const dispatchSha256 = sha256(input.dispatchBytes);
  const inputBundleSha256 = sha256(input.inputBundleBytes);
  const reviewSha256 = sha256(input.reviewBytes);
  if (provenance.request.sha256 !== requestSha256) {
    throw new Error("C4 independent review request hash mismatch");
  }
  if (provenance.dispatch.sha256 !== dispatchSha256) {
    throw new Error("C4 independent review dispatch hash mismatch");
  }
  if (
    provenance.inputBundle.sha256 !== inputBundleSha256 ||
    review.inputBundleSha256 !== inputBundleSha256
  ) {
    throw new Error("C4 independent review input bundle hash mismatch");
  }
  if (provenance.response.sha256 !== reviewSha256) {
    throw new Error("C4 independent review response hash mismatch");
  }
  if (
    provenance.authorTaskName !==
      input.result.core.authorAttestation.authorTaskName ||
    dispatch.authorTaskName !==
      input.result.core.authorAttestation.authorTaskName
  ) {
    throw new Error("C4 independent review author task binding mismatch");
  }
  if (
    provenance.reviewer.agentName !== dispatch.reviewerAgentName ||
    provenance.reviewer.requestedTaskName !== dispatch.requestedTaskName ||
    provenance.reviewer.orchestratorAttestation.canonicalTaskName !==
      dispatch.reviewerAgentName ||
    review.reviewerTaskName !== dispatch.reviewerAgentName
  ) {
    throw new Error("C4 independent review identity binding mismatch");
  }
  const bindings: Array<[string, string, string]> = [
    ["asset lock", inputBundle.assetLockSha256, input.result.core.assetLockSha256],
    ["asset root", inputBundle.assetRootSha256, input.result.core.assetRootSha256],
    [
      "leakage audit",
      inputBundle.leakageAuditSha256,
      input.result.core.leakage.auditSha256,
    ],
    ["manifest", inputBundle.manifestSha256, input.result.core.manifestSha256],
    ["readiness core", inputBundle.readinessCoreSha256, input.result.coreSha256],
    ["asset lock", review.assetLockSha256, inputBundle.assetLockSha256],
    ["asset root", review.assetRootSha256, inputBundle.assetRootSha256],
    ["leakage audit", review.leakageAuditSha256, inputBundle.leakageAuditSha256],
    ["manifest", review.manifestSha256, inputBundle.manifestSha256],
    ["readiness core", review.readinessCoreSha256, inputBundle.readinessCoreSha256],
  ];
  for (const [label, reviewed, actual] of bindings) {
    if (reviewed !== actual) {
      throw new Error(`C4 independent review ${label} binding mismatch`);
    }
  }
  if (
    review.datasetId !== input.result.core.datasetId ||
    inputBundle.datasetId !== input.result.core.datasetId ||
    provenance.datasetId !== input.result.core.datasetId
  ) {
    throw new Error("C4 independent review dataset binding mismatch");
  }
  if (
    JSON.stringify(inputBundle.assetFiles) !==
      JSON.stringify(input.result.core.assetFiles)
  ) {
    throw new Error(
      "C4 review input bundle does not match the full frozen asset inventory",
    );
  }
  const baselineBindings: Array<[string, string, string]> = [
    [
      "asset lock",
      baseline.report.assetLockSha256,
      input.result.core.assetLockSha256,
    ],
    [
      "asset root",
      baseline.report.assetRootSha256,
      input.result.core.assetRootSha256,
    ],
    ["dataset", baseline.report.datasetId, input.result.core.datasetId],
    ["manifest", baseline.report.manifestSha256, input.result.core.manifestSha256],
  ];
  for (const [label, actual, expected] of baselineBindings) {
    if (actual !== expected) {
      throw new Error(`C4 baseline ${label} binding mismatch`);
    }
  }
  const expectedEpisodes = input.result.core.episodes.map((episode) =>
    `${episode.id}\0${episode.author}\0${episode.memoryExpectationMode}`
  ).sort();
  const reviewedEpisodes = review.episodeReviews.map((episode) =>
    `${episode.episodeId}\0${episode.author}\0${episode.memoryExpectationMode}`
  ).sort();
  if (JSON.stringify(expectedEpisodes) !== JSON.stringify(reviewedEpisodes)) {
    throw new Error("C4 independent review episode coverage mismatch");
  }

  const report: C4DatasetReadinessReport = {
    assetLockSha256: input.result.core.assetLockSha256,
    assetRootSha256: input.result.core.assetRootSha256,
    authorTaskName: input.result.core.authorAttestation.authorTaskName,
    authorAttestationSha256: input.result.core.authorAttestation.sha256,
    baselineCeiling: {
      ceilingRisk: false,
      decision: "proceed-to-c5-pilot",
      infrastructureFailureCount: 0,
      path: input.baselinePath ?? C4_BASELINE_CEILING_REPORT_PATH,
      reportSha256: baseline.reportSha256,
      runIdentitySha256: baseline.report.runIdentitySha256,
      stageEvidenceAggregateSha256:
        baseline.report.stageEvidenceAggregateSha256,
    },
    claimBoundary: "dataset-readiness-only-no-coding-uplift",
    coreSha256: input.result.coreSha256,
    counts: input.result.core.counts,
    datasetId: input.result.core.datasetId,
    excludedHosts: ["claude-code"],
    host: "codex",
    leakageAuditSha256: input.result.core.leakage.auditSha256,
    manifestSha256: input.result.core.manifestSha256,
    nextEvidencePhase: "C5-native-longitudinal-pilot",
    phase: "C4",
    publicClaimEligible: false,
    publicCodingEffectProof: false,
    readmeRowAllowed: false,
    reviewedAt: review.reviewedAt,
    reviewer: review.reviewer,
    reviewerAgentName: provenance.reviewer.agentName,
    reviewerIdentityEvidence:
      "orchestrator-attestation-not-cryptographic-receipt",
    reviewerRequestedTaskName: provenance.reviewer.requestedTaskName,
    reviewerType: provenance.reviewer.type,
    reviewContextPolicy: provenance.reviewer.contextPolicy,
    reviewDispatchSha256: dispatchSha256,
    reviewInputBundleSha256: inputBundleSha256,
    reviewProvenanceSha256: sha256(input.provenanceBytes),
    reviewRequestSha256: requestSha256,
    reviewSha256,
    schemaVersion: 3,
    status: "accepted",
  };
  const reportBytes = `${JSON.stringify(report, null, 2)}\n`;
  return {
    baselineBytes: input.baselineBytes,
    dispatchBytes: input.dispatchBytes,
    inputBundleBytes: input.inputBundleBytes,
    provenanceBytes: input.provenanceBytes,
    report,
    reportBytes,
    reportSha256: sha256(reportBytes),
    requestBytes: input.requestBytes,
    reviewBytes: input.reviewBytes,
  };
}

export function serializeC4DatasetCoreReadiness(
  core: C4DatasetCoreReadiness,
): string {
  return `${JSON.stringify(core, null, 2)}\n`;
}

async function materializeSources(
  datasetRoot: string,
  workspaceRoot: string,
  dataset: CodexCodingEffectDatasetV2,
): Promise<Map<string, {
  commit: string;
  id: string;
  path: string;
  tree: string;
}>> {
  const sources = new Map<string, {
    commit: string;
    id: string;
    path: string;
    tree: string;
  }>();
  for (const episode of dataset.episodes) {
    if (sources.has(episode.repository.url)) {
      const existing = sources.get(episode.repository.url)!;
      if (existing.commit !== episode.repository.baseCommit) {
        throw new Error("C4 repository URL resolves to multiple base commits");
      }
      continue;
    }
    const id = c4RepositoryIdForUrl(episode.repository.url);
    const path = join(workspaceRoot, "sources", id);
    const identity = await materializeC4SourceRepository({
      datasetRoot,
      destination: path,
      repositoryId: id,
    });
    if (identity.commit !== episode.repository.baseCommit) {
      throw new Error(`C4 reconstructed source commit mismatch for ${id}`);
    }
    sources.set(episode.repository.url, { id, path, ...identity });
  }
  return sources;
}

async function verifyStage(input: {
  datasetRoot: string;
  episode: CodexCodingEffectDatasetV2["episodes"][number];
  evaluatorRoot: string;
  sourceRepository: string;
  sourceTree: string;
  stage: CodexCodingEffectDatasetV2["episodes"][number]["stages"][number];
  workspaceRoot: string;
}): Promise<C4StageReadiness> {
  const baseProbes: C4BaseProbeEvidence[] = [];
  for (let repetition = 1; repetition <= 3; repetition += 1) {
    const clonePath = join(
      input.workspaceRoot,
      "base",
      input.episode.id,
      input.stage.id,
      `probe-${repetition}`,
    );
    const clone = await prepareC3IsolatedClone({
      destination: clonePath,
      expectedCommit: input.stage.snapshot,
      sourceRepository: input.sourceRepository,
    });
    if (clone.tree !== input.sourceTree) {
      throw new Error(`C4 base tree drift for ${input.episode.id}/${input.stage.id}`);
    }
    const tests = await runStageTests({
      cwd: clone.path,
      episode: input.episode,
      evaluatorRoot: input.evaluatorRoot,
      stage: input.stage,
    });
    const failureFingerprint = expectedFailureFingerprint(
      input.episode.id,
      input.stage.id,
    );
    assertPassed(tests.preparation, "base preparation", input);
    assertPassed(tests.visible, "base visible", input);
    assertPassed(tests.passToPass, "base pass-to-pass", input);
    if (
      tests.failToPass.status !== "failed" ||
      !`${tests.failToPass.stdout}\n${tests.failToPass.stderr}`.includes(
        failureFingerprint,
      )
    ) {
      throw new Error(
        `C4 base fail-to-pass did not produce its expected fingerprint for ${input.episode.id}/${input.stage.id}: ${testSummary(tests.failToPass)}`,
      );
    }
    const semanticFingerprintSha256 = sha256(JSON.stringify({
      commit: clone.commit,
      dependencyLock: "not-required-no-dependencies",
      failToPass: "expected-failure",
      failureFingerprintSha256: sha256(failureFingerprint),
      passToPass: "passed",
      preparation: "passed",
      tree: clone.tree,
      visible: "passed",
    }));
    baseProbes.push({
      commit: clone.commit,
      dependencyLock: "not-required-no-dependencies",
      failureFingerprintSha256: sha256(failureFingerprint),
      repetition,
      semanticFingerprintSha256,
      tree: clone.tree,
    });
    await rm(clone.path, { recursive: true });
  }
  const fingerprints = new Set(baseProbes.map((probe) =>
    probe.semanticFingerprintSha256
  ));
  if (fingerprints.size !== 1) {
    throw new Error(`C4 base probes are unstable for ${input.episode.id}/${input.stage.id}`);
  }

  const goldClonePath = join(
    input.workspaceRoot,
    "gold",
    input.episode.id,
    input.stage.id,
  );
  const goldClone = await prepareC3IsolatedClone({
    destination: goldClonePath,
    expectedCommit: input.stage.snapshot,
    sourceRepository: input.sourceRepository,
  });
  const patchPath = join(input.datasetRoot, input.stage.goldPatch.path);
  const patchBytes = await readFile(patchPath, "utf8");
  if (sha256(patchBytes) !== input.stage.goldPatch.sha256) {
    throw new Error(`C4 gold patch hash drift for ${input.episode.id}/${input.stage.id}`);
  }
  await gitApply(goldClone.path, patchPath);
  const changedFiles = await captureC4ChangedFiles(goldClone.path);
  if (
    JSON.stringify(changedFiles) !==
      JSON.stringify([...input.stage.expectedChangedFiles].sort())
  ) {
    throw new Error(`C4 gold patch changed unexpected files for ${input.episode.id}/${input.stage.id}`);
  }
  const replayDiff = await captureC4GoldReplay(
    goldClone.path,
    input.stage.expectedChangedFiles,
  );
  const goldReplaySha256 = sha256(replayDiff);
  if (goldReplaySha256 !== input.stage.goldPatch.sha256) {
    throw new Error(`C4 gold replay bytes drift for ${input.episode.id}/${input.stage.id}`);
  }
  const goldTests = await runStageTests({
    cwd: goldClone.path,
    episode: input.episode,
    evaluatorRoot: input.evaluatorRoot,
    stage: input.stage,
  });
  assertPassed(goldTests.preparation, "gold preparation", input);
  assertPassed(goldTests.visible, "gold visible", input);
  assertPassed(goldTests.passToPass, "gold pass-to-pass", input);
  assertPassed(goldTests.failToPass, "gold fail-to-pass", input);
  await rm(goldClone.path, { recursive: true });
  const evaluatorCommitments = await Promise.all(
    (["cases.json", "runner.ts"] as const).map(async (relativePath) => ({
      relativePath,
      sha256: sha256(await readFile(join(input.evaluatorRoot, relativePath))),
    })),
  );
  const effectivePrompt = buildC4BaselinePrompt({
    allowedFeedback: input.stage.allowedFeedback,
    prompt: await readFile(join(input.datasetRoot, input.stage.promptPath), "utf8"),
  });

  return {
    baseProbeStable: true,
    baseProbes,
    episodeId: input.episode.id,
    evaluatorCommitments,
    effectivePromptSha256: sha256(effectivePrompt),
    goldChangedFiles: changedFiles,
    goldPassed: true,
    goldPatchSha256: input.stage.goldPatch.sha256,
    goldReplaySha256,
    memoryExpectation: input.stage.memoryExpectation.mode,
    repositoryCommit: input.stage.snapshot,
    repositoryTree: input.sourceTree,
    stageId: input.stage.id,
    stageInputSha256: c4BaselineStageInputSha256(
      input.episode,
      input.stage,
    ),
  };
}

async function runStageTests(input: {
  cwd: string;
  episode: CodexCodingEffectDatasetV2["episodes"][number];
  evaluatorRoot: string;
  stage: CodexCodingEffectDatasetV2["episodes"][number]["stages"][number];
}): Promise<{
  failToPass: EvaluatorTestResult;
  passToPass: EvaluatorTestResult;
  preparation: EvaluatorTestResult;
  visible: EvaluatorTestResult;
}> {
  const visibleCommand = input.stage.visibleTest;
  if (visibleCommand === undefined) {
    throw new Error(`C4 stage ${input.episode.id}/${input.stage.id} lacks a visible test`);
  }
  const preparation = await runEvaluatorTest({
    command: input.episode.preparation.command,
    cwd: input.cwd,
    evaluatorRoot: input.evaluatorRoot,
    kind: "visible",
    timeoutMs: input.stage.timeoutMs,
  });
  const visible = await runEvaluatorTest({
    command: visibleCommand,
    cwd: input.cwd,
    evaluatorRoot: input.evaluatorRoot,
    kind: "visible",
    timeoutMs: input.stage.timeoutMs,
  });
  const passToPass = await runEvaluatorTest({
    command: input.stage.hiddenPassToPass,
    cwd: input.cwd,
    evaluatorRoot: input.evaluatorRoot,
    kind: "pass-to-pass",
    timeoutMs: input.stage.timeoutMs,
  });
  const failToPass = await runEvaluatorTest({
    command: input.stage.hiddenFailToPass,
    cwd: input.cwd,
    evaluatorRoot: input.evaluatorRoot,
    kind: "fail-to-pass",
    timeoutMs: input.stage.timeoutMs,
  });
  return { failToPass, passToPass, preparation, visible };
}

async function auditC4Leakage(
  datasetRoot: string,
  dataset: CodexCodingEffectDatasetV2,
): Promise<C4LeakageReadiness> {
  const evaluatorRoot = join(datasetRoot, "evaluator");
  const evaluatorCasesBytes = await readFile(
    join(evaluatorRoot, "cases.json"),
    "utf8",
  );
  const evaluatorRunnerBytes = await readFile(
    join(evaluatorRoot, "runner.ts"),
    "utf8",
  );
  const evaluatorCases = evaluatorCasesSchema.safeParse(
    JSON.parse(evaluatorCasesBytes) as unknown,
  );
  if (!evaluatorCases.success) {
    throw new Error("invalid C4 evaluator cases for leakage audit");
  }
  const stageMatrices: C4LeakageReadiness["stageMatrices"] = [];
  for (const episode of dataset.episodes) {
    if (episode.prehistory.source !== "frozen-artifact") {
      throw new Error(`C4 episode ${episode.id} must use frozen prehistory`);
    }
    const artifact = await loadFrozenPrehistory({
      expectedSha256: episode.prehistory.sha256,
      path: join(datasetRoot, episode.prehistory.path),
    });
    const repositoryId = c4RepositoryIdForUrl(episode.repository.url);
    const repositoryRoot = join(datasetRoot, "repositories", repositoryId);
    const repositorySurfaceFiles = await collectC4RepositorySurfaceFiles(
      repositoryRoot,
    );
    const repositoryInstructionFiles = repositorySurfaceFiles
      .filter((file) => file.path.split("/").at(-1) === "AGENTS.md");
    const visibleFiles = repositorySurfaceFiles
      .filter((file) => file.path.split("/").at(-1) !== "AGENTS.md");
    const publicNaturalSurfaces = repositorySurfaceFiles
      .flatMap((file) => [file.path, file.content]);
    const prehistoryMessages = artifact.records.map((record) =>
      record.message
    ).join("\n");
    const episodeCases = evaluatorCases.data.cases
      .filter((testCase) => testCase.episodeId === episode.id);
    if (episodeCases.length !== episode.stages.length) {
      throw new Error(`C4 hidden evaluator coverage mismatch for ${episode.id}`);
    }
    const goldPatches = await Promise.all(episode.stages.map(async (stage) => ({
      bytes: await readFile(join(datasetRoot, stage.goldPatch.path), "utf8"),
      sha256: stage.goldPatch.sha256,
    })));
    const declaredForbiddenHashes = [...new Set([
      sha256(evaluatorCasesBytes),
      ...goldPatches.map((patch) => patch.sha256),
    ])].sort();
    if (
      JSON.stringify(declaredForbiddenHashes) !==
        JSON.stringify([...episode.prehistory.forbiddenLeakageSha256].sort()) ||
      JSON.stringify(declaredForbiddenHashes) !==
        JSON.stringify([...episode.forbiddenLeakage.fileSha256].sort())
    ) {
      throw new Error(`C4 forbidden source commitments drifted for ${episode.id}`);
    }

    const flatSummarySurface = artifact.records.map((record) =>
      `${record.role}: ${record.message}`
    ).join("\n");
    const goodMemoryExportSurface = JSON.stringify({
      durable: {
        episodes: artifact.records.map((record) => ({
          content: record.message,
          role: record.role,
          sourceId: record.id,
        })),
      },
      schemaVersion: 1,
    });
    const goodMemoryHookContextSurface = artifact.records.map((record) =>
      `[${record.role}] ${record.message}`
    ).join("\n");
    const allHiddenValues = uniqueHiddenValues(
      episodeCases.flatMap((testCase) => [
        ...testCase.failToPass,
        ...testCase.passToPass,
      ]).flatMap((testCase) => [
        ...collectHiddenValues(testCase.args),
        ...collectHiddenValues(testCase.expected),
      ]),
    );
    const declaredAllowedValues = uniqueHiddenValues(
      episode.allowedPublicLeakageValues ?? [],
    );
    const declaredAllowedRelations = uniqueHiddenValueRelations(
      episode.allowedPublicLeakageRelations ?? [],
    );
    const hiddenValueKeys = new Set(allHiddenValues.map(hiddenValueKey));
    for (const value of declaredAllowedValues) {
      if (
        !hiddenValueKeys.has(hiddenValueKey(value)) ||
        !c4HiddenValueAppearsInSurfaces(publicNaturalSurfaces, value)
      ) {
        throw new Error(
          `C4 public leakage allowlist drifted for ${episode.id}`,
        );
      }
    }
    const hiddenRelationKeys = new Set(
      episodeCases.flatMap((testCase) => [
        ...testCase.failToPass,
        ...testCase.passToPass,
      ]).flatMap(hiddenCaseRelations).map(hiddenValueRelationKey),
    );
    for (const relation of declaredAllowedRelations) {
      if (
        !hiddenRelationKeys.has(hiddenValueRelationKey(relation)) ||
        !c4HiddenValueRelationAppearsInSurfaces(
          publicNaturalSurfaces,
          relation,
        )
      ) {
        throw new Error(
          `C4 public leakage relation proof drifted for ${episode.id}`,
        );
      }
    }
    const declaredAllowedValueKeys = new Set(
      declaredAllowedValues.map(hiddenValueKey),
    );
    const declaredAllowedRelationKeys = new Set(
      declaredAllowedRelations.map(hiddenValueRelationKey),
    );
    for (const [stageIndex, stage] of episode.stages.entries()) {
      const testCase = episodeCases.find((candidate) =>
        candidate.stageId === stage.id
      );
      const goldPatch = goldPatches[stageIndex];
      if (testCase === undefined || goldPatch === undefined) {
        throw new Error(
          `C4 hidden evaluator stage coverage mismatch for ${episode.id}/${stage.id}`,
        );
      }
      const allowedFeedbackSurface = stage.allowedFeedback.join("\n");
      const stagePromptSurface = await readFile(
        join(datasetRoot, stage.promptPath),
        "utf8",
      );
      const effectiveCodexInputSurface = [
        buildC4BaselinePrompt({
          allowedFeedback: stage.allowedFeedback,
          prompt: stagePromptSurface,
        }),
        goodMemoryHookContextSurface,
      ].join("\n");
      const surfaces: C4LeakageSurface[] = [
        {
          content: allowedFeedbackSurface,
          id: "allowed-feedback",
        },
        {
          content: effectiveCodexInputSurface,
          hiddenValueContent: effectiveCodexInputSurface,
          id: "effective-codex-input-after-seeding",
        },
        {
          content: flatSummarySurface,
          id: "flat-summary-after-seeding",
        },
        {
          content: artifact.sourceBytes,
          hiddenValueContent: prehistoryMessages,
          id: "frozen-prehistory",
        },
        {
          content: goodMemoryExportSurface,
          hiddenValueContent: prehistoryMessages,
          id: "goodmemory-export-after-seeding",
        },
        {
          content: goodMemoryHookContextSurface,
          hiddenValueContent: prehistoryMessages,
          id: "goodmemory-hook-context-after-seeding",
        },
        {
          content: JSON.stringify(repositoryInstructionFiles),
          fragmentContents: repositoryInstructionFiles
            .flatMap((file) => [file.path, file.content]),
          hiddenValueContents: repositoryInstructionFiles
            .flatMap((file) => [file.path, file.content]),
          id: "repository-instructions",
        },
        {
          content: stagePromptSurface,
          id: "stage-prompts",
        },
        {
          content: JSON.stringify(visibleFiles),
          fragmentContents: visibleFiles
            .flatMap((file) => [file.path, file.content]),
          hiddenValueContents: visibleFiles
            .flatMap((file) => [file.path, file.content]),
          id: "visible-repository-files",
        },
      ];
      const stageCases = [
        ...testCase.failToPass,
        ...testCase.passToPass,
      ];
      const hiddenSourceContent = [
        evaluatorRunnerBytes,
        JSON.stringify({
          cases: [testCase],
          schemaVersion: 1,
        }, null, 2),
      ].join("\n");
      const hiddenValues = uniqueHiddenValues(
        stageCases.flatMap((hiddenCase) => [
          ...collectHiddenValues(hiddenCase.args),
          ...collectHiddenValues(hiddenCase.expected),
        ]),
      ).filter((value) =>
        !declaredAllowedValueKeys.has(hiddenValueKey(value))
      );
      const hiddenValueRelations = uniqueHiddenValueRelations(
        stageCases.flatMap(hiddenCaseRelations),
      ).filter((relation) =>
        !declaredAllowedRelationKeys.has(hiddenValueRelationKey(relation))
      );
      const goldCandidateLines = meaningfulAddedLines(goldPatch.bytes);
      const hiddenSourceCandidateLines = [...new Set([
        ...meaningfulSourceLines(evaluatorRunnerBytes),
        ...hiddenStageMetadataFragments(testCase),
        ...stageCases.flatMap((hiddenCase) => {
          const completeCase = {
            args: hiddenCase.args,
            expected: hiddenCase.expected,
          };
          return [
            JSON.stringify(completeCase),
            JSON.stringify(completeCase, null, 2),
          ];
        }),
      ])];
      const expectedChangedFiles = [...new Set(
        stage.expectedChangedFiles,
      )].sort();
      const artifacts: C4HiddenArtifact[] = [
        {
          allowedPublicFragments: expectedChangedFiles.filter((fragment) =>
            containsNormalizedInSurfaces(publicNaturalSurfaces, fragment)
          ),
          content: JSON.stringify(expectedChangedFiles),
          fragments: expectedChangedFiles.filter((fragment) =>
            !containsNormalizedInSurfaces(publicNaturalSurfaces, fragment)
          ),
          id: "expected-changed-files",
        },
        {
          allowedPublicFragments: goldCandidateLines.filter((fragment) =>
            containsNormalizedInSurfaces(publicNaturalSurfaces, fragment)
          ),
          content: goldPatch.bytes,
          fragments: goldCandidateLines.filter((fragment) =>
            !containsNormalizedInSurfaces(publicNaturalSurfaces, fragment)
          ),
          id: "gold-patches",
        },
        {
          allowedPublicFragments: hiddenSourceCandidateLines.filter(
            (fragment) =>
              containsNormalizedInSurfaces(publicNaturalSurfaces, fragment),
          ).concat(declaredAllowedValues.map(String)),
          content: hiddenSourceContent,
          fragments: hiddenSourceCandidateLines.filter((fragment) =>
            !containsNormalizedInSurfaces(publicNaturalSurfaces, fragment)
          ),
          hiddenValueRelations,
          hiddenValues,
          id: "hidden-test-source",
        },
      ];
      const matrix = auditC4SurfaceHiddenArtifactMatrix({
        artifacts,
        surfaces,
      });
      if (matrix.status !== "accepted") {
        const first = matrix.cells.find((cell) =>
          cell.status === "rejected"
        );
        throw new Error(
          `C4 leakage audit failed for ${episode.id}/${stage.id}` +
            (first === undefined
              ? ""
              : ` at ${first.surfaceId}/${first.artifactId}`),
        );
      }
      const mutation = mutationTestC4SurfaceHiddenArtifactMatrix({
        artifacts,
        surfaces,
      });
      stageMatrices.push({
        auditSha256: matrix.auditSha256,
        cells: matrix.cells,
        episodeId: episode.id,
        mutationAuditSha256: mutation.auditSha256,
        mutationCells: mutation.cells,
        stageId: stage.id,
      });
    }
  }
  const auditBasis = {
    auditedHiddenArtifacts: [...C4_HIDDEN_ARTIFACT_IDS],
    auditedSurfaces: [...C4_LEAKAGE_SURFACE_IDS],
    candidateBindingVersion: 1,
    candidateExtractionVersion:
      "semantic-documents-exact-relations-corpus-wide-v9",
    c5LiveReauditSurfaces: [
      "effective-codex-input-after-seeding",
      "flat-summary-after-seeding",
      "goodmemory-export-after-seeding",
      "goodmemory-hook-context-after-seeding",
    ],
    deferredC5Surfaces: [
      "effective-codex-input-after-seeding",
      "flat-summary-after-seeding",
      "goodmemory-export-after-seeding",
      "goodmemory-hook-context-after-seeding",
    ],
    directFrozenSurfaces: [
      "allowed-feedback",
      "frozen-prehistory",
      "repository-instructions",
      "stage-prompts",
      "visible-repository-files",
    ],
    matrixCellCount: stageMatrices.reduce(
      (total, stage) => total + stage.cells.length,
      0,
    ),
    mutationApplicableCellCount: stageMatrices.reduce(
      (total, stage) =>
        total + stage.mutationCells.filter((cell) =>
          cell.applicability === "applicable"
        ).length,
      0,
    ),
    mutationCellCount: stageMatrices.reduce(
      (total, stage) => total + stage.mutationCells.length,
      0,
    ),
    mutationNotApplicableCellCount: stageMatrices.reduce(
      (total, stage) =>
        total + stage.mutationCells.filter((cell) =>
          cell.applicability === "not-applicable-no-secret-candidate"
        ).length,
      0,
    ),
    normalizationVersion: "nfkc-lowercase-whitespace-numeric-equivalence-v4",
    overlapCount: 0,
    runtimeSurfacePolicy:
      "content-preserving-projection-plus-C5-live-reaudit",
    stageMatrices,
    status: "accepted",
  } as const;
  return {
    auditSha256: sha256(JSON.stringify(auditBasis)),
    auditedHiddenArtifacts: [...auditBasis.auditedHiddenArtifacts],
    auditedSurfaces: [...auditBasis.auditedSurfaces],
    candidateBindingVersion: auditBasis.candidateBindingVersion,
    candidateExtractionVersion: auditBasis.candidateExtractionVersion,
    c5LiveReauditSurfaces: [...auditBasis.c5LiveReauditSurfaces],
    deferredC5Surfaces: [...auditBasis.deferredC5Surfaces],
    directFrozenSurfaces: [...auditBasis.directFrozenSurfaces],
    episodeCount: dataset.episodes.length,
    stageCount: stageMatrices.length,
    stageMatrices,
    matrixCellCount: auditBasis.matrixCellCount,
    mutationApplicableCellCount: auditBasis.mutationApplicableCellCount,
    mutationCellCount: auditBasis.mutationCellCount,
    mutationNotApplicableCellCount:
      auditBasis.mutationNotApplicableCellCount,
    normalizationVersion: auditBasis.normalizationVersion,
    overlapCount: 0,
    runtimeSurfacePolicy: auditBasis.runtimeSurfacePolicy,
    status: "accepted",
  };
}

async function collectC4RepositorySurfaceFiles(
  repositoryRoot: string,
  directory = repositoryRoot,
): Promise<Array<{ content: string; path: string }>> {
  const files: Array<{ content: string; path: string }> = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === ".git") {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error("C4 visible repository surface rejects symlinks");
    }
    if (entry.isDirectory()) {
      files.push(...await collectC4RepositorySurfaceFiles(
        repositoryRoot,
        path,
      ));
      continue;
    }
    if (!entry.isFile()) {
      throw new Error("C4 visible repository surface rejects non-files");
    }
    files.push({
      content: await readFile(path, "utf8"),
      path: relative(repositoryRoot, path).split(sep).join("/"),
    });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function verifyLicenses(
  datasetRoot: string,
  dataset: CodexCodingEffectDatasetV2,
): Promise<C4DatasetCoreReadiness["licenses"]> {
  const receiptBytes = await readFile(
    join(datasetRoot, "licenses", "receipt.json"),
    "utf8",
  );
  const parsed = licenseReceiptSchema.safeParse(JSON.parse(receiptBytes) as unknown);
  if (!parsed.success) {
    throw new Error("invalid C4 raw source license receipt");
  }
  const receipt = parsed.data;
  if (sha256(await readFile(join(datasetRoot, receipt.datasetLicensePath))) !==
    receipt.datasetLicenseSha256) {
    throw new Error("C4 dataset license hash mismatch");
  }
  const expectedUrls = new Set(dataset.episodes.map((episode) =>
    episode.repository.url
  ));
  for (const repository of receipt.repositories) {
    if (!expectedUrls.delete(repository.sourceUrl)) {
      throw new Error(`C4 license receipt has unexpected repository ${repository.sourceUrl}`);
    }
    if (
      repository.repositoryId !==
        controlledRepositoryIdForUrl(repository.sourceUrl)
    ) {
      throw new Error(
        `C4 license receipt repository id mismatch for ${repository.sourceUrl}`,
      );
    }
    if (sha256(await readFile(join(datasetRoot, repository.licensePath))) !==
      repository.licenseSha256) {
      throw new Error(`C4 source license hash mismatch for ${repository.repositoryId}`);
    }
  }
  if (expectedUrls.size > 0) {
    throw new Error("C4 license receipt is missing a source repository");
  }
  return {
    receiptSha256: sha256(receiptBytes),
    repositoryLicenseCount: receipt.repositories.length,
    status: "accepted",
  };
}

export async function captureC4GoldReplay(
  repositoryRoot: string,
  expectedChangedFiles: readonly string[],
): Promise<string> {
  await git(repositoryRoot, [
    "add",
    "--all",
    "--",
    ...expectedChangedFiles,
  ]);
  return gitRaw(repositoryRoot, [
    "diff",
    "--cached",
    "--binary",
    "--full-index",
    "HEAD",
    "--",
    ...expectedChangedFiles,
  ]);
}

export async function captureC4ChangedFiles(
  repositoryRoot: string,
): Promise<string[]> {
  const [tracked, untracked] = await Promise.all([
    gitRaw(repositoryRoot, ["diff", "--name-only", "-z"]),
    gitRaw(repositoryRoot, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]),
  ]);
  return [...new Set([
    ...tracked.split("\0"),
    ...untracked.split("\0"),
  ].filter((value) => value.length > 0))].sort();
}

async function verifyAuthorAttestation(
  datasetRoot: string,
  dataset: CodexCodingEffectDatasetV2,
): Promise<C4DatasetCoreReadiness["authorAttestation"]> {
  const bytes = await readFile(
    join(datasetRoot, "provenance", "author-attestation.json"),
    "utf8",
  );
  const parsed = authorAttestationSchema.safeParse(JSON.parse(bytes) as unknown);
  if (!parsed.success) {
    throw new Error("invalid C4 dataset-author attestation");
  }
  const profile = resolveControlledDatasetProfile(dataset.datasetId);
  if (
    parsed.data.datasetId !== dataset.datasetId ||
    parsed.data.scope !== profile.attestationScope ||
    (parsed.data.priorV1BaselineCeiling !== undefined) !==
      profile.attestationCarriesPriorV1BaselineCeiling
  ) {
    throw new Error("invalid C4 dataset-author attestation");
  }
  const authors = new Set(dataset.episodes.map((episode) => episode.author));
  if (authors.size !== 1 || !authors.has(parsed.data.author)) {
    throw new Error("C4 dataset-author attestation does not cover every episode");
  }
  return {
    authorTaskName: parsed.data.authorTaskName,
    sha256: sha256(bytes),
    status: "accepted",
  };
}

function meaningfulAddedLines(patch: string): string[] {
  return semanticArtifactCandidates(patch.split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1)));
}

function parseJsonBytes(bytes: string, label: string): unknown {
  try {
    return JSON.parse(bytes) as unknown;
  } catch {
    throw new Error(`invalid C4 ${label} JSON`);
  }
}

function hiddenStageMetadataFragments(testCase: {
  hiddenSentinel: string;
}): string[] {
  return [
    testCase.hiddenSentinel,
  ];
}

function meaningfulSourceLines(source: string): string[] {
  return semanticArtifactCandidates(source.split(/\r?\n/u));
}

function semanticArtifactCandidates(lines: readonly string[]): string[] {
  const semanticLines = lines
    .map((line) => line.trim())
    .filter(isSemanticLeakageCandidate);
  const candidates: string[] = [];
  for (const [index, line] of semanticLines.entries()) {
    if (normalizeLeakageText(line).length >= 8) {
      candidates.push(line);
      continue;
    }
    candidates.push(...shortCodeTokens(line));
    const previous = semanticLines[index - 1];
    const next = semanticLines[index + 1];
    if (previous !== undefined) {
      candidates.push(`${previous}\n${line}`);
    }
    if (next !== undefined) {
      candidates.push(`${line}\n${next}`);
    }
  }
  return [...new Set(candidates)];
}

function shortCodeTokens(line: string): string[] {
  return (line.match(
    /[?.:]?\s*[\p{L}_][\p{L}\p{N}_]*(?:\(\))?/gu,
  ) ?? [])
    .map((token) => token.trim())
    .filter((token) =>
      normalizeLeakageText(token).length >= 4 &&
      /[?.:()]/u.test(token)
    );
}

function isSemanticLeakageCandidate(line: string): boolean {
  return line.length > 0 &&
    !line.startsWith("import ") &&
    /[\p{L}\p{N}_]/u.test(line);
}

function collectHiddenValues(value: unknown): C4HiddenValue[] {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(collectHiddenValues);
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).flatMap(collectHiddenValues);
  }
  return [];
}

function uniqueHiddenValues(
  values: readonly C4HiddenValue[],
): C4HiddenValue[] {
  return [...new Map(values.map((value) => [
    hiddenValueKey(value),
    value,
  ])).values()];
}

function hiddenCaseRelations(hiddenCase: {
  args: unknown;
  expected: unknown;
}): C4HiddenValue[][] {
  const arguments_ = uniqueHiddenValues(collectHiddenValues(hiddenCase.args));
  const expected = uniqueHiddenValues(collectHiddenValues(hiddenCase.expected));
  return arguments_.flatMap((argument) =>
    expected
      .filter((value) => hiddenValueKey(value) !== hiddenValueKey(argument))
      .map((value) => [argument, value])
  );
}

function uniqueHiddenValueRelations(
  relations: readonly (readonly C4HiddenValue[])[],
): C4HiddenValue[][] {
  return [...new Map(relations.map((relation) => [
    hiddenValueRelationKey(relation),
    [...relation],
  ])).entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, relation]) => relation);
}

function hiddenValueRelationKey(
  relation: readonly C4HiddenValue[],
): string {
  return JSON.stringify(relation.map(hiddenValueKey));
}

function hiddenValueKey(value: C4HiddenValue): string {
  return JSON.stringify({
    type: value === null ? "null" : typeof value,
    value,
  });
}

function normalizeLeakageText(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

function containsNormalized(surface: string, fragment: string): boolean {
  const normalized = normalizeLeakageText(fragment);
  return normalized.length > 0 &&
    normalizeLeakageText(surface).includes(normalized);
}

function containsNormalizedInSurfaces(
  surfaces: readonly string[],
  fragment: string,
): boolean {
  return surfaces.some((surface) => containsNormalized(surface, fragment));
}

// The review's per-episode memory mode. Uniform profiles (C4) carry one
// later-stage mode; declared-per-stage profiles (Level-2) are reviewed by
// their final stage, the stage whose memory expectation defines the episode.
function c4EpisodeMemoryExpectationMode(
  episode: CodexCodingEffectDatasetV2["episodes"][number],
  profile: ControlledDatasetProfile,
): "irrelevant-control" | "none" | "required" {
  if (profile.laterStagePolicy === "declared-per-stage") {
    const finalStage = episode.stages.at(-1);
    if (finalStage === undefined || finalStage.position === 1) {
      throw new Error(`C4 episode ${episode.id} has no later-stage memory mode`);
    }
    return finalStage.memoryExpectation.mode;
  }
  const modes = new Set(episode.stages
    .filter((stage) => stage.position > 1)
    .map((stage) => stage.memoryExpectation.mode));
  if (modes.size !== 1) {
    throw new Error(`C4 episode ${episode.id} has inconsistent memory modes`);
  }
  const [mode] = modes;
  if (mode !== "required" && mode !== "irrelevant-control") {
    throw new Error(`C4 episode ${episode.id} has no later-stage memory mode`);
  }
  return mode;
}

function expectedFailureFingerprint(episodeId: string, stageId: string): string {
  return `C4_F2P|${episodeId}|${stageId}|case-1`;
}

function assertPassed(
  result: EvaluatorTestResult,
  label: string,
  input: { episode: CodexCodingEffectEpisode; stage: { id: string } },
): void {
  if (result.status !== "passed") {
    throw new Error(
      `C4 ${label} failed for ${input.episode.id}/${input.stage.id}: ${testSummary(result)}`,
    );
  }
}

function testSummary(result: EvaluatorTestResult): string {
  const output = `${result.stdout}\n${result.stderr}`.trim().slice(0, 800);
  return `status=${result.status} exit=${String(result.exitCode)} output=${output}`;
}

async function gitApply(cwd: string, patchPath: string): Promise<void> {
  const result = await runBoundaryProcess({
    args: ["apply", "--binary", "--whitespace=nowarn", "--", patchPath],
    cwd,
    executable: "git",
    timeoutMs: 30_000,
  });
  if (result.spawnError !== undefined || result.timedOut || result.exitCode !== 0) {
    throw new Error(`C4 gold patch failed to apply: ${result.stderr.trim()}`);
  }
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await runBoundaryProcess({
    args,
    cwd,
    executable: "git",
    timeoutMs: 30_000,
  });
  if (result.spawnError !== undefined || result.timedOut || result.exitCode !== 0) {
    throw new Error(`C4 git ${args[0] ?? "command"} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

async function gitRaw(cwd: string, args: readonly string[]): Promise<string> {
  const result = await runBoundaryProcess({
    args,
    cwd,
    executable: "git",
    timeoutMs: 30_000,
  });
  if (result.spawnError !== undefined || result.timedOut || result.exitCode !== 0) {
    throw new Error(`C4 git ${args[0] ?? "command"} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

async function logEvent(
  path: string,
  event: string,
  data: Record<string, unknown>,
): Promise<void> {
  await appendFile(path, `${JSON.stringify({ data, event })}\n`, "utf8");
}

function pathsOverlap(firstPath: string, secondPath: string): boolean {
  return pathInsideOrEqual(firstPath, secondPath) ||
    pathInsideOrEqual(secondPath, firstPath);
}

function pathInsideOrEqual(parent: string, candidate: string): boolean {
  const child = relative(resolve(parent), resolve(candidate));
  return child === "" ||
    (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

async function assertAbsent(path: string, label: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
  throw new Error(`${label} already exists: ${path}`);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
