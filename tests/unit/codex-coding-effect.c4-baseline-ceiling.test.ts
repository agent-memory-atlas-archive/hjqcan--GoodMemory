import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertC4BaselineCeilingReportBindings,
  buildC4BaselineStageEvidenceBindings,
  buildC4BaselineCeilingTargets,
  buildC4BaselinePrompt,
  runC4AdaptiveBaselineCeiling,
  verifyC4BaselineStageEvidenceFiles,
  buildC4BaselineCeilingPlan,
} from "../../scripts/codex-coding-effect/c4-baseline-ceiling";
import type {
  C4BaselineCeilingReport,
  C4BaselineCeilingTarget,
  C4BaselineFrozenStageBinding,
  C4BaselineStageEvidenceFile,
  C4BaselineStageResult,
} from "../../scripts/codex-coding-effect/c4-baseline-ceiling";
import { loadCodexCodingEffectDataset } from "../../scripts/codex-coding-effect/dataset";
import {
  assertC4BaselinePathIsolation,
  parseC4BaselineOptions,
  persistC4BaselinePublication,
  runC4BaselineCli,
} from "../../scripts/run-codex-coding-effect-c4-baseline-ceiling";

const PLAN = buildC4BaselineCeilingPlan(targets(), { targetLabel: "all-episodes" });

describe("Codex coding-effect C4 baseline ceiling", () => {
  it("stops after six stage-3 calls when no-memory reaches the ceiling", async () => {
    const calls: string[] = [];
    const report = await runC4AdaptiveBaselineCeiling({
      executeStage: async (target) => {
        calls.push(`${target.episodeId}/${target.stageId}`);
        return result(target, true);
      },
      runIdentity: identity("ceiling-high"),
      targets: targets(),
    });

    expect(() => assertC4BaselineCeilingReportBindings(report, PLAN)).not.toThrow();
    expect(() => assertC4BaselineCeilingReportBindings({
      ...report,
      model: "drifted-model",
    }, PLAN)).toThrow("C4 baseline run identity hash is inconsistent");
    expect(() => assertC4BaselineCeilingReportBindings({
      ...report,
      stageTimeoutMs: report.stageTimeoutMs + 1,
    }, PLAN)).toThrow("C4 baseline run identity hash is inconsistent");
    expect(() => assertC4BaselineCeilingReportBindings({
      ...report,
      results: report.results.map((result, index) =>
        index === 0
          ? { ...result, stageEvidenceSha256: "f".repeat(64) }
          : result
      ),
    }, PLAN)).toThrow("C4 baseline stage evidence aggregate is inconsistent");
    expect(() => assertC4BaselineCeilingReportBindings({
      ...report,
      decision: "proceed-to-c5-pilot",
    }, PLAN)).toThrow("C4 baseline ceiling decision is inconsistent");
    const stageEvidenceFiles = evidenceFiles(report);
    expect(() => verifyC4BaselineStageEvidenceFiles(
      report,
      stageEvidenceFiles,
      frozenBindings(report),
      rawEvidenceFiles(report),
    )).not.toThrow();
    expect(stageEvidenceFiles.every((file) =>
      Object.keys(JSON.parse(file.bytes) as Record<string, unknown>)
        .sort()
        .join(",") === "evidence,rawStageEvidenceSha256,result,schemaVersion"
    )).toBe(true);
    expect(stageEvidenceFiles.every((file) => {
      const binding = JSON.parse(file.bytes) as {
        evidence: {
          codex: { failureEventCount: number };
          dataset: { stageInputSha256: string };
          evaluator: {
            sandbox: {
              evaluatorRead: boolean;
              networkDenied: boolean;
              originalAuthDenied: boolean;
            };
          };
        };
        rawStageEvidenceSha256: string;
        schemaVersion: number;
      };
      return binding.schemaVersion === 2 &&
        binding.rawStageEvidenceSha256.length === 64 &&
        binding.evidence.codex.failureEventCount === 0 &&
        binding.evidence.dataset.stageInputSha256.length === 64 &&
        binding.evidence.evaluator.sandbox.evaluatorRead &&
        binding.evidence.evaluator.sandbox.networkDenied &&
        binding.evidence.evaluator.sandbox.originalAuthDenied;
    })).toBe(true);
    expect(stageEvidenceFiles.some((file) =>
      file.bytes.includes("/Users/")
    )).toBe(false);
    expect(() => verifyC4BaselineStageEvidenceFiles(
      report,
      stageEvidenceFiles.map((file, index) =>
        index === 0
          ? { ...file, bytes: file.bytes.replace("src/tasks.ts", "src/drift.ts") }
          : file
      ),
      frozenBindings(report),
      rawEvidenceFiles(report),
    )).toThrow("does not match authenticated raw source");
    expect(() => verifyC4BaselineStageEvidenceFiles(
      report,
      stageEvidenceFiles.slice(1),
      frozenBindings(report),
      rawEvidenceFiles(report),
    )).toThrow("C4 baseline stage evidence file set is inconsistent");
    const semanticMutations: Array<
      (evidence: Record<string, unknown>) => void
    > = [
      (evidence) => {
        evidence.arm = null;
      },
      (evidence) => {
        (evidence.arm as Record<string, unknown>).permissionIsolationPassed =
          false;
      },
      (evidence) => {
        (evidence.codex as Record<string, unknown>).exitCode = 37;
      },
      (evidence) => {
        (evidence.codex as Record<string, unknown>).timedOut = true;
      },
      (evidence) => {
        (evidence.codex as Record<string, unknown>).failureEventCount = 1;
      },
      (evidence) => {
        const evaluator = evidence.evaluator as Record<string, unknown>;
        evaluator.commitments = [];
      },
      (evidence) => {
        const evaluator = evidence.evaluator as Record<string, unknown>;
        evaluator.materializedAfterCodexExit = false;
      },
      (evidence) => {
        const evaluator = evidence.evaluator as Record<string, unknown>;
        (evaluator.sandbox as Record<string, unknown>).evaluatorRead = false;
      },
      (evidence) => {
        const evaluator = evidence.evaluator as Record<string, unknown>;
        (evaluator.failToPass as Record<string, unknown>).exitCode = 99;
      },
      (evidence) => {
        const patch = evidence.patch as Record<string, unknown>;
        patch.forbiddenFiles = ["evaluator/hidden.test.ts"];
        patch.untrackedFiles = [{
          path: "evaluator/hidden.test.ts",
          sha256: "7".repeat(64),
          size: 1,
        }];
      },
      (evidence) => {
        evidence.visibleBaseHealth = null;
      },
    ];
    for (const mutate of semanticMutations) {
      const semanticallyInvalid = stageEvidenceFiles.map((file, index) => {
        if (index !== 0) {
          return file;
        }
        const binding = JSON.parse(file.bytes) as {
          evidence: Record<string, unknown>;
        };
        mutate(binding.evidence);
        return {
          ...file,
          bytes: `${JSON.stringify(binding, null, 2)}\n`,
        };
      });
      expect(() => verifyC4BaselineStageEvidenceFiles(
        report,
        semanticallyInvalid,
        frozenBindings(report),
        rawEvidenceFiles(report),
      )).toThrow("does not match authenticated raw source");
    }
    const invalidFailureEventHash = stageEvidenceFiles.map((file, index) => {
      if (index !== 0) {
        return file;
      }
      const binding = JSON.parse(file.bytes) as {
        evidence: { codex: Record<string, unknown> };
      };
      binding.evidence.codex.failureEventsSha256 = "f".repeat(64);
      return { ...file, bytes: `${JSON.stringify(binding, null, 2)}\n` };
    });
    expect(() => verifyC4BaselineStageEvidenceFiles(
      report,
      invalidFailureEventHash,
      frozenBindings(report),
      rawEvidenceFiles(report),
    )).toThrow("does not match authenticated raw source");
    const forgedPromptHash = stageEvidenceFiles.map((file, index) => {
      if (index !== 0) {
        return file;
      }
      const binding = JSON.parse(file.bytes) as {
        evidence: { dataset: { promptSha256: string } };
      };
      binding.evidence.dataset.promptSha256 = "9".repeat(64);
      return { ...file, bytes: `${JSON.stringify(binding, null, 2)}\n` };
    });
    expect(() => verifyC4BaselineStageEvidenceFiles(
      report,
      forgedPromptHash,
      frozenBindings(report),
      rawEvidenceFiles(report),
    )).toThrow("does not match authenticated raw source");
    const forgedRawFiles = rawEvidenceFiles(report).map((file, index) => {
      if (index !== 0) return file;
      const evidence = JSON.parse(file.bytes) as {
        dataset: { promptSha256: string };
      };
      evidence.dataset.promptSha256 = "9".repeat(64);
      return { ...file, bytes: `${JSON.stringify(evidence, null, 2)}\n` };
    });
    const forgedResults = report.results.map((result, index) =>
      index === 0
        ? { ...result, stageEvidenceSha256: sha256(forgedRawFiles[0]!.bytes) }
        : result
    );
    const forgedReport = {
      ...report,
      results: forgedResults,
      stageEvidenceAggregateSha256: sha256(JSON.stringify(
        forgedResults.map((result) => ({
          path: `${result.episodeId}-${result.stageId}/stage-evidence.json`,
          sha256: result.stageEvidenceSha256,
        })),
      )),
    };
    expect(() => buildC4BaselineStageEvidenceBindings(
      forgedReport,
      forgedRawFiles,
      frozenBindings(report),
    )).toThrow("C4 baseline finalized evidence is semantically invalid");
    expect(calls).toHaveLength(6);
    expect(calls.every((call) => call.endsWith("/stage-3"))).toBe(true);
    expect(report).toMatchObject({
      attemptedCount: 6,
      ceilingRisk: true,
      decision: "redesign-episodes-before-c5",
      infrastructureFailureCount: 0,
      manifestSha256: "c".repeat(64),
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
      resolvedCount: 6,
      runIdentitySha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      stageEvidenceAggregateSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      stageTimeoutMs: 900_000,
      testTimeoutMs: 300_000,
    });
    expect(report.rounds).toHaveLength(1);
    expect(report.publicClaimEligible).toBe(false);
  });

  it("adds only stage 2 when the first six calls stay below the early ceiling", async () => {
    const calls: string[] = [];
    const report = await runC4AdaptiveBaselineCeiling({
      executeStage: async (target) => {
        calls.push(`${target.episodeId}/${target.stageId}`);
        const episode = Number(target.episodeId.slice("episode-".length));
        return result(target, episode <= 4);
      },
      runIdentity: identity("ceiling-low"),
      targets: targets(),
    });

    expect(calls).toHaveLength(12);
    expect(calls.slice(0, 6).every((call) => call.endsWith("/stage-3")))
      .toBe(true);
    expect(calls.slice(6).every((call) => call.endsWith("/stage-2")))
      .toBe(true);
    expect(report).toMatchObject({
      attemptedCount: 12,
      ceilingRisk: false,
      decision: "proceed-to-c5-pilot",
      resolvedCount: 8,
    });
    expect(report.rounds).toHaveLength(2);
  });

  it("marks the diagnostic inconclusive when a live stage has infrastructure failure", async () => {
    const report = await runC4AdaptiveBaselineCeiling({
      executeStage: async (target) =>
        target.episodeId === "episode-1"
          ? {
              ...result(target, false),
              disposition: "infrastructure-failure",
              executionFailureStage: "codex-launch",
            }
          : result(target, false),
      runIdentity: identity("ceiling-inconclusive"),
      targets: targets(),
    });

    expect(report).toMatchObject({
      ceilingRisk: null,
      decision: "inconclusive",
      infrastructureFailureCount: 1,
    });
  });

  it("selects only later-stage targets from all six controlled episodes", async () => {
    const loaded = await loadCodexCodingEffectDataset(
      "fixtures/codex-coding-effect/c4-controlled-pilot",
    );
    const selected = buildC4BaselineCeilingTargets(loaded.dataset);

    expect(selected).toHaveLength(12);
    expect(selected.filter((target) => target.position === 2)).toHaveLength(6);
    expect(selected.filter((target) => target.position === 3)).toHaveLength(6);
    expect(selected.every((target) => target.position > 1)).toBe(true);
  });

  it("adds only declared user-visible feedback to the frozen stage prompt", () => {
    const prompt = buildC4BaselinePrompt({
      allowedFeedback: ["Use the validated first-delimiter pattern."],
      prompt: "Repair the parser.",
    });

    expect(prompt).toBe([
      "Repair the parser.",
      "",
      "Prior user-visible feedback:",
      "Use the validated first-delimiter pattern.",
    ].join("\n"));
  });

  it("pins the low-cost pilot defaults unless explicitly overridden", () => {
    const options = parseC4BaselineOptions([
      "--run-id=c4-baseline-test",
      "--stage-timeout-ms=1234",
    ]);

    expect(options).toMatchObject({
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
      runId: "c4-baseline-test",
      stageTimeoutMs: 1234,
    });
    expect(() => parseC4BaselineOptions([
      "--run-id=c4-baseline-test",
      "--unknown=value",
    ])).toThrow("unknown C4 baseline option --unknown");
    expect(() => parseC4BaselineOptions([
      "--run-id=first",
      "--run-id=second",
    ])).toThrow("duplicate C4 baseline option --run-id");
    expect(() => parseC4BaselineOptions([
      "--run-id=../escape",
    ])).toThrow("--run-id must be one safe path segment");
  });

  it("rejects output paths that overlap frozen inputs or disposable work roots", () => {
    const options = parseC4BaselineOptions([
      "--run-id=c4-baseline-test",
      "--dataset-root=/tmp/c4-dataset",
      "--output-root=/tmp/c4-output",
      "--publication-output=/tmp/c4-dataset/baseline",
      "--work-root=/tmp/c4-work",
    ]);

    expect(() => assertC4BaselinePathIsolation(options)).toThrow(
      "C4 baseline publication overlaps the frozen dataset",
    );
  });

  it("rejects report paths that reach the frozen dataset through a symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "goodmemory-c4-paths-"));
    const datasetRoot = join(root, "dataset");
    const datasetAlias = join(root, "dataset-alias");
    try {
      await mkdir(datasetRoot);
      await symlink(datasetRoot, datasetAlias, "dir");
      const options = parseC4BaselineOptions([
        "--run-id=c4-baseline-test",
        `--dataset-root=${datasetRoot}`,
        `--output-root=${join(root, "output")}`,
        `--publication-output=${join(datasetAlias, "baseline")}`,
        `--work-root=${join(root, "work")}`,
        `--auth-file=${join(root, "auth.json")}`,
      ]);

      expect(() => assertC4BaselinePathIsolation(options)).toThrow(
        "C4 baseline publication overlaps the frozen dataset",
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("validates physical paths before creating the owned work root", async () => {
    const root = await mkdtemp(join(tmpdir(), "goodmemory-c4-cli-paths-"));
    const datasetRoot = join(root, "dataset");
    const datasetAlias = join(root, "dataset-alias");
    const workRoot = join(datasetAlias, "work");
    try {
      await mkdir(datasetRoot);
      await symlink(datasetRoot, datasetAlias, "dir");

      await expect(runC4BaselineCli([
        "--run-id=c4-baseline-test",
        `--dataset-root=${datasetRoot}`,
        `--output-root=${join(root, "output")}`,
        `--publication-output=${join(root, "baseline")}`,
        `--work-root=${workRoot}`,
        `--auth-file=${join(root, "auth.json")}`,
      ])).rejects.toThrow(
        "C4 baseline frozen dataset overlaps disposable work root",
      );
      expect(await Bun.file(workRoot).exists()).toBe(false);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("publishes report and stage evidence as one replaceable bundle", async () => {
    const root = await mkdtemp(join(tmpdir(), "goodmemory-c4-publication-"));
    const publication = join(root, "baseline");
    try {
      await mkdir(join(publication, "stages", "old-stage"), {
        recursive: true,
      });
      await Promise.all([
        writeFile(join(publication, "report.json"), "old-report\n", "utf8"),
        writeFile(
          join(publication, "stages", "old-stage", "stage-evidence.json"),
          "old-stage\n",
          "utf8",
        ),
      ]);

      await expect(persistC4BaselinePublication({
        files: [
          { bytes: "first\n", path: "new-stage/stage-evidence.json" },
          { bytes: "duplicate\n", path: "new-stage/stage-evidence.json" },
        ],
        path: publication,
        replace: true,
        reportBytes: "new-report\n",
      })).rejects.toThrow();

      expect(await readFile(join(publication, "report.json"), "utf8")).toBe(
        "old-report\n",
      );
      expect(await readFile(
        join(publication, "stages", "old-stage", "stage-evidence.json"),
        "utf8",
      )).toBe("old-stage\n");

      await persistC4BaselinePublication({
        files: [
          { bytes: "new-stage\n", path: "new-stage/stage-evidence.json" },
        ],
        path: publication,
        replace: true,
        reportBytes: "new-report\n",
      });
      expect(await readFile(join(publication, "report.json"), "utf8")).toBe(
        "new-report\n",
      );
      expect(await readFile(
        join(publication, "stages", "new-stage", "stage-evidence.json"),
        "utf8",
      )).toBe("new-stage\n");
      expect(await Bun.file(
        join(publication, "stages", "old-stage", "stage-evidence.json"),
      ).exists()).toBe(false);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

function targets(): C4BaselineCeilingTarget[] {
  return Array.from({ length: 6 }, (_, index) => {
    const episodeId = `episode-${index + 1}`;
    return [
      {
        episodeId,
        position: 2,
        stageId: "stage-2",
        stageInputSha256: sha256(`${episodeId}/stage-2`),
      } satisfies
        C4BaselineCeilingTarget,
      {
        episodeId,
        position: 3,
        stageId: "stage-3",
        stageInputSha256: sha256(`${episodeId}/stage-3`),
      } satisfies
        C4BaselineCeilingTarget,
    ];
  }).flat();
}

function identity(runId: string) {
  return {
    assetLockSha256: "a".repeat(64),
    assetRootSha256: "b".repeat(64),
    claimBoundary: "diagnostic-no-memory-ceiling-only" as const,
    codexExecutableSha256: "d".repeat(64),
    codexVersion: "codex-cli 0.144.5",
    datasetSnapshotMode: "asset-locked-copy" as const,
    datasetId: "codex-c4-controlled-pilot-v2",
    generatedAt: "2026-07-16T08:00:00.000Z",
    host: "codex" as const,
    manifestSha256: "c".repeat(64),
    model: "gpt-5.6-sol",
    networkAccess: false as const,
    publicClaimEligible: false as const,
    reasoningEffort: "xhigh",
    runId,
    schemaVersion: 2 as const,
    stageTimeoutMs: 900_000,
    strategy: "stage-3-first-then-stage-2-if-needed" as const,
    testTimeoutMs: 300_000,
  };
}

function result(
  target: C4BaselineCeilingTarget,
  resolved: boolean,
) {
  const diff = resolved
    ? "diff --git a/src/tasks.ts b/src/tasks.ts\n+resolved\n"
    : "";
  const result = {
    changedFiles: resolved ? ["src/tasks.ts"] : [],
    codexStatus: "completed" as const,
    disposition: "finalized" as const,
    episodeId: target.episodeId,
    executionFailureStage: null,
    failToPassStatus: resolved ? "passed" as const : "failed" as const,
    passToPassStatus: "passed" as const,
    patchSha256: resolved ? sha256(diff) : null,
    resolved,
    stageId: target.stageId,
    stageInputSha256: target.stageInputSha256,
    taskFailureReasons: resolved ? [] : ["no-patch"],
    threadId: `${target.episodeId}-${target.stageId}`,
  };
  return {
    ...result,
    stageEvidenceSha256: sha256(rawStageEvidenceBytes(result, diff)),
  };
}

function evidenceFiles(
  report: C4BaselineCeilingReport,
): C4BaselineStageEvidenceFile[] {
  return buildC4BaselineStageEvidenceBindings(
    report,
    rawEvidenceFiles(report),
    frozenBindings(report),
  );
}

function frozenBindings(
  report: C4BaselineCeilingReport,
): C4BaselineFrozenStageBinding[] {
  return report.results.map((result) => ({
    episodeId: result.episodeId,
    evaluatorCommitments: [
      { relativePath: "cases.json", sha256: "a".repeat(64) },
      { relativePath: "runner.ts", sha256: "b".repeat(64) },
    ],
    promptSha256: "1".repeat(64),
    repositoryCommit: "2".repeat(40),
    repositoryTree: "3".repeat(40),
    stageId: result.stageId,
  }));
}

function rawEvidenceFiles(
  report: C4BaselineCeilingReport,
): C4BaselineStageEvidenceFile[] {
  return report.results.map((stage) => ({
      bytes: rawStageEvidenceBytes(
        stageEvidenceResult(stage),
        stage.patchSha256 === null
          ? ""
          : "diff --git a/src/tasks.ts b/src/tasks.ts\n+resolved\n",
      ),
      path: `${stage.episodeId}-${stage.stageId}/stage-evidence.json`,
    }));
}

function rawStageEvidenceBytes(
  result: Omit<C4BaselineStageResult, "stageEvidenceSha256">,
  diff: string,
): string {
  return `${JSON.stringify({
    arm: {
      absenceAudit: {
        passed: true,
      },
      codexExecutableSha256: "d".repeat(64),
      codexVersion: "codex-cli 0.144.5",
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
      promptSha256: "1".repeat(64),
      repositoryCommit: "2".repeat(40),
      repositoryTree: "3".repeat(40),
      snapshot: "2".repeat(40),
      stageId: result.stageId,
      stageInputSha256: result.stageInputSha256,
    },
    evaluator: {
      commitments: [
        { relativePath: "cases.json", sha256: "a".repeat(64) },
        { relativePath: "runner.ts", sha256: "b".repeat(64) },
      ],
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
      baseCommit: "2".repeat(40),
      changedFiles: result.changedFiles,
      diff,
      forbiddenFiles: [],
      hasPatch: result.patchSha256 !== null,
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

function stageEvidenceResult(
  stage: C4BaselineStageResult,
): Omit<C4BaselineStageResult, "stageEvidenceSha256"> {
  const { stageEvidenceSha256: _, ...result } = stage;
  return result;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
