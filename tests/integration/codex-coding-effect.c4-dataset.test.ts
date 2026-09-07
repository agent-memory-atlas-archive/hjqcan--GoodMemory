import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildC4AssetLock,
  c4RepositoryIdForUrl,
  cleanupC4ControlledPilotDataset,
  materializeC4SourceRepository,
  prepareC4ControlledPilotDataset,
  serializeC4AssetLock,
} from "../../scripts/codex-coding-effect/c4-controlled-dataset";
import type { C4IndependentDatasetReview } from "../../scripts/codex-coding-effect/c4-contracts";
import {
  buildC4BaselineStageEvidenceBindings,
  runC4AdaptiveBaselineCeiling,
  serializeC4BaselineCeilingReport,
} from "../../scripts/codex-coding-effect/c4-baseline-ceiling";
import type {
  C4BaselineCeilingReport,
  C4BaselineCeilingTarget,
  C4BaselineFrozenStageBinding,
  C4BaselineStageEvidenceFile,
  C4BaselineStageResult,
} from "../../scripts/codex-coding-effect/c4-baseline-ceiling";
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

describe("Codex coding-effect C4 controlled dataset", () => {
  it("materializes and verifies six three-stage episodes without live Codex", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "goodmemory-c4-dataset-"));
    const fixture = await prepareC4ControlledPilotDataset({
      root: join(sandbox, "dataset"),
    });
    try {
      expect(fixture.dataset.schemaVersion).toBe(2);
      expect(fixture.dataset.episodes).toHaveLength(6);
      expect(fixture.dataset.episodes.flatMap((episode) => episode.stages))
        .toHaveLength(18);
      expect(new Set(
        fixture.dataset.episodes.map((episode) => episode.repository.url),
      ).size).toBe(2);
      expect(fixture.assetLock.files.some((file) =>
        file.path === "manifest.json"
      )).toBe(true);
      expect(fixture.assetLock.files.some((file) =>
        file.path === "provenance/author-attestation.json"
      )).toBe(true);
      expect(fixture.assetLock.files.filter((file) =>
        file.path.startsWith("evaluator/gold/")
      )).toHaveLength(18);
      const sourceBytes = await readFile(
        join(fixture.root, "repositories/continuity-utils/src/tasks.ts"),
        "utf8",
      );
      expect(sourceBytes.endsWith("\n")).toBe(true);
      expect(sourceBytes.endsWith("\n\n")).toBe(false);

      const result = await runC4DatasetCoreReadiness({
        datasetRoot: fixture.root,
        workspaceRoot: join(sandbox, "readiness"),
      });

      expect(result.core.status).toBe("accepted");
      expect(result.coreBytes).not.toContain(sandbox);
      expect(result.core.counts).toEqual({
        baseProbes: 54,
        episodes: 6,
        repositories: 2,
        stages: 18,
      });
      expect(result.core.stages).toHaveLength(18);
      expect(result.core.stages.every((stage) =>
        stage.baseProbeStable &&
        stage.baseProbes.length === 3 &&
        stage.goldPassed
      )).toBe(true);
      expect(result.core.leakage.status).toBe("accepted");
      expect(result.core.leakage.candidateExtractionVersion).toBe(
        "semantic-documents-exact-relations-corpus-wide-v9",
      );
      expect(result.core.leakage.matrixCellCount).toBe(486);
      expect(result.core.leakage.mutationApplicableCellCount).toBe(648);
      expect(result.core.leakage.mutationCellCount).toBe(1458);
      expect(result.core.leakage.mutationNotApplicableCellCount).toBe(810);
      expect(result.core.leakage.stageCount).toBe(18);
      expect(result.core.leakage.stageMatrices.every((stage) =>
        stage.cells.length === 27 &&
        stage.mutationCells.length === 81
      )).toBe(true);
      expect(result.core.leakage.c5LiveReauditSurfaces).toEqual([
        "effective-codex-input-after-seeding",
        "flat-summary-after-seeding",
        "goodmemory-export-after-seeding",
        "goodmemory-hook-context-after-seeding",
      ]);
      expect(result.core.leakage.deferredC5Surfaces).toEqual(
        result.core.leakage.c5LiveReauditSurfaces,
      );
      expect([
        ...result.core.leakage.directFrozenSurfaces,
        ...result.core.leakage.deferredC5Surfaces,
      ].map(String).sort()).toEqual(
        [...result.core.leakage.auditedSurfaces].sort(),
      );
      expect(result.core.licenses.status).toBe("accepted");
      expect(result.core.authorAttestation).toMatchObject({
        authorTaskName: "/root",
        status: "accepted",
      });
      expect(result.core.host).toBe("codex");
      expect(result.core.excludedHosts).toEqual(["claude-code"]);
      expect(result.core.readmeRowAllowed).toBe(false);
      expect(result.core.publicClaimEligible).toBe(false);
      expect(result.core.publicCodingEffectProof).toBe(false);
      expect(result.core.episodes).toContainEqual({
        author: "GoodMemory C4 dataset author",
        id: "independent-string-utilities",
        memoryExpectationMode: "irrelevant-control",
      });

      const review = independentReviewArtifacts(
        result,
        fixture.dataset.episodes,
        fixture.assetLock.files.map((file) => ({
          path: file.path,
          sha256: file.sha256,
        })),
      );
      const baselineBytes = await baselineCeilingBytes(result, "proceed");
      const baselineStageEvidenceFiles =
        baselineEvidenceFiles(baselineBytes, result);
      const final = finalizeC4DatasetReadiness({
        baselineBytes,
        baselineStageEvidenceFiles,
        result,
        ...review,
      });
      expect(final.report).toMatchObject({
        authorTaskName: "/root",
        baselineCeiling: {
          ceilingRisk: false,
          decision: "proceed-to-c5-pilot",
          infrastructureFailureCount: 0,
        },
        claimBoundary: "dataset-readiness-only-no-coding-uplift",
        nextEvidencePhase: "C5-native-longitudinal-pilot",
        publicClaimEligible: false,
        publicCodingEffectProof: false,
        reviewContextPolicy: "fork-turns-none",
        reviewerAgentName: "/root/c4_final_independent_review_v5",
        reviewerIdentityEvidence:
          "orchestrator-attestation-not-cryptographic-receipt",
        reviewerType: "independent-ai-agent",
        schemaVersion: 3,
        status: "accepted",
      });
      expect(final.report.baselineCeiling.reportSha256).toBe(
        sha256(baselineBytes),
      );
      expect(final.report.reviewSha256).toHaveLength(64);
      const mismatchedModeReview = JSON.parse(
        review.reviewBytes,
      ) as C4IndependentDatasetReview;
      mismatchedModeReview.episodeReviews =
        mismatchedModeReview.episodeReviews.map((episode) =>
          episode.episodeId === "independent-string-utilities"
            ? {
                author: episode.author,
                checks: {
                  codingNotTrivia: true,
                  hiddenTestsFair: true,
                  memoryUsefulNotAnswer: true,
                  negativeControlCredible: true,
                  noRepositorySpecificRunnerException: true,
                },
                episodeId: episode.episodeId,
                memoryExpectationMode: "required",
                rationale: episode.rationale,
              }
            : episode
        );
      const mismatchedModeReviewBytes =
        `${JSON.stringify(mismatchedModeReview, null, 2)}\n`;
      expect(() => finalizeC4DatasetReadiness({
        baselineBytes,
        baselineStageEvidenceFiles,
        result,
        ...review,
        provenanceBytes: review.provenanceBytes.replace(
          sha256(review.reviewBytes),
          sha256(mismatchedModeReviewBytes),
        ),
        reviewBytes: mismatchedModeReviewBytes,
      })).toThrow("C4 independent review episode coverage mismatch");
      expect(() => finalizeC4DatasetReadiness({
        baselineBytes,
        baselineStageEvidenceFiles,
        result,
        ...review,
        reviewBytes: `${JSON.stringify({
          ...JSON.parse(review.reviewBytes) as C4IndependentDatasetReview,
          readinessCoreSha256: "f".repeat(64),
        }, null, 2)}\n`,
      })).toThrow("C4 independent review response hash mismatch");
      expect(() => finalizeC4DatasetReadiness({
        baselineBytes,
        baselineStageEvidenceFiles,
        result,
        ...review,
        requestBytes: `${review.requestBytes}drift`,
      })).toThrow("C4 independent review request is not canonical");
      expect(() => finalizeC4DatasetReadiness({
        baselineBytes,
        baselineStageEvidenceFiles,
        result,
        ...review,
        inputBundleBytes: review.inputBundleBytes.replace(
          "2026-07-15T19:59:00.000Z",
          "2026-07-15T19:59:01.000Z",
        ),
      })).toThrow("C4 independent review request is not canonical");
      expect(() => finalizeC4DatasetReadiness({
        baselineBytes,
        baselineStageEvidenceFiles,
        result,
        ...review,
        dispatchBytes: mutateDispatch(review.dispatchBytes),
      })).toThrow("C4 independent review dispatch is not canonical");
      expect(() => finalizeC4DatasetReadiness({
        baselineBytes,
        baselineStageEvidenceFiles,
        result,
        ...review,
        provenanceBytes: review.provenanceBytes.replace(
          '"authorTaskName": "/root"',
          '"authorTaskName": "/root/other"',
        ),
      })).toThrow(
        "C4 orchestrator attestation must be made by the author task",
      );
      const incompleteInventoryReview = independentReviewArtifacts(
        result,
        fixture.dataset.episodes,
        fixture.assetLock.files.slice(1).map((file) => ({
          path: file.path,
          sha256: file.sha256,
        })),
      );
      expect(() => finalizeC4DatasetReadiness({
        baselineBytes,
        baselineStageEvidenceFiles,
        result,
        ...incompleteInventoryReview,
      })).toThrow(
        "C4 review input bundle does not match the full frozen asset inventory",
      );
      await expect(finalizeWithBaseline(
        result,
        review,
        "redesign",
      )).rejects.toThrow(
        "C4 baseline ceiling report requires episode redesign before C5",
      );
      await expect(finalizeWithBaseline(
        result,
        review,
        "inconclusive",
      )).rejects.toThrow("C4 baseline ceiling report is inconclusive");
      const mismatchedBaseline = await baselineCeilingBytes(
        result,
        "proceed",
        "f".repeat(64),
      );
      expect(() => finalizeC4DatasetReadiness({
        baselineBytes: mismatchedBaseline,
        baselineStageEvidenceFiles:
          baselineEvidenceFiles(mismatchedBaseline, result),
        result,
        ...review,
      })).toThrow("C4 baseline asset lock binding mismatch");
      expect(() => finalizeC4DatasetReadiness({
        baselineBytes: baselineBytes.replace(
          /"stageEvidenceAggregateSha256": "[a-f0-9]{64}"/u,
          `"stageEvidenceAggregateSha256": "${"f".repeat(64)}"`,
        ),
        baselineStageEvidenceFiles,
        result,
        ...review,
      })).toThrow("C4 baseline stage evidence aggregate is inconsistent");
    } finally {
      await cleanupC4ControlledPilotDataset(fixture);
      await rm(sandbox, { force: true, recursive: true });
    }
  }, 240_000);

  it("rejects asset drift before running readiness probes", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "goodmemory-c4-drift-"));
    const fixture = await prepareC4ControlledPilotDataset({
      root: join(sandbox, "dataset"),
    });
    try {
      const promptPath = join(
        fixture.root,
        fixture.dataset.episodes[0]!.stages[0]!.promptPath,
      );
      await writeFile(
        promptPath,
        `${await readFile(promptPath, "utf8")}drift\n`,
        "utf8",
      );
      await expect(runC4DatasetCoreReadiness({
        datasetRoot: fixture.root,
        workspaceRoot: join(sandbox, "readiness"),
      })).rejects.toThrow("C4 asset lock mismatch");
    } finally {
      await cleanupC4ControlledPilotDataset(fixture);
      await rm(sandbox, { force: true, recursive: true });
    }
  }, 120_000);

  it("rejects hidden fail-to-pass inputs copied into agent-visible prompts", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "goodmemory-c4-leakage-"));
    const fixture = await prepareC4ControlledPilotDataset({
      root: join(sandbox, "dataset"),
    });
    try {
      const episode = fixture.dataset.episodes.find((candidate) =>
        candidate.id === "independent-string-utilities"
      )!;
      const promptPath = join(fixture.root, episode.stages[2]!.promptPath);
      await writeFile(
        promptPath,
        `${await readFile(promptPath, "utf8")}Reproduce docs/setup guide#intro exactly.\n`,
        "utf8",
      );
      const assetLock = await buildC4AssetLock(fixture.root);
      await writeFile(
        join(fixture.root, "asset-lock.json"),
        serializeC4AssetLock(assetLock),
        "utf8",
      );

      await expect(runC4DatasetCoreReadiness({
        datasetRoot: fixture.root,
        workspaceRoot: join(sandbox, "readiness"),
      })).rejects.toThrow("C4 leakage audit failed for independent-string-utilities");
    } finally {
      await cleanupC4ControlledPilotDataset(fixture);
      await rm(sandbox, { force: true, recursive: true });
    }
  }, 120_000);

  it("rejects numeric hidden values copied into agent-visible prompts", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "goodmemory-c4-number-leakage-"));
    const fixture = await prepareC4ControlledPilotDataset({
      root: join(sandbox, "dataset"),
    });
    try {
      const episode = fixture.dataset.episodes.find((candidate) =>
        candidate.id === "duration-configuration-policy"
      )!;
      const promptPath = join(fixture.root, episode.stages[0]!.promptPath);
      await writeFile(
        promptPath,
        `${await readFile(promptPath, "utf8")}Assert 2.5 -> 2_500.\n`,
        "utf8",
      );
      const assetLock = await buildC4AssetLock(fixture.root);
      await writeFile(
        join(fixture.root, "asset-lock.json"),
        serializeC4AssetLock(assetLock),
        "utf8",
      );

      await expect(runC4DatasetCoreReadiness({
        datasetRoot: fixture.root,
        workspaceRoot: join(sandbox, "readiness"),
      })).rejects.toThrow("C4 leakage audit failed for duration-configuration-policy");
    } finally {
      await cleanupC4ControlledPilotDataset(fixture);
      await rm(sandbox, { force: true, recursive: true });
    }
  }, 120_000);

  it("rejects hidden input-output relations assembled from public scalars", async () => {
    const sandbox = await mkdtemp(join(
      tmpdir(),
      "goodmemory-c4-relation-leakage-",
    ));
    const fixture = await prepareC4ControlledPilotDataset({
      root: join(sandbox, "dataset"),
    });
    try {
      const episode = fixture.dataset.episodes.find((candidate) =>
        candidate.id === "parse-result-correction"
      )!;
      const promptPath = join(fixture.root, episode.stages[1]!.promptPath);
      await writeFile(
        promptPath,
        `${await readFile(promptPath, "utf8")}For INFO, return invalid-level with ok false.\n`,
        "utf8",
      );
      const assetLock = await buildC4AssetLock(fixture.root);
      await writeFile(
        join(fixture.root, "asset-lock.json"),
        serializeC4AssetLock(assetLock),
        "utf8",
      );

      await expect(runC4DatasetCoreReadiness({
        datasetRoot: fixture.root,
        workspaceRoot: join(sandbox, "readiness"),
      })).rejects.toThrow(
        "C4 leakage audit failed for parse-result-correction/stage-2",
      );
    } finally {
      await cleanupC4ControlledPilotDataset(fixture);
      await rm(sandbox, { force: true, recursive: true });
    }
  }, 120_000);

  it("rejects hidden value 1 even when projection envelopes use schemaVersion 1", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "goodmemory-c4-one-leakage-"));
    const fixture = await prepareC4ControlledPilotDataset({
      root: join(sandbox, "dataset"),
    });
    try {
      const casesPath = join(fixture.root, "evaluator/cases.json");
      const originalCasesBytes = await readFile(casesPath, "utf8");
      const evaluator = JSON.parse(originalCasesBytes) as {
        cases: Array<{
          episodeId: string;
          failToPass: Array<{ expected: unknown }>;
          stageId: string;
        }>;
        schemaVersion: 1;
      };
      const hiddenCase = evaluator.cases.find((testCase) =>
        testCase.episodeId === "independent-string-utilities" &&
        testCase.stageId === "stage-1"
      )!;
      hiddenCase.failToPass[0]!.expected = 1;
      const mutatedCasesBytes = `${JSON.stringify(evaluator, null, 2)}\n`;
      await writeFile(casesPath, mutatedCasesBytes, "utf8");

      const originalCasesSha256 = sha256(originalCasesBytes);
      const mutatedCasesSha256 = sha256(mutatedCasesBytes);
      const manifestPath = join(fixture.root, "manifest.json");
      const manifest = JSON.parse(
        await readFile(manifestPath, "utf8"),
      ) as {
        episodes: Array<{
          forbiddenLeakage: { fileSha256: string[] };
          id: string;
          prehistory: { forbiddenLeakageSha256: string[] };
          stages: Array<{ promptPath: string }>;
        }>;
      };
      for (const episode of manifest.episodes) {
        episode.forbiddenLeakage.fileSha256 =
          episode.forbiddenLeakage.fileSha256.map((value) =>
            value === originalCasesSha256 ? mutatedCasesSha256 : value
          );
        episode.prehistory.forbiddenLeakageSha256 =
          episode.prehistory.forbiddenLeakageSha256.map((value) =>
            value === originalCasesSha256 ? mutatedCasesSha256 : value
          );
      }
      await writeFile(
        manifestPath,
        `${JSON.stringify(manifest, null, 2)}\n`,
        "utf8",
      );
      const episode = manifest.episodes.find((candidate) =>
        candidate.id === "independent-string-utilities"
      )!;
      const promptPath = join(fixture.root, episode.stages[0]!.promptPath);
      await writeFile(
        promptPath,
        `${await readFile(promptPath, "utf8")}Hidden expected value = 1.\n`,
        "utf8",
      );
      const assetLock = await buildC4AssetLock(fixture.root);
      await writeFile(
        join(fixture.root, "asset-lock.json"),
        serializeC4AssetLock(assetLock),
        "utf8",
      );

      await expect(runC4DatasetCoreReadiness({
        datasetRoot: fixture.root,
        workspaceRoot: join(sandbox, "readiness"),
      })).rejects.toThrow(
        "C4 leakage audit failed for independent-string-utilities",
      );
    } finally {
      await cleanupC4ControlledPilotDataset(fixture);
      await rm(sandbox, { force: true, recursive: true });
    }
  }, 120_000);

  it("rejects pass-to-pass values copied into agent-visible prompts", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "goodmemory-c4-p2p-leakage-"));
    const fixture = await prepareC4ControlledPilotDataset({
      root: join(sandbox, "dataset"),
    });
    try {
      const episode = fixture.dataset.episodes.find((candidate) =>
        candidate.id === "delimiter-boundary-policy"
      )!;
      const promptPath = join(fixture.root, episode.stages[0]!.promptPath);
      await writeFile(
        promptPath,
        `${await readFile(promptPath, "utf8")}The hidden input is left=right.\n`,
        "utf8",
      );
      const assetLock = await buildC4AssetLock(fixture.root);
      await writeFile(
        join(fixture.root, "asset-lock.json"),
        serializeC4AssetLock(assetLock),
        "utf8",
      );

      await expect(runC4DatasetCoreReadiness({
        datasetRoot: fixture.root,
        workspaceRoot: join(sandbox, "readiness"),
      })).rejects.toThrow(
        "C4 leakage audit failed for delimiter-boundary-policy",
      );
    } finally {
      await cleanupC4ControlledPilotDataset(fixture);
      await rm(sandbox, { force: true, recursive: true });
    }
  }, 120_000);

  it("rejects short code tokens copied from a real gold patch into a visible prompt", async () => {
    const sandbox = await mkdtemp(join(
      tmpdir(),
      "goodmemory-c4-short-gold-leakage-",
    ));
    const fixture = await prepareC4ControlledPilotDataset({
      root: join(sandbox, "dataset"),
    });
    try {
      const episode = fixture.dataset.episodes.find((candidate) =>
        candidate.id === "independent-string-utilities"
      )!;
      const promptPath = join(fixture.root, episode.stages[0]!.promptPath);
      await writeFile(
        promptPath,
        `${await readFile(promptPath, "utf8")}Use the hidden code token .trim() exactly.\n`,
        "utf8",
      );
      const assetLock = await buildC4AssetLock(fixture.root);
      await writeFile(
        join(fixture.root, "asset-lock.json"),
        serializeC4AssetLock(assetLock),
        "utf8",
      );

      await expect(runC4DatasetCoreReadiness({
        datasetRoot: fixture.root,
        workspaceRoot: join(sandbox, "readiness"),
      })).rejects.toThrow(
        "C4 leakage audit failed for independent-string-utilities",
      );
    } finally {
      await cleanupC4ControlledPilotDataset(fixture);
      await rm(sandbox, { force: true, recursive: true });
    }
  }, 120_000);

  it("rejects hidden values copied into newly added agent-visible repository files", async () => {
    const sandbox = await mkdtemp(join(
      tmpdir(),
      "goodmemory-c4-visible-file-leakage-",
    ));
    const fixture = await prepareC4ControlledPilotDataset({
      root: join(sandbox, "dataset"),
    });
    try {
      const episode = fixture.dataset.episodes.find((candidate) =>
        candidate.id === "independent-string-utilities"
      )!;
      const repositoryId = c4RepositoryIdForUrl(episode.repository.url);
      await writeFile(
        join(
          fixture.root,
          "repositories",
          repositoryId,
          "HINTS.md",
        ),
        "Reproduce docs/setup guide#intro exactly.\n",
        "utf8",
      );
      const reconstructed = join(sandbox, "reconstructed");
      const repositoryIdentity = await materializeC4SourceRepository({
        datasetRoot: fixture.root,
        destination: reconstructed,
        repositoryId,
      });
      const manifestPath = join(fixture.root, "manifest.json");
      const manifest = JSON.parse(
        await readFile(manifestPath, "utf8"),
      ) as {
        episodes: Array<{
          repository: { baseCommit: string; url: string };
          stages: Array<{ snapshot: string }>;
        }>;
      };
      for (const candidate of manifest.episodes) {
        if (candidate.repository.url !== episode.repository.url) {
          continue;
        }
        candidate.repository.baseCommit = repositoryIdentity.commit;
        for (const stage of candidate.stages) {
          stage.snapshot = repositoryIdentity.commit;
        }
      }
      await writeFile(
        manifestPath,
        `${JSON.stringify(manifest, null, 2)}\n`,
        "utf8",
      );
      await rm(reconstructed, { force: true, recursive: true });
      const assetLock = await buildC4AssetLock(fixture.root);
      await writeFile(
        join(fixture.root, "asset-lock.json"),
        serializeC4AssetLock(assetLock),
        "utf8",
      );

      await expect(runC4DatasetCoreReadiness({
        datasetRoot: fixture.root,
        workspaceRoot: join(sandbox, "readiness"),
      })).rejects.toThrow(
        "C4 leakage audit failed for independent-string-utilities",
      );
    } finally {
      await cleanupC4ControlledPilotDataset(fixture);
      await rm(sandbox, { force: true, recursive: true });
    }
  }, 120_000);

  it("treats agent-visible repository paths as part of the leakage surface", async () => {
    const sandbox = await mkdtemp(join(
      tmpdir(),
      "goodmemory-c4-visible-path-leakage-",
    ));
    const fixture = await prepareC4ControlledPilotDataset({
      root: join(sandbox, "dataset"),
    });
    try {
      const episode = fixture.dataset.episodes.find((candidate) =>
        candidate.id === "duration-configuration-policy"
      )!;
      const repositoryId = c4RepositoryIdForUrl(episode.repository.url);
      await writeFile(
        join(fixture.root, "repositories", repositoryId, "src/3000.ts"),
        "export const quantum = true;\n",
        "utf8",
      );
      const reconstructed = join(sandbox, "reconstructed");
      const repositoryIdentity = await materializeC4SourceRepository({
        datasetRoot: fixture.root,
        destination: reconstructed,
        repositoryId,
      });
      const manifestPath = join(fixture.root, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        episodes: Array<{
          repository: { baseCommit: string; url: string };
          stages: Array<{ snapshot: string }>;
        }>;
      };
      for (const candidate of manifest.episodes) {
        if (candidate.repository.url !== episode.repository.url) {
          continue;
        }
        candidate.repository.baseCommit = repositoryIdentity.commit;
        for (const stage of candidate.stages) {
          stage.snapshot = repositoryIdentity.commit;
        }
      }
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      await rm(reconstructed, { force: true, recursive: true });
      await writeFile(
        join(fixture.root, "asset-lock.json"),
        serializeC4AssetLock(await buildC4AssetLock(fixture.root)),
        "utf8",
      );

      await expect(runC4DatasetCoreReadiness({
        datasetRoot: fixture.root,
        workspaceRoot: join(sandbox, "readiness"),
      })).rejects.toThrow(
        "C4 leakage audit failed for duration-configuration-policy",
      );
    } finally {
      await cleanupC4ControlledPilotDataset(fixture);
      await rm(sandbox, { force: true, recursive: true });
    }
  }, 120_000);

  it("materializes byte-identical manifests and asset locks from scratch", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "goodmemory-c4-repeat-"));
    const first = await prepareC4ControlledPilotDataset({
      root: join(sandbox, "first"),
    });
    const second = await prepareC4ControlledPilotDataset({
      root: join(sandbox, "second"),
    });
    try {
      expect(first.assetLockSha256).toBe(second.assetLockSha256);
      expect(first.assetLock.assetRootSha256).toBe(
        second.assetLock.assetRootSha256,
      );
      expect(await readFile(join(first.root, "manifest.json"), "utf8")).toBe(
        await readFile(join(second.root, "manifest.json"), "utf8"),
      );
    } finally {
      await cleanupC4ControlledPilotDataset(first);
      await cleanupC4ControlledPilotDataset(second);
      await rm(sandbox, { force: true, recursive: true });
    }
  });
});

function independentReviewArtifacts(
  result: Awaited<ReturnType<typeof runC4DatasetCoreReadiness>>,
  episodes: readonly { author: string; id: string }[],
  assetFiles: ReadonlyArray<{ path: string; sha256: string }>,
): {
  dispatchBytes: string;
  inputBundleBytes: string;
  provenanceBytes: string;
  requestBytes: string;
  reviewBytes: string;
} {
  const inputBundleBytes = serializeC4ReviewArtifact(
    buildC4ReviewInputBundle({
      assetFiles,
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
    episodeReviews: episodes.map((episode) =>
      episode.id === "independent-string-utilities"
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
  const reviewBytes = `${JSON.stringify(review, null, 2)}\n`;
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

async function baselineCeilingBytes(
  result: Awaited<ReturnType<typeof runC4DatasetCoreReadiness>>,
  outcome: "inconclusive" | "proceed" | "redesign",
  assetLockSha256 = result.core.assetLockSha256,
): Promise<string> {
  let executionIndex = 0;
  const bindings = frozenBindings(result);
  const report = await runC4AdaptiveBaselineCeiling({
    executeStage: async (target) => {
      executionIndex += 1;
      return baselineStageResult(
        target,
        outcome,
        executionIndex,
        requiredFrozenBinding(bindings, target.episodeId, target.stageId),
      );
    },
    runIdentity: {
      assetLockSha256,
      assetRootSha256: result.core.assetRootSha256,
      claimBoundary: "diagnostic-no-memory-ceiling-only",
      codexExecutableSha256: "d".repeat(64),
      codexVersion: "codex-cli 0.144.5",
      datasetSnapshotMode: "asset-locked-copy",
      datasetId: result.core.datasetId,
      generatedAt: "2026-07-16T11:00:00.000Z",
      host: "codex",
      manifestSha256: result.core.manifestSha256,
      model: "gpt-5.6-sol",
      networkAccess: false,
      publicClaimEligible: false,
      reasoningEffort: "xhigh",
      runId: "c4-baseline-test",
      schemaVersion: 2,
      stageTimeoutMs: 900_000,
      strategy: "stage-3-first-then-stage-2-if-needed",
      testTimeoutMs: 300_000,
    },
    targets: result.core.stages
      .filter((stage) => stage.stageId === "stage-2" || stage.stageId === "stage-3")
      .map((stage) => ({
        episodeId: stage.episodeId,
        position: stage.stageId === "stage-2" ? 2 as const : 3 as const,
        stageId: stage.stageId === "stage-2" ? "stage-2" : "stage-3",
        stageInputSha256: stage.stageInputSha256,
      })),
  });
  return serializeC4BaselineCeilingReport(report);
}

function baselineStageResult(
  target: C4BaselineCeilingTarget,
  outcome: "inconclusive" | "proceed" | "redesign",
  executionIndex: number,
  binding: C4BaselineFrozenStageBinding,
): C4BaselineStageResult {
  const infrastructureFailure = outcome === "inconclusive" &&
    executionIndex === 1;
  const resolved = outcome === "redesign" &&
    target.stageId === "stage-3" &&
    executionIndex <= 5;
  const patchDiff = resolved
    ? "diff --git a/src/tasks.ts b/src/tasks.ts\n+resolved\n"
    : "";
  const result: Omit<C4BaselineStageResult, "stageEvidenceSha256"> = {
    changedFiles: resolved ? ["src/tasks.ts"] : [],
    codexStatus: infrastructureFailure ? "failed" : "completed",
    disposition: infrastructureFailure
      ? "infrastructure-failure"
      : "finalized",
    episodeId: target.episodeId,
    executionFailureStage: infrastructureFailure ? "codex-exec" : null,
    failToPassStatus: resolved ? "passed" : "failed",
    passToPassStatus: infrastructureFailure ? "not-run" : "passed",
    patchSha256: resolved ? sha256(patchDiff) : null,
    resolved,
    stageId: target.stageId,
    stageInputSha256: target.stageInputSha256,
    taskFailureReasons: infrastructureFailure
      ? ["codex-exec"]
      : resolved
      ? []
      : ["no-patch", "hidden-fail-to-pass-failed"],
    threadId: infrastructureFailure
      ? null
      : `thread-${target.episodeId}-${target.stageId}`,
  };
  return {
    ...result,
    stageEvidenceSha256: sha256(rawBaselineStageEvidenceBytes(result, binding)),
  };
}

async function finalizeWithBaseline(
  result: Awaited<ReturnType<typeof runC4DatasetCoreReadiness>>,
  review: ReturnType<typeof independentReviewArtifacts>,
  outcome: "inconclusive" | "proceed" | "redesign",
) {
  const baselineBytes = await baselineCeilingBytes(result, outcome);
  return finalizeC4DatasetReadiness({
    baselineBytes,
    baselineStageEvidenceFiles: baselineEvidenceFiles(baselineBytes, result),
    result,
    ...review,
  });
}

function baselineEvidenceFiles(
  baselineBytes: string,
  result: Awaited<ReturnType<typeof runC4DatasetCoreReadiness>>,
): C4BaselineStageEvidenceFile[] {
  const report = JSON.parse(baselineBytes) as C4BaselineCeilingReport;
  const bindings = frozenBindings(result);
  return buildC4BaselineStageEvidenceBindings(
    report,
    report.results.map((stage) => {
      const { stageEvidenceSha256: _, ...result } = stage;
      return {
        bytes: rawBaselineStageEvidenceBytes(
          result,
          requiredFrozenBinding(bindings, stage.episodeId, stage.stageId),
        ),
        path: `${stage.episodeId}-${stage.stageId}/stage-evidence.json`,
      };
    }),
    bindings,
  );
}

function rawBaselineStageEvidenceBytes(
  result: Omit<C4BaselineStageResult, "stageEvidenceSha256">,
  binding: C4BaselineFrozenStageBinding,
): string {
  return `${JSON.stringify({
    arm: {
      absenceAudit: { passed: true },
      codexExecutableSha256: "d".repeat(64),
      codexVersion: "codex-cli 0.144.5",
      instructionSha256: "8".repeat(64),
      networkAccess: false,
      permissionIsolation: {
        audit: { passed: true },
        evidenceSha256: "9".repeat(64),
      },
    },
    ...(result.disposition === "infrastructure-failure"
      ? {
          failure: {
            failureStage: result.executionFailureStage,
            reasonSha256: "f".repeat(64),
          },
        }
      : {
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
          evaluator: {
            commitments: binding.evaluatorCommitments,
            credentialsRemovedBeforeMaterialization: true,
            failToPass: {
              durationMs: 1,
              exitCode: result.failToPassStatus === "passed" ? 0 : 1,
              kind: "fail-to-pass",
              status: result.failToPassStatus,
              stderr: "",
              stdout: "",
            },
            materializedAfterCodexExit: true,
            passToPass: {
              durationMs: 1,
              exitCode: result.passToPassStatus === "passed" ? 0 : 1,
              kind: "pass-to-pass",
              status: result.passToPassStatus,
              stderr: "",
              stdout: "",
            },
            sandbox: {
              configSha256: "c".repeat(64),
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
            diff: result.patchSha256 === null
              ? ""
              : "diff --git a/src/tasks.ts b/src/tasks.ts\n+resolved\n",
            forbiddenFiles: [],
            hasPatch: result.patchSha256 !== null,
            sha256: result.patchSha256,
            untrackedFiles: [],
          },
          visibleBaseHealth: {
            durationMs: 1,
            exitCode: 0,
            passed: true,
            status: "passed",
            stderr: "",
            stdout: "",
          },
        }),
    dataset: {
      episodeId: result.episodeId,
      promptSha256: binding.promptSha256,
      repositoryCommit: binding.repositoryCommit,
      repositoryTree: binding.repositoryTree,
      snapshot: binding.repositoryCommit,
      stageId: result.stageId,
      stageInputSha256: result.stageInputSha256,
    },
    result,
    schemaVersion: 1,
  }, null, 2)}\n`;
}

function frozenBindings(
  result: Awaited<ReturnType<typeof runC4DatasetCoreReadiness>>,
): C4BaselineFrozenStageBinding[] {
  return result.core.stages
    .filter((stage) => stage.stageId === "stage-2" || stage.stageId === "stage-3")
    .map((stage) => ({
      episodeId: stage.episodeId,
      evaluatorCommitments: stage.evaluatorCommitments,
      promptSha256: stage.effectivePromptSha256,
      repositoryCommit: stage.repositoryCommit,
      repositoryTree: stage.repositoryTree,
      stageId: stage.stageId,
    }));
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

function mutateDispatch(dispatchBytes: string): string {
  const dispatch = JSON.parse(dispatchBytes) as { spawnMessage: string };
  dispatch.spawnMessage = `${dispatch.spawnMessage} Custom instruction.`;
  return `${JSON.stringify(dispatch, null, 2)}\n`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
