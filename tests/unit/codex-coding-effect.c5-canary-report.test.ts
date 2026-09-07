import { describe, expect, it } from "bun:test";

import {
  buildC5NativeLongitudinalCanaryReport,
} from "../../scripts/codex-coding-effect/c5-live-pilot";
import type {
  C5LongitudinalPairResult,
  C5LongitudinalPilotResult,
  C5RecordedStageExecution,
} from "../../scripts/codex-coding-effect/c5-longitudinal";

const CLUSTER = "episode-a/repetition-1";

function execution(
  arm: C5RecordedStageExecution["arm"],
  position: number,
): C5RecordedStageExecution {
  const installed = arm === "goodmemory-installed";
  return {
    arm,
    attemptId: `${arm}-attempt-${position}`,
    changedFiles: [],
    clusterId: CLUSTER,
    codexStatus: "completed",
    episodeId: "episode-a",
    infrastructureFailureStage: null,
    memoryChannelStatus: installed ? "passed" : "not-applicable",
    memoryObservation: installed
      ? { injectedContextSha256: "a".repeat(64), recallSurfaceSha256: "b".repeat(64) }
      : null,
    patchSha256: null,
    repetition: 1,
    stageEvidenceSha256: "c".repeat(64),
    stageId: `stage-${position}`,
    stageRunId: `${CLUSTER}/${arm}/stage-${position}`,
    threadId: null,
  } as unknown as C5RecordedStageExecution;
}

function pair(position: number): C5LongitudinalPairResult {
  return {
    clusterId: CLUSTER,
    comparable: true,
    episodeId: "episode-a",
    evaluations: [
      {
        arm: "flat-summary",
        disposition: "finalized",
        evaluationEvidenceSha256: "d".repeat(64),
        resolved: false,
        taskFailureReasons: ["hidden-fail-to-pass-failed"],
      },
      {
        arm: "goodmemory-installed",
        disposition: "finalized",
        evaluationEvidenceSha256: "e".repeat(64),
        resolved: true,
        taskFailureReasons: [],
      },
    ],
    incomparabilityReasons: [],
    leakageAuditSha256: "f".repeat(64),
    memoryExpectation: position === 1 ? "none" : "required",
    outcome: "rescue",
    repetition: 1,
    stageId: `stage-${position}`,
  } as unknown as C5LongitudinalPairResult;
}

function pilot(stageCount: number): C5LongitudinalPilotResult {
  const positions = Array.from({ length: stageCount }, (_, index) => index + 1);
  return {
    pairs: positions.map(pair),
    stageExecutions: positions.flatMap((position) => [
      execution("flat-summary", position),
      execution("goodmemory-installed", position),
    ]),
  };
}

function report(stageCount: number, expectedStageCount: number) {
  return buildC5NativeLongitudinalCanaryReport({
    clusterId: CLUSTER,
    expectedStageCount,
    generatedAt: "2026-09-04T00:00:00.000Z",
    pilot: pilot(stageCount),
    planSha256: "0".repeat(64),
    runId: "run-canary-test",
  });
}

describe("C5 native lifecycle canary report", () => {
  it("accepts the frozen C4 cluster shape (three stages, six processes)", () => {
    expect(report(3, 3)).toMatchObject({
      decision: "accepted",
      pairCount: 3,
      reasons: [],
      stageExecutionCount: 6,
    });
  });

  it("accepts a Level-2 cluster shape (four stages, eight processes)", () => {
    expect(report(4, 4)).toMatchObject({
      decision: "accepted",
      pairCount: 4,
      reasons: [],
      stageExecutionCount: 8,
    });
  });

  it("rejects a cluster whose executions do not match the plan's stage count", () => {
    const rejected = report(4, 3);
    expect(rejected.decision).toBe("rejected");
    expect(rejected.reasons).toEqual([
      "canary-did-not-account-for-every-stage-execution",
      "canary-did-not-account-for-every-pair",
      "canary-installed-memory-channel-failure",
      "canary-no-memory-isolation-failure",
    ]);
  });

  it("rejects a cluster missing one arm's stage even when counts otherwise look complete", () => {
    const partial = pilot(4);
    partial.stageExecutions = partial.stageExecutions.filter((execution) =>
      !(execution.arm === "goodmemory-installed" && execution.stageId === "stage-4")
    );
    const rejected = buildC5NativeLongitudinalCanaryReport({
      clusterId: CLUSTER,
      expectedStageCount: 4,
      generatedAt: "2026-09-04T00:00:00.000Z",
      pilot: partial,
      planSha256: "0".repeat(64),
      runId: "run-canary-test",
    });
    expect(rejected.decision).toBe("rejected");
    expect(rejected.reasons).toContain("canary-did-not-account-for-every-stage-execution");
    expect(rejected.reasons).toContain("canary-installed-memory-channel-failure");
  });
});
