import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildC4BaselineStageEvidenceBindings,
  buildC4BaselineCeilingTargets,
  reconstructC4BaselineFrozenStageBindings,
  runC4AdaptiveBaselineCeiling,
  serializeC4BaselineCeilingReport,
} from "../../scripts/codex-coding-effect/c4-baseline-ceiling";
import type {
  C4BaselineFrozenStageBinding,
  C4BaselineRunIdentity,
  C4BaselineStageResult,
} from "../../scripts/codex-coding-effect/c4-baseline-ceiling";
import {
  buildC4AssetLock,
  loadC4AssetLock,
} from "../../scripts/codex-coding-effect/c4-controlled-dataset";
import type {
  C4IndependentDatasetReview,
} from "../../scripts/codex-coding-effect/c4-contracts";
import {
  finalizeC4DatasetReadiness,
  runC4DatasetCoreReadiness,
} from "../../scripts/codex-coding-effect/c4-readiness";
import {
  buildC4IndependentReviewDispatch,
  buildC4IndependentReviewProvenance,
  buildC4IndependentReviewSpawnMessage,
  buildC4ReviewInputBundle,
  buildC4ReviewRequest,
  serializeC4ReviewArtifact,
} from "../../scripts/codex-coding-effect/c4-review-artifacts";
import { loadCodexCodingEffectDataset } from "../../scripts/codex-coding-effect/dataset";

const DATASET_ROOT = "fixtures/codex-coding-effect/c4-controlled-pilot";

export interface AcceptedC4ReadinessFixturePaths {
  baselineReportPath: string;
  baselineRawStageEvidenceRoot: string;
  baselineStageEvidenceRoot: string;
  c4ReadinessCorePath: string;
  c4ReadinessReportPath: string;
  c4ReadinessWorkspaceRoot: string;
  c4ReviewDispatchPath: string;
  c4ReviewInputBundlePath: string;
  c4ReviewProvenancePath: string;
  c4ReviewRequestPath: string;
  c4ReviewResponsePath: string;
}

export interface AcceptedC4ReadinessFixture {
  firstStageEvidencePath: string;
  paths: AcceptedC4ReadinessFixturePaths;
}

export async function withAcceptedC4ReadinessFixture<Result>(
  run: (fixture: AcceptedC4ReadinessFixture) => Promise<Result>,
): Promise<Result> {
  const root = await mkdtemp(join(tmpdir(), "goodmemory-c5-readiness-"));
  const baselineReportPath = join(root, "baseline", "report.json");
  const baselineRawStageEvidenceRoot = join(root, "baseline", "raw-stages");
  const baselineStageEvidenceRoot = join(root, "baseline", "stages");
  const c4ReadinessCorePath = join(root, "c4-readiness-core.json");
  const c4ReadinessReportPath = join(root, "c4-readiness.json");
  const c4ReadinessWorkspaceRoot = join(root, "c4-readiness-verification");
  const c4ReviewDispatchPath = join(root, "review", "dispatch.json");
  const c4ReviewInputBundlePath = join(root, "review", "input-bundle.json");
  const c4ReviewProvenancePath = join(root, "review", "provenance.json");
  const c4ReviewRequestPath = join(root, "review", "request.md");
  const c4ReviewResponsePath = join(root, "review", "independent-review.json");
  try {
    const [loaded, storedAssetLock, currentAssetLock] = await Promise.all([
      loadCodexCodingEffectDataset(DATASET_ROOT),
      loadC4AssetLock(DATASET_ROOT),
      buildC4AssetLock(DATASET_ROOT),
    ]);
    if (
      JSON.stringify(storedAssetLock.assetLock) !==
        JSON.stringify(currentAssetLock)
    ) {
      throw new Error("test requires a current C4 asset lock");
    }
    const coreResult = await runC4DatasetCoreReadiness({
      datasetRoot: DATASET_ROOT,
      workspaceRoot: join(root, "c4-readiness-fixture"),
    });
    const identity: C4BaselineRunIdentity = {
      assetLockSha256: storedAssetLock.assetLockSha256,
      assetRootSha256: currentAssetLock.assetRootSha256,
      claimBoundary: "diagnostic-no-memory-ceiling-only",
      codexExecutableSha256: "a".repeat(64),
      codexVersion: "codex-cli test",
      datasetSnapshotMode: "asset-locked-copy",
      datasetId: loaded.dataset.datasetId,
      generatedAt: "2026-07-16T00:00:00.000Z",
      host: "codex",
      manifestSha256: loaded.manifestSha256,
      model: "test-model",
      networkAccess: false,
      publicClaimEligible: false,
      reasoningEffort: "test",
      runId: "c4-accepted-test-fixture",
      schemaVersion: 2,
      stageTimeoutMs: 1,
      strategy: "stage-3-first-then-stage-2-if-needed",
      testTimeoutMs: 1,
    };
    const frozenBindings = await reconstructC4BaselineFrozenStageBindings({
      dataset: loaded.dataset,
      datasetRoot: DATASET_ROOT,
    });
    const baseline = await runC4AdaptiveBaselineCeiling({
      executeStage: async (target): Promise<C4BaselineStageResult> => {
        const result = {
          changedFiles: [],
          codexStatus: "completed" as const,
          disposition: "finalized" as const,
          episodeId: target.episodeId,
          executionFailureStage: null,
          failToPassStatus: "failed" as const,
          passToPassStatus: "passed" as const,
          patchSha256: null,
          resolved: false,
          stageId: target.stageId,
          stageInputSha256: target.stageInputSha256,
          taskFailureReasons: ["no-patch", "hidden-fail-to-pass-failed"],
          threadId: `thread-${target.episodeId}-${target.stageId}`,
        };
        return {
          ...result,
          stageEvidenceSha256: sha256(rawStageEvidenceBytes(
            result,
            requiredFrozenBinding(
              frozenBindings,
              target.episodeId,
              target.stageId,
            ),
          )),
        };
      },
      runIdentity: identity,
      targets: buildC4BaselineCeilingTargets(loaded.dataset),
    });
    const baselineBytes = serializeC4BaselineCeilingReport(baseline);
    await Promise.all([
      mkdir(baselineRawStageEvidenceRoot, { recursive: true }),
      mkdir(baselineStageEvidenceRoot, { recursive: true }),
    ]);
    await writeFile(baselineReportPath, baselineBytes, "utf8");
    const rawFiles = baseline.results.map((result) => {
      const { stageEvidenceSha256: _, ...evidenceResult } = result;
      return {
        bytes: rawStageEvidenceBytes(
          evidenceResult,
          requiredFrozenBinding(
            frozenBindings,
            result.episodeId,
            result.stageId,
          ),
        ),
        path: `${result.episodeId}-${result.stageId}/stage-evidence.json`,
      };
    });
    const projectedFiles = buildC4BaselineStageEvidenceBindings(
      baseline,
      rawFiles,
      frozenBindings,
    );
    const reviewArtifacts = buildAcceptedReviewArtifacts(coreResult);
    const finalizedReadiness = finalizeC4DatasetReadiness({
      baselineBytes,
      baselinePath: baselineReportPath,
      baselineStageEvidenceFiles: projectedFiles,
      result: coreResult,
      ...reviewArtifacts,
    });
    for (const [rootPath, files] of [
      [baselineRawStageEvidenceRoot, rawFiles],
      [baselineStageEvidenceRoot, projectedFiles],
    ] as const) {
      for (const file of files) {
        const directory = join(rootPath, file.path.split("/")[0]!);
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, "stage-evidence.json"), file.bytes, "utf8");
      }
    }
    await mkdir(join(root, "review"), { recursive: true });
    await Promise.all([
      writeFile(c4ReadinessCorePath, coreResult.coreBytes, "utf8"),
      writeFile(
        c4ReadinessReportPath,
        finalizedReadiness.reportBytes,
        "utf8",
      ),
      writeFile(
        c4ReviewDispatchPath,
        reviewArtifacts.dispatchBytes,
        "utf8",
      ),
      writeFile(
        c4ReviewInputBundlePath,
        reviewArtifacts.inputBundleBytes,
        "utf8",
      ),
      writeFile(
        c4ReviewProvenancePath,
        reviewArtifacts.provenanceBytes,
        "utf8",
      ),
      writeFile(c4ReviewRequestPath, reviewArtifacts.requestBytes, "utf8"),
      writeFile(c4ReviewResponsePath, reviewArtifacts.reviewBytes, "utf8"),
    ]);

    return await run({
      firstStageEvidencePath: join(
        baselineStageEvidenceRoot,
        projectedFiles[0]!.path,
      ),
      paths: {
        baselineReportPath,
        baselineRawStageEvidenceRoot,
        baselineStageEvidenceRoot,
        c4ReadinessCorePath,
        c4ReadinessReportPath,
        c4ReadinessWorkspaceRoot,
        c4ReviewDispatchPath,
        c4ReviewInputBundlePath,
        c4ReviewProvenancePath,
        c4ReviewRequestPath,
        c4ReviewResponsePath,
      },
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

function buildAcceptedReviewArtifacts(
  result: Awaited<ReturnType<typeof runC4DatasetCoreReadiness>>,
): {
  dispatchBytes: string;
  inputBundleBytes: string;
  provenanceBytes: string;
  requestBytes: string;
  reviewBytes: string;
} {
  const inputBundleBytes = serializeC4ReviewArtifact(
    buildC4ReviewInputBundle({
      assetFiles: result.core.assetFiles,
      assetLockSha256: result.core.assetLockSha256,
      assetRootSha256: result.core.assetRootSha256,
      createdAt: "2026-07-15T19:59:00.000Z",
      leakageAuditSha256: result.core.leakage.auditSha256,
      manifestSha256: result.core.manifestSha256,
      readinessCoreSha256: result.coreSha256,
    }),
  );
  const review: C4IndependentDatasetReview = {
    assetLockSha256: result.core.assetLockSha256,
    assetRootSha256: result.core.assetRootSha256,
    c4AbResultsInspected: false,
    codingOutcomeArtifactsInspected: false,
    datasetId: result.core.datasetId,
    episodeReviews: result.core.episodes.map((episode) =>
      episode.memoryExpectationMode === "irrelevant-control"
        ? {
            author: episode.author,
            checks: {
              codingNotTrivia: true,
              hiddenTestsFair: true,
              memoryIrrelevantAndNonMisleading: true,
              negativeControlCredible: true,
              noRepositorySpecificRunnerException: true,
            },
            episodeId: episode.id,
            memoryExpectationMode: "irrelevant-control" as const,
            rationale:
              "Independent review confirmed the unrelated memory is non-misleading.",
          }
        : {
            author: episode.author,
            checks: {
              codingNotTrivia: true,
              hiddenTestsFair: true,
              memoryUsefulNotAnswer: true,
              negativeControlCredible: true,
              noRepositorySpecificRunnerException: true,
            },
            episodeId: episode.id,
            memoryExpectationMode: "required" as const,
            rationale:
              "Independent review accepted the task and evaluator boundary.",
          }
    ),
    inputBundleSha256: sha256(inputBundleBytes),
    leakageAuditSha256: result.core.leakage.auditSha256,
    manifestSha256: result.core.manifestSha256,
    publicCodingEffectProof: false,
    readinessCoreSha256: result.coreSha256,
    reviewedAt: "2026-07-15T20:00:00.000Z",
    reviewer: "Codex C4 independent reviewer",
    reviewerTaskName: "/root/c4_final_independent_review_v5",
    schemaVersion: 2,
    scope: "dataset-only-no-coding-outcomes",
    status: "accepted",
  };
  const reviewBytes = serializeC4ReviewArtifact(review);
  const requestBytes = buildC4ReviewRequest({
    inputBundleSha256: sha256(inputBundleBytes),
  });
  const dispatchBytes = serializeC4ReviewArtifact(
    buildC4IndependentReviewDispatch({
      spawnMessage: buildC4IndependentReviewSpawnMessage(),
    }),
  );
  const provenanceBytes = serializeC4ReviewArtifact(
    buildC4IndependentReviewProvenance({
      authorTaskName: result.core.authorAttestation.authorTaskName,
      dispatchBytes,
      inputBundleBytes,
      recordedAt: "2026-07-15T20:01:00.000Z",
      requestBytes,
      responseBytes: reviewBytes,
      reviewerAgentName: "/root/c4_final_independent_review_v5",
    }),
  );
  return {
    dispatchBytes,
    inputBundleBytes,
    provenanceBytes,
    requestBytes,
    reviewBytes,
  };
}

function rawStageEvidenceBytes(
  result: Omit<C4BaselineStageResult, "stageEvidenceSha256">,
  binding: C4BaselineFrozenStageBinding,
): string {
  return `${JSON.stringify({
    arm: {
      absenceAudit: { passed: true },
      codexExecutableSha256: "a".repeat(64),
      codexVersion: "codex-cli test",
      instructionSha256: "8".repeat(64),
      networkAccess: false,
      permissionIsolation: {
        audit: { passed: true },
        evidenceSha256: "9".repeat(64),
      },
    },
    codex: {
      durationMs: 1,
      eventCount: 1,
      exitCode: 0,
      failureEvents: [],
      status: result.codexStatus,
      stderr: "",
      timedOut: false,
      usage: null,
    },
    dataset: {
      episodeId: result.episodeId,
      promptSha256: binding.promptSha256,
      repositoryCommit: binding.repositoryCommit,
      repositoryTree: binding.repositoryTree,
      snapshot: binding.repositoryCommit,
      stageId: result.stageId,
      stageInputSha256: result.stageInputSha256,
    },
    evaluator: {
      commitments: binding.evaluatorCommitments,
      credentialsRemovedBeforeMaterialization: true,
      failToPass: {
        durationMs: 1,
        exitCode: 1,
        kind: "fail-to-pass",
        status: result.failToPassStatus,
        stderr: "",
        stdout: "",
      },
      materializedAfterCodexExit: true,
      passToPass: {
        durationMs: 1,
        exitCode: 0,
        kind: "pass-to-pass",
        status: result.passToPassStatus,
        stderr: "",
        stdout: "",
      },
      sandbox: {
        configSha256: "6".repeat(64),
        configWriteDenied: true,
        copiedAuthRemovedBeforeEvaluator: true,
        evaluatorRead: true,
        evaluatorWriteDenied: true,
        networkAccess: false,
        networkDenied: true,
        networkPositiveControl: true,
        originalAuthAliasDenied: true,
        originalAuthDenied: true,
        profileName: "c4-evaluator",
        schemaVersion: 1,
        workspaceRead: true,
        workspaceWrite: true,
      },
    },
    patch: {
      baseCommit: binding.repositoryCommit,
      changedFiles: result.changedFiles,
      diff: "",
      forbiddenFiles: [],
      hasPatch: false,
      sha256: result.patchSha256,
      untrackedFiles: [],
    },
    result,
    schemaVersion: 1,
    visibleBaseHealth: {
      durationMs: 1,
      exitCode: 0,
      passed: true,
      status: "passed",
      stderr: "",
      stdout: "",
    },
  }, null, 2)}\n`;
}

function requiredFrozenBinding(
  bindings: readonly C4BaselineFrozenStageBinding[],
  episodeId: string,
  stageId: string,
): C4BaselineFrozenStageBinding {
  const binding = bindings.find((candidate) =>
    candidate.episodeId === episodeId && candidate.stageId === stageId
  );
  if (binding === undefined) {
    throw new Error(`missing frozen binding for ${episodeId}/${stageId}`);
  }
  return binding;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
