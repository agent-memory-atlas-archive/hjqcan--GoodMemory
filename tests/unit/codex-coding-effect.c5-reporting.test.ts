import { describe, expect, it } from "bun:test";

import {
  buildC5PilotPlan,
} from "../../scripts/codex-coding-effect/c5-pilot-plan";
import {
  buildC5PilotReport,
} from "../../scripts/codex-coding-effect/c5-reporting";
import type {
  C5LongitudinalPilotResult,
  C5PairOutcome,
} from "../../scripts/codex-coding-effect/c5-longitudinal";
import { loadCodexCodingEffectDataset } from "../../scripts/codex-coding-effect/dataset";

const SHA = "a".repeat(64);

describe("Codex coding-effect C5 reporting", () => {
  it("accounts for all 72 attempts and produces a conservative expanded-run budget", async () => {
    const plan = await pilotPlan();
    const report = buildC5PilotReport({
      generatedAt: "2026-07-16T00:00:00.000Z",
      plan,
      planSha256: SHA,
      result: pilotResult(plan, () => "rescue"),
      runId: "c5-report-fixture",
    });

    expect(report).toMatchObject({
      acceptance: {
        everyAttemptAccountedFor: true,
        failureTaxonomyProduced: true,
        noSilentFallback: true,
        powerAnalysisProduced: true,
        status: "accepted",
      },
      attempts: {
        accountedCount: 72,
        codexCompletedCount: 72,
        infrastructureFailureCount: 0,
        scheduledCount: 72,
      },
      claimBoundary: "internal-native-longitudinal-pilot-only",
      pairs: {
        comparableCount: 36,
        incomparableCount: 0,
        outcomes: {
          incomparable: 0,
          regression: 0,
          rescue: 36,
          "shared-fail": 0,
          "shared-pass": 0,
        },
      },
      publicClaimEligible: false,
      publicCodingEffectProof: false,
      readmeRowAllowed: false,
      schemaVersion: 1,
    });
    expect(report.effect.netRescueRate).toBe(1);
    expect(report.effect.netRescueRateInterval95).toEqual({
      bootstrapSamples: 10_000,
      confidenceLevel: 0.95,
      lower: 1,
      method: "paired-episode-cluster-percentile-bootstrap",
      resamplingUnit: "episode",
      upper: 1,
    });
    expect(report.resourceUsage).toEqual({
      attemptsWithUsage: 72,
      cachedInputTokens: 720,
      estimatedCostUsd: null,
      inputTokens: 1_440,
      missingUsageCount: 0,
      outputTokens: 360,
      pricingBoundary: "token-usage-only-model-price-not-frozen",
      totalCodexDurationMs: 7_200,
    });
    expect(report.memoryBehavior).toMatchObject({
      installedAttemptCount: 36,
      missingObservationCount: 0,
      observedAttemptCount: 36,
      requiredRecallObservedCount: 20,
      writebackCommittedCount: 36,
    });
    expect(report.powerAnalysis).toMatchObject({
      alpha: 0.05,
      materialEffectRate: 0.1,
      power: 0.8,
      planningDiscordanceRate: 0.5,
      seeds: 3,
      stagesPerEpisode: 3,
    });
    expect(report.powerAnalysis.requiredEpisodes).toBeGreaterThanOrEqual(30);
    expect(report.fullSetBudget.codexCalls).toBeGreaterThanOrEqual(540);
    expect(report.fullSetBudget.repositories).toBeGreaterThanOrEqual(6);
    expect(report.fullSetBudget.scoredStages).toBeGreaterThanOrEqual(90);
  });

  it("retains incomparable reasons in a reviewed failure taxonomy", async () => {
    const plan = await pilotPlan();
    const result = pilotResult(plan, ({ stageId }) =>
      stageId === "stage-2" ? "incomparable" : "shared-fail"
    );
    for (const pair of result.pairs.filter((item) =>
      item.outcome === "incomparable"
    )) {
      pair.comparable = false;
      pair.incomparabilityReasons = [
        "goodmemory-required-memory-channel-failed",
      ];
      const installed = result.stageExecutions.find((execution) =>
        execution.clusterId === pair.clusterId &&
        execution.stageId === pair.stageId &&
        execution.arm === "goodmemory-installed"
      )!;
      installed.memoryChannelStatus = "failed";
    }

    const report = buildC5PilotReport({
      generatedAt: "2026-07-16T00:00:00.000Z",
      plan,
      planSha256: SHA,
      result,
      runId: "c5-failure-fixture",
    });

    expect(report.pairs.incomparableCount).toBe(12);
    expect(report.failureTaxonomy).toContainEqual({
      count: 12,
      reason: "goodmemory-required-memory-channel-failed",
    });
    expect(report.acceptance.noSilentFallback).toBe(true);
  });

  it("uses the conservative correlation bound when comparable episode groups are incomplete", async () => {
    const plan = await pilotPlan();
    const result = pilotResult(plan, () => "shared-fail");
    const pair = result.pairs[0]!;
    pair.comparable = false;
    pair.outcome = "incomparable";
    pair.incomparabilityReasons = ["goodmemory-required-memory-channel-failed"];
    const installed = result.stageExecutions.find((execution) =>
      execution.clusterId === pair.clusterId &&
      execution.stageId === pair.stageId &&
      execution.arm === "goodmemory-installed"
    )!;
    installed.memoryChannelStatus = "failed";

    const report = buildC5PilotReport({
      generatedAt: "2026-07-16T00:00:00.000Z",
      plan,
      planSha256: SHA,
      result,
      runId: "c5-incomplete-groups-fixture",
    });

    expect(report.powerAnalysis.observedWithinEpisodeCorrelation).toBe(1);
    expect(report.powerAnalysis.designEffect).toBe(9);
  });

  it("rejects a summary when one scheduled attempt is missing", async () => {
    const plan = await pilotPlan();
    const result = pilotResult(plan, () => "shared-pass");
    result.stageExecutions.pop();

    expect(() => buildC5PilotReport({
      generatedAt: "2026-07-16T00:00:00.000Z",
      plan,
      planSha256: SHA,
      result,
      runId: "c5-incomplete-fixture",
    })).toThrow("C5 report does not account for every scheduled stage run");
  });

  it("derives Level-2 stage counts from the frozen plan instead of the C4 constant", async () => {
    const plan = await level2PilotPlan();
    const report = buildC5PilotReport({
      generatedAt: "2026-09-04T00:00:00.000Z",
      plan,
      planSha256: SHA,
      result: pilotResult(plan, () => "rescue"),
      runId: "c5-report-level2-fixture",
    });

    expect(plan.clusters).toHaveLength(90);
    expect(report.attempts).toMatchObject({
      accountedCount: 720,
      scheduledCount: 720,
    });
    expect(report.pairs).toMatchObject({
      comparableCount: 360,
      scheduledCount: 360,
    });
    expect(report.powerAnalysis).toMatchObject({
      seeds: 3,
      stagesPerEpisode: 4,
    });
    const required = report.powerAnalysis.requiredEpisodes;
    expect(required).toBeGreaterThanOrEqual(30);
    expect(report.fullSetBudget).toEqual({
      arms: 2,
      codexCalls: required * 4 * 2 * 3,
      episodes: required,
      repositories: 6,
      scoredStages: required * 4,
      seeds: 3,
    });
  });
});

async function level2PilotPlan() {
  const loaded = await loadCodexCodingEffectDataset(
    "fixtures/codex-coding-effect/level2-controlled-mutation",
  );
  return buildC5PilotPlan({
    assetLockSha256: SHA,
    assetRootSha256: SHA,
    baselineCeilingReportSha256: SHA,
    c4ReadinessReportSha256: SHA,
    dataset: loaded.dataset,
    manifestSha256: SHA,
    materialEffectPercentagePoints: 10,
    orderSeed: 73,
  });
}

async function pilotPlan() {
  const loaded = await loadCodexCodingEffectDataset(
    "fixtures/codex-coding-effect/c4-controlled-pilot",
  );
  return buildC5PilotPlan({
    assetLockSha256: SHA,
    assetRootSha256: SHA,
    baselineCeilingReportSha256: SHA,
    c4ReadinessReportSha256: SHA,
    dataset: loaded.dataset,
    manifestSha256: SHA,
    materialEffectPercentagePoints: 10,
    orderSeed: 73,
  });
}

function pilotResult(
  plan: Awaited<ReturnType<typeof pilotPlan>>,
  outcome: (input: { stageId: string }) => C5PairOutcome,
): C5LongitudinalPilotResult {
  const stageExecutions = plan.episodeArmRuns.flatMap((run) =>
    run.stages.map((stage) => ({
      arm: run.arm,
      clusterId: run.clusterId,
      codexDurationMs: 100,
      codexStatus: "completed",
      codexUsage: {
        cachedInputTokens: 10,
        inputTokens: 20,
        outputTokens: 5,
      },
      episodeId: run.episodeId,
      infrastructureFailureStage: null,
      memoryObservation: run.arm === "no-memory"
        ? null
        : {
            injectedRecordCount: 1,
            irrelevantInjection: false,
            recalledPriorMemoryCount: 1,
            writebackCommitted: true,
            writtenMemoryCount: 1,
          },
      memoryChannelStatus: run.arm === "no-memory"
        ? "not-applicable" as const
        : "passed" as const,
      repetition: run.repetition,
      stageEvidenceSha256: SHA,
      stageId: stage.stageId,
      stageRunId: stage.id,
      threadId: `thread-${stage.stageRunIdentitySha256}`,
    }))
  );
  const pairs = plan.clusters.flatMap((cluster) => {
    const stages = plan.episodeArmRuns.find((run) =>
      run.clusterId === cluster.id
    )!.stages;
    return stages.map((stage) => {
      const pairOutcome = outcome({ stageId: stage.stageId });
      const noMemoryResolved = pairOutcome === "regression" ||
        pairOutcome === "shared-pass";
      const installedResolved = pairOutcome === "rescue" ||
        pairOutcome === "shared-pass";
      return {
        clusterId: cluster.id,
        comparable: pairOutcome !== "incomparable",
        episodeId: cluster.episodeId,
        evaluations: [
          {
            arm: "no-memory" as const,
            disposition: "finalized" as const,
            evaluationEvidenceSha256: SHA,
            resolved: noMemoryResolved,
            taskFailureReasons: noMemoryResolved
              ? []
              : ["hidden-fail-to-pass-failed"],
          },
          {
            arm: "goodmemory-installed" as const,
            disposition: "finalized" as const,
            evaluationEvidenceSha256: SHA,
            resolved: installedResolved,
            taskFailureReasons: installedResolved
              ? []
              : ["hidden-fail-to-pass-failed"],
          },
        ],
        incomparabilityReasons: pairOutcome === "incomparable"
          ? ["fixture-incomparable"]
          : [],
        leakageAuditSha256: SHA,
        memoryExpectation: stage.memoryExpectation,
        outcome: pairOutcome,
        repetition: cluster.repetition,
        stageId: stage.stageId,
      };
    });
  });
  return { pairs, stageExecutions };
}
