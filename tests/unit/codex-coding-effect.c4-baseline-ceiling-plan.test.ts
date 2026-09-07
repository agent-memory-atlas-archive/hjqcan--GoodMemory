import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";

import {
  assertC4BaselineCeilingReportBindings,
  buildC4BaselineCeilingPlan,
  c4BaselineStageIsTarget,
  c4BaselineTargetLabel,
  runC4AdaptiveBaselineCeiling,
} from "../../scripts/codex-coding-effect/c4-baseline-ceiling";
import type {
  C4BaselineCeilingTarget,
  C4BaselineStageResult,
} from "../../scripts/codex-coding-effect/c4-baseline-ceiling";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function target(episodeId: string, position: number): C4BaselineCeilingTarget {
  return {
    episodeId,
    position,
    stageId: `stage-${position}`,
    stageInputSha256: sha256(`${episodeId}/stage-${position}`),
  };
}

function c4Targets(): C4BaselineCeilingTarget[] {
  return Array.from({ length: 6 }, (_, index) => [
    target(`episode-${index + 1}`, 2),
    target(`episode-${index + 1}`, 3),
  ]).flat();
}

// Level-2 shape: thirty recall stages at position 4, plus a few required
// correction and supersession stages at positions 3 and 2.
function level2Targets(): C4BaselineCeilingTarget[] {
  const targets = Array.from({ length: 30 }, (_, index) =>
    target(`episode-${index + 1}`, 4)
  );
  for (let index = 0; index < 5; index += 1) {
    targets.push(target(`episode-${index + 1}`, 3));
  }
  for (let index = 5; index < 8; index += 1) {
    targets.push(target(`episode-${index + 1}`, 2));
  }
  return targets;
}

function result(
  item: C4BaselineCeilingTarget,
  resolved: boolean,
): C4BaselineStageResult {
  return {
    changedFiles: resolved ? ["src/index.ts"] : [],
    codexStatus: "completed",
    disposition: "finalized",
    episodeId: item.episodeId,
    executionFailureStage: null,
    failToPassStatus: resolved ? "passed" : "failed",
    passToPassStatus: "passed",
    patchSha256: resolved ? sha256(`${item.episodeId}/${item.stageId}`) : null,
    resolved,
    stageEvidenceSha256: sha256(`evidence/${item.episodeId}/${item.stageId}`),
    stageId: item.stageId,
    stageInputSha256: item.stageInputSha256,
    taskFailureReasons: resolved ? [] : ["no-patch"],
    threadId: `${item.episodeId}-${item.stageId}`,
  };
}

function identity(strategy: string) {
  return {
    assetLockSha256: "a".repeat(64),
    assetRootSha256: "b".repeat(64),
    claimBoundary: "diagnostic-no-memory-ceiling-only" as const,
    codexExecutableSha256: "d".repeat(64),
    codexVersion: "codex-cli 0.152.1",
    datasetSnapshotMode: "asset-locked-copy" as const,
    datasetId: "codex-level2-controlled-mutation-v1",
    generatedAt: "2026-09-03T08:00:00.000Z",
    host: "codex" as const,
    manifestSha256: "c".repeat(64),
    model: "gpt-5.6-sol",
    networkAccess: false as const,
    publicClaimEligible: false as const,
    reasoningEffort: "xhigh",
    runId: "level2-ceiling-test",
    schemaVersion: 2 as const,
    stageTimeoutMs: 900_000,
    strategy,
    testTimeoutMs: 300_000,
  };
}

describe("Codex coding-effect baseline ceiling plan", () => {
  it("reproduces the frozen C4 thresholds, labels, and identity strategy", () => {
    const plan = buildC4BaselineCeilingPlan(c4Targets(), {
      targetLabel: "all-episodes",
    });
    expect(plan.rounds).toEqual([
      { position: 3, stageId: "stage-3", targetCount: 6, threshold: 5 },
      { position: 2, stageId: "stage-2", targetCount: 6, threshold: 10 },
    ]);
    expect(plan.strategy).toEqual({
      earlyCeilingThreshold: 5,
      finalCeilingThreshold: 10,
      firstRound: "stage-3-all-episodes",
      secondRound: "stage-2-all-episodes-if-needed",
      stage1Excluded: true,
    });
    expect(plan.runIdentityStrategy).toBe("stage-3-first-then-stage-2-if-needed");
  });

  it("targets only required later stages for the Level-2 profile", () => {
    expect(c4BaselineTargetLabel("codex-c4-controlled-pilot-v2")).toBe("all-episodes");
    expect(c4BaselineTargetLabel("codex-level2-controlled-mutation-v1")).toBe(
      "required-stages",
    );
    const level2 = "codex-level2-controlled-mutation-v1";
    expect(c4BaselineStageIsTarget(level2, {
      memoryExpectation: { mode: "required" },
      position: 4,
    })).toBe(true);
    expect(c4BaselineStageIsTarget(level2, {
      memoryExpectation: { mode: "irrelevant-control" },
      position: 2,
    })).toBe(false);
    expect(c4BaselineStageIsTarget(level2, {
      memoryExpectation: "required",
      position: 1,
    })).toBe(false);
    expect(c4BaselineStageIsTarget("codex-c4-controlled-pilot-v2", {
      memoryExpectation: { mode: "irrelevant-control" },
      position: 2,
    })).toBe(true);
  });

  it("derives descending rounds with five-sixths cumulative thresholds", () => {
    const plan = buildC4BaselineCeilingPlan(level2Targets(), {
      targetLabel: "required-stages",
    });
    expect(plan.rounds).toEqual([
      { position: 4, stageId: "stage-4", targetCount: 30, threshold: 25 },
      { position: 3, stageId: "stage-3", targetCount: 5, threshold: 30 },
      { position: 2, stageId: "stage-2", targetCount: 3, threshold: 32 },
    ]);
    expect(plan.strategy).toEqual({
      earlyCeilingThreshold: 25,
      finalCeilingThreshold: 32,
      firstRound: "stage-4-required-stages",
      laterRounds: "stage-2-required-stages-if-needed",
      secondRound: "stage-3-required-stages-if-needed",
      stage1Excluded: true,
    });
    expect(plan.runIdentityStrategy).toBe(
      "stage-4-required-stages-first-then-descending-if-needed",
    );
  });

  it("runs every round when no-memory stays under the ceiling and binds the report", async () => {
    const calls: string[] = [];
    const report = await runC4AdaptiveBaselineCeiling({
      executeStage: async (item) => {
        calls.push(item.stageId);
        return result(item, false);
      },
      runIdentity: identity(
        "stage-4-required-stages-first-then-descending-if-needed",
      ),
      targetLabel: "required-stages",
      targets: level2Targets(),
    });
    expect(calls.filter((stage) => stage === "stage-4")).toHaveLength(30);
    expect(calls.filter((stage) => stage === "stage-3")).toHaveLength(5);
    expect(calls.filter((stage) => stage === "stage-2")).toHaveLength(3);
    expect(report.rounds.map((round) => round.position)).toEqual([4, 3, 2]);
    expect(report).toMatchObject({
      ceilingRisk: false,
      decision: "proceed-to-c5-pilot",
      resolvedCount: 0,
    });
    const plan = buildC4BaselineCeilingPlan(level2Targets(), {
      targetLabel: "required-stages",
    });
    expect(() => assertC4BaselineCeilingReportBindings(report, plan)).not.toThrow();
    expect(() =>
      assertC4BaselineCeilingReportBindings(
        { ...report, strategy: { ...report.strategy, finalCeilingThreshold: 31 } },
        plan,
      )
    ).toThrow("C4 baseline strategy does not match its plan");
  });

  it("stops after the first round when no-memory already clears the ceiling", async () => {
    const report = await runC4AdaptiveBaselineCeiling({
      executeStage: async (item) => result(item, true),
      runIdentity: identity(
        "stage-4-required-stages-first-then-descending-if-needed",
      ),
      targetLabel: "required-stages",
      targets: level2Targets(),
    });
    expect(report.rounds).toHaveLength(1);
    expect(report.attemptedCount).toBe(30);
    expect(report).toMatchObject({
      ceilingRisk: true,
      decision: "redesign-episodes-before-c5",
    });
    expect(() =>
      assertC4BaselineCeilingReportBindings(
        report,
        buildC4BaselineCeilingPlan(level2Targets(), {
          targetLabel: "required-stages",
        }),
      )
    ).not.toThrow();
  });

  it("rejects a run identity whose strategy disagrees with the plan", async () => {
    await expect(runC4AdaptiveBaselineCeiling({
      executeStage: async (item) => result(item, false),
      runIdentity: identity("stage-3-first-then-stage-2-if-needed"),
      targetLabel: "required-stages",
      targets: level2Targets(),
    })).rejects.toThrow("C4 baseline run identity strategy does not match its plan");
  });
});
