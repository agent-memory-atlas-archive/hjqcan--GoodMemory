import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildC5PilotPlan,
} from "../../scripts/codex-coding-effect/c5-pilot-plan";
import {
  openC5EvidenceLedger,
} from "../../scripts/codex-coding-effect/c5-ledger";
import type {
  C5LongitudinalPairResult,
  C5RecordedStageExecution,
} from "../../scripts/codex-coding-effect/c5-longitudinal";
import { loadCodexCodingEffectDataset } from "../../scripts/codex-coding-effect/dataset";

const SHA = "a".repeat(64);
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("Codex coding-effect C5 evidence ledger", () => {
  it("persists each completed stage and pair immediately with duplicate protection", async () => {
    const root = await mkdtemp(join(tmpdir(), "goodmemory-c5-ledger-"));
    try {
      const plan = await pilotPlan();
      const stage = stageExecution(plan);
      const pair = pairResult(plan);
      const ledger = await openC5EvidenceLedger({
        directory: root,
        identity: {
          planSha256: SHA,
          runId: "c5-ledger-fixture",
          schemaVersion: 1,
        },
        plan,
      });

      await ledger.appendStageExecution(stage);
      await ledger.appendPair(pair);

      expect(await readFile(join(root, "stage-executions.jsonl"), "utf8"))
        .toBe(`${JSON.stringify(stage)}\n`);
      expect(await readFile(join(root, "pairs.jsonl"), "utf8"))
        .toBe(`${JSON.stringify(pair)}\n`);
      expect(await readFile(join(root, "run-identity.json"), "utf8"))
        .toContain('"planSha256": "aaaaaaaa');
      await expect(ledger.appendStageExecution(stage)).rejects.toThrow(
        "duplicate C5 stage execution",
      );
      await expect(ledger.appendPair(pair)).rejects.toThrow(
        "duplicate C5 pair result",
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects evidence outside the frozen plan", async () => {
    const root = await mkdtemp(join(tmpdir(), "goodmemory-c5-ledger-"));
    try {
      const plan = await pilotPlan();
      const ledger = await openC5EvidenceLedger({
        directory: root,
        identity: { runId: "c5-ledger-scope", schemaVersion: 1 },
        plan,
      });
      await expect(ledger.appendStageExecution({
        ...stageExecution(plan),
        stageRunId: "outside/frozen/plan",
      })).rejects.toThrow("C5 stage execution is outside the frozen plan");
      await expect(ledger.appendPair({
        ...pairResult(plan),
        clusterId: "outside-cluster",
      })).rejects.toThrow("C5 pair result is outside the frozen plan");
      await expect(ledger.appendStageExecution({
        ...stageExecution(plan),
        stageEvidenceSha256: "unbound",
      })).rejects.toThrow("C5 stage execution is outside the frozen plan");
      const pair = pairResult(plan);
      pair.evaluations[0]!.evaluationEvidenceSha256 = "unbound";
      await expect(ledger.appendPair(pair)).rejects.toThrow(
        "C5 pair result has unbound evidence",
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("resumes a 71-process interruption by preserving and retrying only the partial cluster", async () => {
    const root = await mkdtemp(join(tmpdir(), "goodmemory-c5-ledger-resume-"));
    try {
      const plan = await pilotPlan();
      const identity = {
        planSha256: SHA,
        runId: "c5-ledger-resume",
        schemaVersion: 1,
      };
      const ledger = await openC5EvidenceLedger({
        directory: root,
        identity,
        plan,
      });
      const orderedStages = orderedStageExecutions(plan);
      const orderedPairs = orderedPairResults(plan);
      for (const [index, cluster] of plan.clusters.slice(0, 11).entries()) {
        for (const execution of orderedStages.slice(index * 6, (index + 1) * 6)) {
          await ledger.appendStageExecution(execution);
        }
        for (const pair of orderedPairs.slice(index * 3, (index + 1) * 3)) {
          await ledger.appendPair(pair);
        }
        await ledger.commitCluster(cluster.id);
      }
      for (const execution of orderedStages.slice(66, 71)) {
        await ledger.appendStageExecution(execution);
      }
      for (const pair of orderedPairs.slice(33, 35)) {
        await ledger.appendPair(pair);
      }
      const interruptedCluster = plan.clusters[11]!;
      const artifactPath = join(
        root,
        "trajectories",
        sha256(interruptedCluster.id).slice(0, 16),
        "goodmemory-installed",
        "stage-3",
        "stage-execution.sanitized.json",
      );
      await mkdir(join(artifactPath, ".."), { recursive: true });
      await writeFile(artifactPath, '{"partial":true}\n', "utf8");

      const resumed = await openC5EvidenceLedger({
        directory: root,
        identity,
        plan,
        resume: true,
      });

      expect(resumed.stageExecutions).toHaveLength(66);
      expect(resumed.pairs).toHaveLength(33);
      expect(resumed.remainingClusterIds).toEqual([interruptedCluster.id]);
      expect(lines(await readFile(join(root, "stage-executions.jsonl"), "utf8")))
        .toHaveLength(66);
      expect(lines(await readFile(join(root, "pairs.jsonl"), "utf8")))
        .toHaveLength(33);
      const attempts = lines(await readFile(
        join(root, "run-attempts.jsonl"),
        "utf8",
      )).map((line) => JSON.parse(line) as {
        attemptEvidencePath: string;
        clusterId: string;
      });
      expect(attempts).toHaveLength(1);
      expect(attempts[0]!.clusterId).toBe(interruptedCluster.id);
      const attempt = JSON.parse(await readFile(
        join(root, attempts[0]!.attemptEvidencePath),
        "utf8",
      )) as {
        artifacts: Array<{ bytesBase64: string; path: string; sha256: string }>;
        pairRows: unknown[];
        stageRows: unknown[];
      };
      expect(attempt.stageRows).toHaveLength(5);
      expect(attempt.pairRows).toHaveLength(2);
      expect(attempt.artifacts).toContainEqual({
        bytesBase64: Buffer.from('{"partial":true}\n').toString("base64"),
        path: `trajectories/${sha256(interruptedCluster.id).slice(0, 16)}/goodmemory-installed/stage-3/stage-execution.sanitized.json`,
        sha256: sha256('{"partial":true}\n'),
      });
      await resumed.appendStageExecution(orderedStages[66]!);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("recovers a torn cluster-commit tail as an interrupted cluster", async () => {
    const root = await mkdtemp(join(tmpdir(), "goodmemory-c5-ledger-torn-commit-"));
    try {
      const plan = await pilotPlan();
      const identity = { runId: "c5-ledger-torn-commit", schemaVersion: 1 };
      const ledger = await openC5EvidenceLedger({ directory: root, identity, plan });
      for (const execution of orderedStageExecutions(plan).slice(0, 6)) {
        await ledger.appendStageExecution(execution);
      }
      for (const pair of orderedPairResults(plan).slice(0, 3)) {
        await ledger.appendPair(pair);
      }
      await writeFile(
        join(root, "cluster-commits.jsonl"),
        '{"clusterId":',
        { encoding: "utf8", flag: "a" },
      );

      const resumed = await openC5EvidenceLedger({
        directory: root,
        identity,
        plan,
        resume: true,
      });

      expect(resumed.stageExecutions).toEqual([]);
      expect(resumed.pairs).toEqual([]);
      expect(resumed.remainingClusterIds[0]).toBe(plan.clusters[0]!.id);
      expect(await readFile(join(root, "cluster-commits.jsonl"), "utf8")).toBe("");
      const attemptRow = JSON.parse(lines(await readFile(
        join(root, "run-attempts.jsonl"),
        "utf8",
      ))[0]!) as { attemptEvidencePath: string };
      const attempt = JSON.parse(await readFile(
        join(root, attemptRow.attemptEvidencePath),
        "utf8",
      )) as { commitTornTail: { sha256: string } | null };
      expect(attempt.commitTornTail?.sha256).toBe(sha256('{"clusterId":'));
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("inserts a record boundary after a complete final row without LF", async () => {
    const root = await mkdtemp(join(tmpdir(), "goodmemory-c5-ledger-no-lf-"));
    try {
      const plan = await pilotPlan();
      const ledger = await openC5EvidenceLedger({
        directory: root,
        identity: { runId: "c5-ledger-no-lf", schemaVersion: 1 },
        plan,
      });
      const [first, second] = orderedStageExecutions(plan);
      await ledger.appendStageExecution(first!);
      await writeFile(
        join(root, "stage-executions.jsonl"),
        JSON.stringify(first),
        "utf8",
      );

      await ledger.appendStageExecution(second!);

      expect(lines(await readFile(
        join(root, "stage-executions.jsonl"),
        "utf8",
      ))).toEqual([JSON.stringify(first), JSON.stringify(second)]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("reconciles an orphan attempt receipt after a crash before ledger append", async () => {
    const root = await mkdtemp(join(tmpdir(), "goodmemory-c5-ledger-orphan-attempt-"));
    try {
      const plan = await pilotPlan();
      const identity = { runId: "c5-ledger-orphan-attempt", schemaVersion: 1 };
      const ledger = await openC5EvidenceLedger({ directory: root, identity, plan });
      for (const execution of orderedStageExecutions(plan).slice(0, 5)) {
        await ledger.appendStageExecution(execution);
      }
      for (const pair of orderedPairResults(plan).slice(0, 2)) {
        await ledger.appendPair(pair);
      }
      const partialStages = await readFile(
        join(root, "stage-executions.jsonl"),
        "utf8",
      );
      const partialPairs = await readFile(join(root, "pairs.jsonl"), "utf8");

      await openC5EvidenceLedger({ directory: root, identity, plan, resume: true });
      await writeFile(join(root, "stage-executions.jsonl"), partialStages, "utf8");
      await writeFile(join(root, "pairs.jsonl"), partialPairs, "utf8");
      await writeFile(join(root, "run-attempts.jsonl"), "", "utf8");

      const resumed = await openC5EvidenceLedger({
        directory: root,
        identity,
        plan,
        resume: true,
      });

      expect(resumed.stageExecutions).toEqual([]);
      expect(lines(await readFile(join(root, "run-attempts.jsonl"), "utf8")))
        .toHaveLength(1);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
  it("commits a Level-2 cluster only after its eight stage rows and four pairs are durable", async () => {
    const root = await mkdtemp(join(tmpdir(), "goodmemory-c5-ledger-level2-"));
    try {
      const plan = await level2PilotPlan();
      const cluster = plan.clusters[0]!;
      const stages = orderedStageExecutions(plan).slice(0, 8);
      const pairs = orderedPairResults(plan).slice(0, 4);
      expect(stages.every((stage) => stage.clusterId === cluster.id)).toBe(true);
      expect(pairs.every((pair) => pair.clusterId === cluster.id)).toBe(true);
      const ledger = await openC5EvidenceLedger({
        directory: root,
        identity: {
          planSha256: SHA,
          runId: "c5-ledger-level2-fixture",
          schemaVersion: 1,
        },
        plan,
      });

      for (const stage of stages.slice(0, 6)) await ledger.appendStageExecution(stage);
      for (const pair of pairs.slice(0, 3)) await ledger.appendPair(pair);
      await expect(ledger.commitCluster(cluster.id)).rejects.toThrow(
        "C5 cluster cannot commit before all exact rows are durable",
      );
      for (const stage of stages.slice(6)) await ledger.appendStageExecution(stage);
      await ledger.appendPair(pairs[3]!);
      await ledger.commitCluster(cluster.id);

      expect(lines(await readFile(join(root, "cluster-commits.jsonl"), "utf8")))
        .toHaveLength(1);
      const resumed = await openC5EvidenceLedger({
        directory: root,
        identity: {
          planSha256: SHA,
          runId: "c5-ledger-level2-fixture",
          schemaVersion: 1,
        },
        plan,
        resume: true,
      });
      expect(resumed.remainingClusterIds).toHaveLength(plan.clusters.length - 1);
      expect(resumed.remainingClusterIds[0]).toBe(plan.clusters[1]!.id);
      expect(resumed.stageExecutions).toHaveLength(8);
      expect(resumed.pairs).toHaveLength(4);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

async function level2PilotPlan() {
  const loaded = await loadCodexCodingEffectDataset(
    join(
      REPOSITORY_ROOT,
      "fixtures/codex-coding-effect/level2-controlled-mutation",
    ),
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
    join(
      REPOSITORY_ROOT,
      "fixtures/codex-coding-effect/c4-controlled-pilot",
    ),
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

function stageExecution(
  plan: Awaited<ReturnType<typeof pilotPlan>>,
): C5RecordedStageExecution {
  const run = plan.episodeArmRuns[0]!;
  const stage = run.stages[0]!;
  return {
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
      ? "not-applicable"
      : "passed",
    repetition: run.repetition,
    stageEvidenceSha256: SHA,
    stageId: stage.stageId,
    stageRunId: stage.id,
    threadId: `thread-${stage.stageRunIdentitySha256}`,
  };
}

function pairResult(
  plan: Awaited<ReturnType<typeof pilotPlan>>,
): C5LongitudinalPairResult {
  const cluster = plan.clusters[0]!;
  const stage = plan.episodeArmRuns.find((run) =>
    run.clusterId === cluster.id
  )!.stages[0]!;
  return {
    clusterId: cluster.id,
    comparable: true,
    episodeId: cluster.episodeId,
    evaluations: [
      {
        arm: "no-memory",
        disposition: "finalized",
        evaluationEvidenceSha256: SHA,
        resolved: false,
        taskFailureReasons: ["hidden-fail-to-pass-failed"],
      },
      {
        arm: "goodmemory-installed",
        disposition: "finalized",
        evaluationEvidenceSha256: SHA,
        resolved: true,
        taskFailureReasons: [],
      },
    ],
    incomparabilityReasons: [],
    leakageAuditSha256: SHA,
    memoryExpectation: stage.memoryExpectation,
    outcome: "rescue",
    repetition: cluster.repetition,
    stageId: stage.stageId,
  };
}

function orderedStageExecutions(
  plan: Awaited<ReturnType<typeof pilotPlan>>,
): C5RecordedStageExecution[] {
  return plan.clusters.flatMap((cluster) => {
    const runs = cluster.armOrder.map((arm) => plan.episodeArmRuns.find((run) =>
      run.clusterId === cluster.id && run.arm === arm
    )!);
    return runs[0]!.stages.flatMap((_, stageIndex) => runs.map((run) => {
      const stage = run.stages[stageIndex]!;
      return stageExecutionFor(run, stage);
    }));
  });
}

function orderedPairResults(
  plan: Awaited<ReturnType<typeof pilotPlan>>,
): C5LongitudinalPairResult[] {
  return plan.clusters.flatMap((cluster) => {
    const run = plan.episodeArmRuns.find((candidate) =>
      candidate.clusterId === cluster.id
    )!;
    return run.stages.map((stage) => pairResultFor(cluster, stage));
  });
}

function stageExecutionFor(
  run: Awaited<ReturnType<typeof pilotPlan>>["episodeArmRuns"][number],
  stage: Awaited<ReturnType<typeof pilotPlan>>["episodeArmRuns"][number]["stages"][number],
): C5RecordedStageExecution {
  return {
    ...stageExecution({ episodeArmRuns: [run] } as Awaited<ReturnType<typeof pilotPlan>>),
    arm: run.arm,
    clusterId: run.clusterId,
    episodeId: run.episodeId,
    memoryChannelStatus: run.arm === "no-memory" ? "not-applicable" : "passed",
    memoryObservation: run.arm === "no-memory" ? null : {
      injectedRecordCount: 0,
      irrelevantInjection: false,
      recalledPriorMemoryCount: 0,
      writebackCommitted: false,
      writtenMemoryCount: 0,
    },
    repetition: run.repetition,
    stageId: stage.stageId,
    stageRunId: stage.id,
    threadId: `thread-${stage.stageRunIdentitySha256}`,
  };
}

function pairResultFor(
  cluster: Awaited<ReturnType<typeof pilotPlan>>["clusters"][number],
  stage: Awaited<ReturnType<typeof pilotPlan>>["episodeArmRuns"][number]["stages"][number],
): C5LongitudinalPairResult {
  return {
    clusterId: cluster.id,
    comparable: true,
    episodeId: cluster.episodeId,
    evaluations: [
      {
        arm: "no-memory",
        disposition: "finalized",
        evaluationEvidenceSha256: SHA,
        resolved: false,
        taskFailureReasons: ["hidden-fail-to-pass-failed"],
      },
      {
        arm: "goodmemory-installed",
        disposition: "finalized",
        evaluationEvidenceSha256: SHA,
        resolved: true,
        taskFailureReasons: [],
      },
    ],
    incomparabilityReasons: [],
    leakageAuditSha256: SHA,
    memoryExpectation: stage.memoryExpectation,
    outcome: "rescue",
    repetition: cluster.repetition,
    stageId: stage.stageId,
  };
}

function lines(value: string): string[] {
  return value.trim().length === 0 ? [] : value.trim().split("\n");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
