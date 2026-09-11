import { describe, expect, it, setDefaultTimeout } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  persistC5EvidenceVerification,
  projectC5RunEvidence,
  runC5EvidenceGate,
  serializeC5EvidenceVerification,
  verifyC5EvidenceProjection,
} from "../../../scripts/codex-coding-effect/c5-evidence";
import type {
  C5EvidenceProjectionManifest,
} from "../../../scripts/codex-coding-effect/c5-evidence";
import type {
  C5LongitudinalPairResult,
  C5RecordedStageExecution,
} from "../../../scripts/codex-coding-effect/c5-longitudinal";
import {
  buildC5FlatSummaryHistory,
  buildC5FlatSummaryHookConfig,
  resolveC5FlatSummaryInjection,
} from "../../../scripts/codex-coding-effect/c5-flat-summary-arm";
import {
  serializeC5PilotPlan,
} from "../../../scripts/codex-coding-effect/c5-pilot-plan";
import type {
  C5BaselineArm,
  C5PilotArm,
  C5PilotEpisodeArmRun,
  C5PilotPlan,
  C5PilotStageRun,
} from "../../../scripts/codex-coding-effect/c5-pilot-plan";
import {
  buildC5PilotReport,
  serializeC5PilotReport,
} from "../../../scripts/codex-coding-effect/c5-reporting";
import {
  buildC5IndependentReviewDispatch,
  buildC5IndependentReviewProvenance,
  buildC5IndependentReviewSpawnMessage,
  buildC5ReviewInputBundle,
  buildC5ReviewRequest,
  serializeC5ReviewArtifact,
} from "../../../scripts/codex-coding-effect/c5-review-artifacts";
import {
  c4RepositoryIdForUrl,
  materializeC4SourceRepository,
} from "../../../scripts/codex-coding-effect/c4-controlled-dataset";
import { buildC4BaselinePrompt } from "../../../scripts/codex-coding-effect/c4-baseline-ceiling";
import { buildC3HostConfigurationEvidence } from "../../../scripts/codex-coding-effect/c3-host-configuration";
import type {
  C4HiddenArtifact,
  C4LeakageSurface,
} from "../../../scripts/codex-coding-effect/c4-leakage";
import { buildC5StageLeakageInput } from "../../../scripts/codex-coding-effect/c5-leakage-input";
import {
  hashC5ComparableHostEnvironment,
  parseC5HostEnvironment,
} from "../../../scripts/codex-coding-effect/c5-host-environment";
import {
  auditC5LiveLeakageSurfaces,
} from "../../../scripts/codex-coding-effect/c5-live-leakage";
import type { C5TrajectoryOriginReceipt } from "../../../scripts/codex-coding-effect/c5-live-leakage";
import { loadCodexCodingEffectDataset } from "../../../scripts/codex-coding-effect/dataset";
import { loadC5PilotReadiness } from "../../../scripts/codex-coding-effect/c5-readiness";
import {
  withAcceptedC4ReadinessFixture,
} from "../../support/codex-coding-effect-c4-readiness-fixture";

const SHA = "a".repeat(64);
const GIT_OBJECT = "b".repeat(40);
const GENERATED_AT = "2026-07-16T00:00:00.000Z";
const RUN_ID = "c5-evidence-fixture";
const COMPARATOR = {
  summaryEndpointSha256: sha256("https://summary.test/v1/chat/completions"),
  summaryModel: "summary-test",
  summaryPromptSha256: sha256("summary prompt"),
};
const FLAT_SUMMARY_HOOKS_NORMALIZED = buildC5FlatSummaryHookConfig({
  runnerPath: "/arm-root/flat-summary-hook.mjs",
}).replaceAll("/arm-root/", "<arm-root>/");
setDefaultTimeout(300_000);
const REQUIRED_ALIAS_LABELS = [
  "current-runtime-auth",
  "evaluator-runner",
  "gold-patch",
  "installed-package",
  "other-arm-workspace",
  "source-auth",
] as const;
describe("Codex coding-effect C5 evidence closure", () => {
  it("projects the complete sanitized allowlist and accepts independent verification plus review gate", async () => {
    const root = await mkdtemp(join(tmpdir(), "goodmemory-c5-evidence-"));
    try {
      const fixture = await createRawFixture(root);
      const projection = join(root, "projection");
      const manifest = await projectC5RunEvidence({
        outputDirectory: projection,
        rawRunDirectory: fixture.raw,
      });

      expect(manifest.files).toHaveLength(394);
      expect(manifest.files.some((file) => file.path.endsWith("agent.patch")))
        .toBe(true);
      expect(manifest.files.some((file) =>
        file.path.endsWith("codex-rollout.sanitized.jsonl")
      )).toBe(true);
      expect(manifest.files.some((file) =>
        file.path.endsWith("permission-isolation-preflight.json")
      )).toBe(false);
      expect(manifest.files.some((file) =>
        file.path.includes("auth.json") ||
        file.path.includes("raw-transcript") ||
        file.path === "evaluator/runner.ts"
      )).toBe(false);

      const verification = await verifyC5EvidenceProjection({
        projectionDirectory: projection,
      });
      expect(verification).toMatchObject({
        checks: {
          actualFileHashesVerified: true,
          exactPlanTopologyVerified: true,
          hostPreflightVerified: true,
          noInfrastructureFailure: true,
          noLeakageRejection: true,
          noMemoryChannelFailure: true,
          noSilentFallback: true,
          reportRecomputed: true,
        },
        counts: {
          hostPreflights: 12,
          opaqueProcessOnlyTrajectoryOrigins: 36,
          pairs: 36,
          projectedFiles: 394,
          stageExecutions: 72,
          taskAliasAudits: 24,
        },
        decision: "accepted",
        externalAuthenticityVerified: false,
        publicClaimEligible: false,
        runId: RUN_ID,
      });
      const verificationPath = join(projection, "c5-verification.json");
      await persistC5EvidenceVerification({
        path: verificationPath,
        verification,
      });
      await writeReviewArtifacts({ manifest, projection, verification });

      const gate = await runC5EvidenceGate({ projectionDirectory: projection });
      expect(gate).toMatchObject({
        decision: "accepted",
        publicClaimEligible: false,
        publicCodingEffectProof: false,
        reasons: [],
        runId: RUN_ID,
      });
      expect(gate.independentReviewSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(gate.reviewProvenanceSha256).toMatch(/^[a-f0-9]{64}$/u);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("projects and verifies a flat-summary comparator run without its summary text", async () => {
    const root = await mkdtemp(join(tmpdir(), "goodmemory-c5-comparator-evidence-"));
    try {
      const fixture = await createRawFixture(root, { baselineArm: "flat-summary" });
      expect(fixture.plan.arms).toEqual(["flat-summary", "goodmemory-installed"]);
      const projection = join(root, "projection");
      const manifest = await projectC5RunEvidence({
        outputDirectory: projection,
        rawRunDirectory: fixture.raw,
      });

      expect(manifest.files).toHaveLength(430);
      expect(manifest.files.filter((file) =>
        file.path.endsWith("/flat-summary/injection.sanitized.json")
      )).toHaveLength(36);
      expect(manifest.files.some((file) =>
        file.path.endsWith("summary.txt") || file.path.endsWith("history.txt")
      )).toBe(false);

      const verification = await verifyC5EvidenceProjection({
        projectionDirectory: projection,
      });
      expect(verification.decision).toBe("accepted");
      expect(verification.reasons).toEqual([]);
      expect(verification.counts).toMatchObject({
        opaqueProcessOnlyTrajectoryOrigins: 72,
        pairs: 36,
        projectedFiles: 430,
        stageExecutions: 72,
      });
      const report = JSON.parse(
        await readFile(join(projection, "report.json"), "utf8"),
      ) as {
        comparatorInjection: Record<string, number> | null;
        effect: { baselineArm: string; baselineResolveRate: number | null };
      };
      expect(report.effect.baselineArm).toBe("flat-summary");
      expect(report.effect.baselineResolveRate).toBe(0);
      expect(report.comparatorInjection).toMatchObject({
        contentInjectionCount: 24,
        hookCanaryFailureCount: 0,
        zeroInjectionCount: 12,
      });
      expect(report.comparatorInjection!.injectedTokensTotal).toBeGreaterThan(0);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("projects a summarizer outage as an incomparable pair with a scored infrastructure failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "goodmemory-c5-comparator-outage-"));
    try {
      const fixture = await createRawFixture(root, { baselineArm: "flat-summary" });
      const before = await readLeakageTarget(fixture, 3);
      const withheldOrigin = (before.audit.trajectoryOrigins as Array<Record<string, unknown>>)
        .find((origin) => origin.id === "stage-2:flat-summary:codex-jsonl-output")!;
      await makeFlatSummaryStageNotStarted(fixture);
      const projection = join(root, "projection");
      const manifest = await projectC5RunEvidence({
        outputDirectory: projection,
        rawRunDirectory: fixture.raw,
      });
      expect(manifest.files).toHaveLength(429);
      const verification = await verifyC5EvidenceProjection({
        projectionDirectory: projection,
      });
      expect(verification.decision).toBe("accepted");
      expect(verification.checks.noInfrastructureFailure).toBe(false);
      expect(verification.checks.noLeakageRejection).toBe(true);
      const report = JSON.parse(
        await readFile(join(projection, "report.json"), "utf8"),
      ) as {
        comparatorInjection: Record<string, number>;
        effect: { comparablePairs: number };
        pairs: { incomparableCount: number };
      };
      expect(report.pairs.incomparableCount).toBe(1);
      expect(report.effect.comparablePairs).toBe(35);
      expect(report.comparatorInjection).toMatchObject({
        contentInjectionCount: 23,
        hookCanaryFailureCount: 1,
        zeroInjectionCount: 12,
      });
      const target = await readLeakageTarget(fixture, 3);
      const origins = target.audit.trajectoryOrigins as Array<Record<string, unknown>>;
      origins.push(withheldOrigin);
      origins.sort((first, second) => String(first.id).localeCompare(String(second.id)));
      target.audit.trajectoryOriginAuditSha256 = sha256(JSON.stringify(origins));
      bindAuditHash(target.audit);
      await replaceLeakageEvidence(fixture, target, target.audit);
      await expect(projectC5RunEvidence({
        outputDirectory: join(root, "not-started-stdout-origin"), rawRunDirectory: fixture.raw,
      })).rejects.toThrow(/invalid trajectory origin receipt/u);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects a comparator receipt whose injected content drifted from the audited surface", async () => {
    const root = await mkdtemp(join(tmpdir(), "goodmemory-c5-comparator-drift-"));
    try {
      const fixture = await createRawFixture(root, { baselineArm: "flat-summary" });
      const run = fixture.plan.episodeArmRuns.find((candidate) =>
        candidate.arm === "flat-summary"
      )!;
      const stage = run.stages[1]!;
      const stagePath = join(
        fixture.raw,
        "trajectories",
        clusterDigest(run.clusterId),
        run.arm,
        stage.stageId,
        "stage-execution.sanitized.json",
      );
      const evidence = JSON.parse(await readFile(stagePath, "utf8")) as {
        execution: { comparatorInjection: { injectedContentSha256: string } };
      };
      evidence.execution.comparatorInjection.injectedContentSha256 =
        "c".repeat(64);
      await writeJson(stagePath, evidence);
      await rebindStageEvidenceAndReport(fixture, stage.id, stagePath, {
        execution: evidence.execution,
      });

      await expect(projectC5RunEvidence({
        outputDirectory: join(root, "projection"),
        rawRunDirectory: fixture.raw,
      })).rejects.toThrow(/budget receipt|live surface/u);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects a flat-summary pair that hides a failed hook canary", async () => {
    const root = await mkdtemp(join(tmpdir(), "goodmemory-c5-comparator-hook-"));
    try {
      const fixture = await createRawFixture(root, { baselineArm: "flat-summary" });
      const run = fixture.plan.episodeArmRuns.find((candidate) =>
        candidate.arm === "flat-summary"
      )!;
      const stage = run.stages[2]!;
      const stagePath = join(
        fixture.raw,
        "trajectories",
        clusterDigest(run.clusterId),
        run.arm,
        stage.stageId,
        "stage-execution.sanitized.json",
      );
      const evidence = JSON.parse(await readFile(stagePath, "utf8")) as {
        execution: { comparatorInjection: { hookEvaluationPassed: boolean } };
      };
      evidence.execution.comparatorInjection.hookEvaluationPassed = false;
      await writeJson(stagePath, evidence);
      await rebindStageEvidenceAndReport(fixture, stage.id, stagePath, {
        execution: evidence.execution,
      });

      await expect(projectC5RunEvidence({
        outputDirectory: join(root, "projection"),
        rawRunDirectory: fixture.raw,
      })).rejects.toThrow(/incomparability was not reproduced/u);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects a flat-summary baseline whose hook configuration is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "goodmemory-c5-comparator-hooks-"));
    try {
      const fixture = await createRawFixture(root, { baselineArm: "flat-summary" });
      const cluster = fixture.plan.clusters[3]!;
      const preflightPath = join(
        fixture.raw,
        "trajectories",
        clusterDigest(cluster.id),
        "host-preflight.sanitized.json",
      );
      const preflight = JSON.parse(await readFile(preflightPath, "utf8")) as {
        arms: Array<{ arm: string; noMemoryAbsence: { hookConfigPresent: boolean } | null }>;
      };
      preflight.arms.find((arm) => arm.arm === "flat-summary")!
        .noMemoryAbsence!.hookConfigPresent = false;
      await writeJson(preflightPath, preflight);

      await expect(projectC5RunEvidence({
        outputDirectory: join(root, "projection"),
        rawRunDirectory: fixture.raw,
      })).rejects.toThrow(/flat-summary arm contains GoodMemory or prior session state/u);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects normalized host configuration drift across clusters after rebinding local receipts", async () => {
    const root = await mkdtemp(join(tmpdir(), "goodmemory-c5-host-drift-"));
    try {
      const fixture = await createRawFixture(root);
      const cluster = fixture.plan.clusters[0]!;
      const preflightPath = join(
        fixture.raw,
        "trajectories",
        clusterDigest(cluster.id),
        "host-preflight.sanitized.json",
      );
      const preflight = JSON.parse(await readFile(preflightPath, "utf8")) as {
        hostEnvironment: ReturnType<typeof c5HostEnvironment>;
        hostIdentity: Record<string, unknown> & {
          comparableHostEnvironmentSha256: string;
        };
        hostIdentitySha256: string;
      };
      const installed =
        preflight.hostEnvironment.configurations.arms.goodmemoryInstalled;
      const configurations = buildC3HostConfigurationEvidence({
        goodmemoryInstalled: {
          ...installed,
          goodmemoryConfig: {
            ...installed.goodmemoryConfig!,
            normalizedText: '{"writebackMode":"disabled"}',
          },
        },
        noMemory: preflight.hostEnvironment.configurations.arms.noMemory,
      });
      const driftedEnvironment = parseC5HostEnvironment({
        ...preflight.hostEnvironment,
        configurations,
      });
      preflight.hostEnvironment = driftedEnvironment;
      preflight.hostIdentity.comparableHostEnvironmentSha256 =
        hashC5ComparableHostEnvironment(driftedEnvironment);
      preflight.hostIdentitySha256 = sha256(
        JSON.stringify(preflight.hostIdentity),
      );
      await writeJson(preflightPath, preflight);

      await expect(projectC5RunEvidence({
        outputDirectory: join(root, "projection"),
        rawRunDirectory: fixture.raw,
      })).rejects.toThrow("host identity drifted across the 12 cluster preflights");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects a post-projection mutation of the actual agent patch", async () => {
    const root = await mkdtemp(join(tmpdir(), "goodmemory-c5-patch-mutation-"));
    try {
      const fixture = await createRawFixture(root);
      const projection = join(root, "projection");
      const manifest = await projectC5RunEvidence({
        outputDirectory: projection,
        rawRunDirectory: fixture.raw,
      });
      const patchPath = manifest.files.find((file) =>
        file.path.endsWith("agent.patch")
      )!.path;
      await writeFile(join(projection, ...patchPath.split("/")), "mutated\n");

      const verification = await verifyC5EvidenceProjection({
        projectionDirectory: projection,
      });
      expect(verification.decision).toBe("rejected");
      expect(verification.reasons.join(" ")).toContain("hash mismatch");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("projects a fully accounted infrastructure failure without survivor filtering", async () => {
    const root = await mkdtemp(join(tmpdir(), "goodmemory-c5-failure-evidence-"));
    try {
      const fixture = await createRawFixture(root);
      await makeFirstInstalledStageFail(fixture);
      const projection = join(root, "projection");
      const manifest = await projectC5RunEvidence({
        outputDirectory: projection,
        rawRunDirectory: fixture.raw,
      });
      const verification = await verifyC5EvidenceProjection({
        projectionDirectory: projection,
      });

      expect(manifest.files).toHaveLength(394);
      expect(verification.decision).toBe("accepted");
      expect(verification.checks.noInfrastructureFailure).toBe(false);
      expect(verification.checks.noMemoryChannelFailure).toBe(false);
      expect(verification.counts.stageExecutions).toBe(72);
      expect(verification.counts.pairs).toBe(36);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("projects and independently verifies interrupted resume attempts", async () => {
    const root = await mkdtemp(join(tmpdir(), "goodmemory-c5-resume-evidence-"));
    try {
      const fixture = await createRawFixture(root);
      await addInterruptedAttempt(fixture);
      const projection = join(root, "projection");
      const manifest = await projectC5RunEvidence({
        outputDirectory: projection,
        rawRunDirectory: fixture.raw,
      });
      const verification = await verifyC5EvidenceProjection({
        projectionDirectory: projection,
      });

      expect(manifest.files).toHaveLength(395);
      expect(manifest.files.some((file) =>
        file.path.endsWith("attempt.sanitized.json")
      )).toBe(true);
      expect(verification.decision).toBe("accepted");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("projects a pre-cluster interrupted attempt with no partial artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "goodmemory-c5-pre-cluster-evidence-"));
    try {
      const fixture = await createRawFixture(root);
      await addInterruptedAttempt(fixture, { empty: true });
      const projection = join(root, "projection");
      const manifest = await projectC5RunEvidence({
        outputDirectory: projection,
        rawRunDirectory: fixture.raw,
      });
      const verification = await verifyC5EvidenceProjection({
        projectionDirectory: projection,
      });

      expect(manifest.files).toHaveLength(395);
      expect(verification.decision).toBe("accepted");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("projects an interrupted empty agent patch with its SHA-256 binding", async () => {
    const root = await mkdtemp(join(tmpdir(), "goodmemory-c5-empty-patch-"));
    try {
      const fixture = await createRawFixture(root);
      await addInterruptedAttempt(fixture, {
        artifactBytes: "",
        artifactName: "agent.patch",
      });
      const projection = join(root, "projection");
      const manifest = await projectC5RunEvidence({
        outputDirectory: projection,
        rawRunDirectory: fixture.raw,
      });
      const verification = await verifyC5EvidenceProjection({
        projectionDirectory: projection,
      });

      expect(manifest.files).toHaveLength(395);
      expect(verification.decision).toBe("accepted");
      expect(verification.counts.stageExecutions).toBe(72);
      expect(verification.counts.pairs).toBe(36);
      const path = manifest.files.find((file) =>
        file.path.endsWith("attempt.sanitized.json")
      )!.path;
      const attempt = JSON.parse(await readFile(join(projection, path), "utf8")) as {
        artifacts: Array<{ bytesBase64: string; path: string; sha256: string }>;
      };
      expect(attempt.artifacts[0]).toMatchObject({
        bytesBase64: "",
        sha256: sha256(""),
      });
      expect(attempt.artifacts[0]!.path).toEndWith("/agent.patch");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects malformed interrupted artifact bytes after outer receipts are rebound", async () => {
    const root = await mkdtemp(join(tmpdir(), "goodmemory-c5-empty-patch-mutations-"));
    try {
      const fixture = await createRawFixture(root);
      await addInterruptedAttempt(fixture, {
        artifactBytes: "",
        artifactName: "agent.patch",
      });
      const ledgerPath = join(fixture.raw, "run-attempts.jsonl");
      const row = JSON.parse(await readFile(ledgerPath, "utf8")) as {
        attemptEvidencePath: string;
        attemptEvidenceSha256: string;
      };
      const evidencePath = join(fixture.raw, row.attemptEvidencePath);
      const original = await readFile(evidencePath, "utf8");
      const mutations = [
        { bytesBase64: null, sha256: sha256("") },
        { bytesBase64: 0, sha256: sha256("") },
        { bytesBase64: "", sha256: sha256("different") },
        { bytesBase64: "!!!", sha256: sha256("") },
        { bytesBase64: "eA==\n", sha256: sha256("x") },
      ];
      for (const [index, mutation] of mutations.entries()) {
        const evidence = JSON.parse(original) as {
          artifacts: Array<Record<string, unknown>>;
        };
        Object.assign(evidence.artifacts[0]!, mutation);
        await writeJson(evidencePath, evidence);
        row.attemptEvidenceSha256 = sha256(await readFile(evidencePath, "utf8"));
        await writeText(ledgerPath, `${JSON.stringify(row)}\n`);

        await expect(projectC5RunEvidence({
          outputDirectory: join(root, `projection-${index}`),
          rawRunDirectory: fixture.raw,
        })).rejects.toThrow(/C5 interrupted artifact/u);
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("projects returned Codex failures without exception hashes and retains incomparability", async () => {
    const root = await mkdtemp(join(tmpdir(), "goodmemory-c5-returned-failure-"));
    try {
      const fixture = await createRawFixture(root);
      await makeReturnedCodexFailures(fixture);
      const projection = join(root, "projection");
      await projectC5RunEvidence({
        outputDirectory: projection,
        rawRunDirectory: fixture.raw,
      });
      const verification = await verifyC5EvidenceProjection({
        projectionDirectory: projection,
      });
      const report = JSON.parse(await readFile(join(projection, "report.json"), "utf8"));

      expect(verification.decision).toBe("accepted");
      expect(verification.checks.noInfrastructureFailure).toBe(false);
      expect(verification.publicClaimEligible).toBe(false);
      expect(verification.counts.stageExecutions).toBe(72);
      expect(verification.counts.pairs).toBe(36);
      expect(report.attempts.infrastructureFailureCount).toBe(5);
      expect(report.pairs.comparableCount).toBe(31);
      expect(report.pairs.incomparableCount).toBe(5);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects unbound returned Codex failures after outer receipts are rebound", async () => {
    const root = await mkdtemp(join(tmpdir(), "goodmemory-c5-returned-failure-mutations-"));
    try {
      const fixture = await createRawFixture(root);
      const [target] = await makeReturnedCodexFailures(fixture);
      const original = await readFile(target!.path, "utf8");
      const mutations: Array<(evidence: ReturnedCodexStageEvidence) => void> = [
        (evidence) => { evidence.failureReasonSha256 = ""; },
        (evidence) => { delete evidence.failureReasonSha256; },
        (evidence) => { evidence.execution.infrastructureFailureStage = "host-canary"; },
        (evidence) => { evidence.execution.codexStatus = "not-started"; },
        (evidence) => { evidence.codex.exitCode = 0; },
        (evidence) => { evidence.events[1]!.details.exitCode = 0; },
        (evidence) => { evidence.events.splice(1, 1); },
        (evidence) => { evidence.events[0]!.details.executableSha256 = "f".repeat(64); },
      ];
      for (const [index, mutate] of mutations.entries()) {
        const evidence = JSON.parse(original) as ReturnedCodexStageEvidence;
        mutate(evidence);
        await writeJson(target!.path, evidence);
        await rebindStageEvidenceAndReport(fixture, target!.stage.id, target!.path, {
          execution: evidence.execution,
        });
        await expect(projectC5RunEvidence({
          outputDirectory: join(root, `projection-${index}`),
          rawRunDirectory: fixture.raw,
        })).rejects.toThrow(index === 1
          ? /stage-execution\.sanitized\.json has an unsupported or missing field/u
          : /C5 (?:stage|returned Codex)/u);
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("discloses claimed timeout stdout origins without asserting inventory completeness", async () => {
    const root = await mkdtemp(join(tmpdir(), "goodmemory-c5-timeout-origins-"));
    try {
      const fixture = await createRawFixture(root, { baselineArm: "flat-summary" });
      const targets = await makeTimeoutOriginFixture(fixture);
      const reportBefore = await readFile(join(fixture.raw, "report.json"), "utf8");
      const projection = join(root, "projection");
      await projectC5RunEvidence({ outputDirectory: projection, rawRunDirectory: fixture.raw });
      const verification = await verifyC5EvidenceProjection({ projectionDirectory: projection });

      expect(verification.decision).toBe("accepted");
      expect(verification.timeoutStdoutOrigins).toEqual({
        claimedStageRunIds: targets.slice(0, 2).map((target) => target.stage.id).sort(),
        eligibleStageRunIds: targets.map((target) => target.stage.id).sort(),
        existenceAndCompletenessVerified: false,
        liveMatchExemptionAllowed: false,
        originClass: "claimed-timeout-stdout",
        receiptCount: 3,
      });
      expect(verification.checks.noInfrastructureFailure).toBe(false);
      expect(verification.publicClaimEligible).toBe(false);
      expect(verification.externalAuthenticityVerified).toBe(false);
      expect(await readFile(join(projection, "report.json"), "utf8")).toBe(reportBefore);
      expect(await readFile(join(fixture.raw, "report.json"), "utf8")).toBe(reportBefore);
      for (const target of targets) {
        const evidence = JSON.parse(await readFile(target.path, "utf8"));
        expect(evidence.codex)
          .toMatchObject({ eventCount: 0, exitCode: 0, status: "timed-out", usage: null });
        if (evidence.execution.arm === "flat-summary") {
          expect(evidence.execution.comparatorInjection.hookEvaluationPassed).toBe(false);
          const pairs = (await readFile(join(fixture.raw, "pairs.jsonl"), "utf8"))
            .trim().split("\n").map((row) => JSON.parse(row) as C5LongitudinalPairResult);
          expect(pairs.find((pair) => pair.clusterId === fixture.plan.clusters[1]!.id &&
            pair.stageId === target.stage.stageId)!.incomparabilityReasons)
            .toContain("flat-summary-hook-canary-failed");
        } else {
          expect(evidence.canaryEvidenceSha256).toBeNull();
          expect(evidence.execution.memoryObservation).toBeNull();
        }
      }
      const target = await readLeakageTarget(fixture, 3);
      const leakageInput = fixture.leakageInputs.get(
        `${fixture.plan.clusters[0]!.episodeId}/${target.stage.stageId}`,
      )!;
      const id = `${targets[0]!.stage.stageId}:codex-jsonl-output`;
      const emptyOrigin = auditC5LiveLeakageSurfaces({
        artifacts: leakageInput.artifacts,
        liveSurfaces: fixtureLiveSurfaces(""),
        staticSurfaces: leakageInput.staticSurfaces,
        trajectoryOrigins: [{ content: "", id }],
      }).trajectoryOrigins[0]!;
      expect(emptyOrigin.sha256).toBe(sha256(""));
      const origins = target.audit.trajectoryOrigins as Array<{ id: string }>;
      origins[origins.findIndex((origin) => origin.id === id)] = emptyOrigin;
      target.audit.trajectoryOriginAuditSha256 = sha256(JSON.stringify(origins));
      bindAuditHash(target.audit);
      await replaceLeakageEvidence(fixture, target, target.audit);
      await expect(projectC5RunEvidence({
        outputDirectory: join(root, "claimed-empty-stdout"), rawRunDirectory: fixture.raw,
      })).rejects.toThrow(/trajectory origin receipt.*non-empty stdout/u);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects timeout and spawn failure normalization after outer receipts are rebound", async () => {
    const root = await mkdtemp(join(tmpdir(), "goodmemory-c5-timeout-normalization-"));
    try {
      const fixture = await createRawFixture(root);
      const targets = (await makeReturnedCodexFailures(fixture)).slice(1, 3);
      const mutations: Array<(evidence: ReturnedCodexStageEvidence) => void> = [
        (evidence) => { evidence.codex.eventCount = 1; },
        (evidence) => {
          const usage = { cachedInputTokens: 0, inputTokens: 1, outputTokens: 1 };
          evidence.codex.usage = usage;
          evidence.execution.codexUsage = usage;
        },
        (evidence) => { evidence.execution.threadId = "fabricated-thread"; },
      ];
      for (const [targetIndex, target] of targets.entries()) {
        const original = await readFile(target.path, "utf8");
        for (const [index, mutate] of mutations.entries()) {
          const evidence = JSON.parse(original) as ReturnedCodexStageEvidence;
          mutate(evidence);
          await writeJson(target.path, evidence);
          await rebindStageEvidenceAndReport(fixture, target.stage.id, target.path, {
            execution: evidence.execution,
          });
          await expect(projectC5RunEvidence({
            outputDirectory: join(root, `projection-${targetIndex}-${index}`),
            rawRunDirectory: fixture.raw,
          })).rejects.toThrow(/C5 stage .*normalized/u);
        }
        await writeText(target.path, original);
        await rebindStageEvidenceAndReport(fixture, target.stage.id, target.path, {
          execution: (JSON.parse(original) as ReturnedCodexStageEvidence).execution,
        });
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }, 600_000);

  it("never lets a claimed timeout stdout origin newly explain a live match", async () => {
    const root = await mkdtemp(join(tmpdir(), "goodmemory-c5-timeout-live-"));
    try {
      const fixture = await createRawFixture(root, { baselineArm: "flat-summary" });
      await makeTimeoutOriginFixture(fixture);
      const target = await readLeakageTarget(fixture, 3);
      const leakageInput = fixture.leakageInputs.get(
        `${fixture.plan.clusters[0]!.episodeId}/${target.stage.stageId}`,
      )!;
      const originId = `${target.stage.priorStageIds.at(-1)}:codex-jsonl-output`;
      const replacement = auditC5LiveLeakageSurfaces({
        artifacts: leakageInput.artifacts,
        liveSurfaces: fixtureLiveSurfaces(""),
        staticSurfaces: leakageInput.staticSurfaces,
        trajectoryOrigins: [{
          content: leakageInput.artifacts.find((artifact) => artifact.id === "hidden-test-source")!.content,
          id: originId,
        }],
      }).trajectoryOrigins[0]!;
      const audit = target.audit;
      const origins = audit.trajectoryOrigins as C5TrajectoryOriginReceipt[];
      origins[origins.findIndex((origin) => origin.id === originId)] = replacement;
      audit.trajectoryOriginAuditSha256 = sha256(JSON.stringify(origins));
      bindAuditHash(audit);
      await replaceLeakageEvidence(fixture, target, audit);
      // Origin matrices may match hidden fragments without affecting any live
      // surface. This must remain admissible, as in the captured full run.
      const safeProjection = join(root, "origin-only-projection");
      await projectC5RunEvidence({ outputDirectory: safeProjection, rawRunDirectory: fixture.raw });
      expect((await verifyC5EvidenceProjection({ projectionDirectory: safeProjection })).decision)
        .toBe("accepted");

      const originCell = replacement.matrixAuditReceipt.cells.find((cell) =>
        cell.artifactId === "hidden-test-source" &&
        cell.surfaceId === "effective-codex-input-after-seeding"
      )!;
      const mandatoryMatches = new Set(origins.filter((origin) => origin.id !== originId)
        .flatMap((origin) => origin.matrixAuditReceipt.cells.filter((cell) =>
          cell.artifactId === originCell.artifactId && cell.surfaceId === originCell.surfaceId
        ).flatMap((cell) => cell.matchedFragmentSha256)));
      const digest = originCell.matchedFragmentSha256.find((match) => !mandatoryMatches.has(match))!;
      expect(digest).toBeDefined();
      expect(mandatoryMatches.has(digest)).toBe(false);
      const matrix = audit.fullMatrixAuditReceipt as Record<string, unknown>;
      const fullCell = (matrix.cells as Array<Record<string, unknown>>).find((cell) =>
        cell.artifactId === originCell.artifactId && cell.surfaceId === originCell.surfaceId
      )!;
      const liveCell = (audit.liveCells as Array<Record<string, unknown>>).find((cell) =>
        cell.artifactId === originCell.artifactId && cell.surfaceId === originCell.surfaceId
      )!;
      const match = { exactOverlapCount: 1, matchedFragmentSha256: [digest], normalizedOverlapCount: 0, status: "rejected" };
      Object.assign(fullCell, match);
      Object.assign(liveCell, match, {
        originAttestedMatchSha256: [digest], provenanceStatus: "accepted", unexplainedMatchSha256: [],
      });
      matrix.overlapCount = 1;
      matrix.status = "rejected";
      bindMatrixAuditHash(matrix);
      audit.fullMatrixAuditSha256 = matrix.auditSha256;
      audit.liveOverlapCount = 1;
      audit.trajectoryOriginOverlapCount = 1;
      bindAuditHash(audit);
      await replaceLeakageEvidence(fixture, target, audit);
      await expect(projectC5RunEvidence({
        outputDirectory: join(root, "new-live-exemption"), rawRunDirectory: fixture.raw,
      })).rejects.toThrow(/claimed timeout stdout origin newly explains a live match/u);
      // The exact set rule permits a match that a mandatory origin already
      // attests. The optional claim must not receive the credit for explaining it.
      const mandatoryId = `${target.stage.priorStageIds[0]}:codex-jsonl-output`;
      origins[origins.findIndex((origin) => origin.id === mandatoryId)] = {
        ...replacement, id: mandatoryId,
      };
      audit.trajectoryOriginAuditSha256 = sha256(JSON.stringify(origins));
      bindAuditHash(audit);
      await replaceLeakageEvidence(fixture, target, audit);
      const sharedProjection = join(root, "mandatory-and-optional-live-match");
      await projectC5RunEvidence({ outputDirectory: sharedProjection, rawRunDirectory: fixture.raw });
      expect((await verifyC5EvidenceProjection({ projectionDirectory: sharedProjection })).decision)
        .toBe("accepted");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("retains exact mandatory membership and rejects malformed claimed timeout origins", async () => {
    const root = await mkdtemp(join(tmpdir(), "goodmemory-c5-timeout-membership-"));
    try {
      const fixture = await createRawFixture(root, { baselineArm: "flat-summary" });
      await makeTimeoutOriginFixture(fixture);
      const target = await readLeakageTarget(fixture, 3);
      const optionalId = `${target.stage.priorStageIds.at(-1)}:codex-jsonl-output`;
      const mutations: Array<(origins: Array<Record<string, unknown>>) => void> = [
        ...[":effective-prompt", ":agent-patch", ":flat-summary:codex-jsonl-output"].map((suffix) =>
          (origins: Array<Record<string, unknown>>) => {
            origins.splice(origins.findIndex((origin) => String(origin.id).endsWith(suffix)), 1);
          }),
        (origins) => { origins.push({ ...origins.find((origin) => origin.id === optionalId)! }); },
        ...["stage-999:codex-jsonl-output", `${target.stage.stageId}:codex-jsonl-output`,
          "stage-1:no-memory:codex-jsonl-output", `other-cluster/${optionalId}`,
          "stage-01:codex-jsonl-output"].map((id) => (origins: Array<Record<string, unknown>>) => {
          origins.find((origin) => origin.id === optionalId)!.id = id;
        }),
        (origins) => { origins.find((origin) => origin.id === optionalId)!.sha256 = "f".repeat(64); },
        (origins) => {
          const matrix = origins.find((origin) => origin.id === optionalId)!.matrixAuditReceipt as Record<string, unknown>;
          const cell = (matrix.cells as Array<Record<string, unknown>>)[0]!;
          cell.candidateFragmentCount = Number(cell.candidateFragmentCount) + 1;
          bindMatrixAuditHash(matrix);
        },
      ];
      for (const [index, mutate] of mutations.entries()) {
        const audit = structuredClone(target.audit);
        mutate(audit.trajectoryOrigins as Array<Record<string, unknown>>);
        audit.trajectoryOriginAuditSha256 = sha256(JSON.stringify(audit.trajectoryOrigins));
        bindAuditHash(audit);
        await replaceLeakageEvidence(fixture, target, audit);
        await expect(projectC5RunEvidence({
          outputDirectory: join(root, `mutation-${index}`), rawRunDirectory: fixture.raw,
        })).rejects.toThrow(/trajectory origin|not bound|frozen artifact|non-content/u);
      }
      await replaceLeakageEvidence(fixture, target, target.audit);
      const run = fixture.plan.episodeArmRuns.find((candidate) =>
        candidate.clusterId === target.clusterId && candidate.arm === "goodmemory-installed"
      )!;
      // Other zero-event paths do not inherit the returned-timeout permission.
      for (const status of ["spawn-failed", "event-parse-failed"] as const) {
        await makeReturnedCodexFailures(fixture, [{ run, stage: run.stages[1]!, status }]);
        await expect(projectC5RunEvidence({
          outputDirectory: join(root, `ineligible-${status}`), rawRunDirectory: fixture.raw,
        })).rejects.toThrow(/invalid trajectory origin receipt/u);
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }, 600_000);

  it("rejects required recall outside the isolated pre-stage export", async () => {
    const root = await mkdtemp(join(tmpdir(), "goodmemory-c5-recall-binding-"));
    try {
      const fixture = await createRawFixture(root);
      const run = fixture.plan.episodeArmRuns.find((candidate) =>
        candidate.arm === "goodmemory-installed" &&
        candidate.stages.some((stage) => stage.memoryExpectation === "required")
      )!;
      const stage = run.stages.find((candidate) =>
        candidate.memoryExpectation === "required"
      )!;
      await replaceHostCanaryRecall(fixture, run, stage, "not-written-by-stop");

      await expect(projectC5RunEvidence({
        outputDirectory: join(root, "projection"),
        rawRunDirectory: fixture.raw,
      })).rejects.toThrow(/prior native Stop|memory export|recall/u);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects an effective prompt receipt that drifted from the asset-locked fixture", async () => {
    const root = await mkdtemp(join(tmpdir(), "goodmemory-c5-prompt-binding-"));
    try {
      const fixture = await createRawFixture(root);
      const run = fixture.plan.episodeArmRuns.find((candidate) =>
        candidate.arm === "goodmemory-installed"
      )!;
      const stage = run.stages[0]!;
      const stagePath = join(
        fixture.raw,
        "trajectories",
        clusterDigest(run.clusterId),
        run.arm,
        stage.stageId,
        "stage-execution.sanitized.json",
      );
      const evidence = JSON.parse(await readFile(stagePath, "utf8")) as Record<
        string,
        unknown
      >;
      evidence.effectivePromptSha256 = "c".repeat(64);
      await writeJson(stagePath, evidence);
      await rebindStageEvidenceAndReport(fixture, stage.id, stagePath);

      await expect(projectC5RunEvidence({
        outputDirectory: join(root, "projection"),
        rawRunDirectory: fixture.raw,
      })).rejects.toThrow(/prompt drifted from the frozen dataset/u);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects a plan whose projected C4 prerequisite evidence is mutated", async () => {
    const root = await mkdtemp(join(tmpdir(), "goodmemory-c5-c4-prerequisite-"));
    try {
      const fixture = await createRawFixture(root);
      const prerequisitePath = join(
        fixture.raw,
        "c4-prerequisite-evidence.json",
      );
      const prerequisite = JSON.parse(
        await readFile(prerequisitePath, "utf8"),
      ) as { c4ReadinessReportBytes: string };
      const readiness = JSON.parse(prerequisite.c4ReadinessReportBytes) as {
        status: string;
      };
      readiness.status = "rejected";
      prerequisite.c4ReadinessReportBytes = `${JSON.stringify(
        readiness,
        null,
        2,
      )}\n`;
      await writeJson(prerequisitePath, prerequisite);

      await expect(projectC5RunEvidence({
        outputDirectory: join(root, "projection"),
        rawRunDirectory: fixture.raw,
      })).rejects.toThrow(/C4 readiness|prerequisite/u);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects raw evidence when alias isolation or live leakage is mutated", async () => {
    const root = await mkdtemp(join(tmpdir(), "goodmemory-c5-raw-mutation-"));
    try {
      const fixture = await createRawFixture(root);
      const alias = fixture.plan.episodeArmRuns[0]!;
      const aliasPath = join(
        fixture.raw,
        "trajectories",
        clusterDigest(alias.clusterId),
        alias.arm,
        "task-alias-isolation.json",
      );
      const aliasEvidence = JSON.parse(await readFile(aliasPath, "utf8")) as {
        aliases: Array<{ denied: boolean }>;
      };
      aliasEvidence.aliases[0]!.denied = false;
      await writeJson(aliasPath, aliasEvidence);

      await expect(projectC5RunEvidence({
        outputDirectory: join(root, "rejected-alias"),
        rawRunDirectory: fixture.raw,
      })).rejects.toThrow(/hash mismatch|alias-isolation/u);

      const cleanRoot = join(root, "clean-second");
      const second = await createRawFixture(cleanRoot);
      const cluster = second.plan.clusters[0]!;
      const stage = second.plan.episodeArmRuns.find((run) =>
        run.clusterId === cluster.id
      )!.stages[0]!;
      const leakagePath = join(
        second.raw,
        "pairs",
        clusterDigest(cluster.id),
        stage.stageId,
        "live-leakage-audit.json",
      );
      const leakage = JSON.parse(await readFile(leakagePath, "utf8")) as {
        status: string;
      };
      leakage.status = "rejected";
      await writeJson(leakagePath, leakage);
      await expect(projectC5RunEvidence({
        outputDirectory: join(root, "rejected-leakage"),
        rawRunDirectory: second.raw,
      })).rejects.toThrow(/rejected|leakage/u);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects schema v5 leakage provenance mutations after rebinding the evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "goodmemory-c5-leakage-v2-"));
    try {
      const fixture = await createRawFixture(root);
      const target = await readLeakageTarget(fixture, 2);
      const mutations: Array<{
        mutate(audit: Record<string, unknown>): void;
        name: string;
        reason: RegExp;
      }> = [
        {
          mutate: (audit) => {
            audit.schemaVersion = 1;
          },
          name: "schema-downgrade",
          reason: /incompletely audited/u,
        },
        {
          mutate: (audit) => {
            audit.fullMatrixAuditSha256 = "c".repeat(64);
          },
          name: "full-matrix-hash",
          reason: /full matrix receipt hash/u,
        },
        {
          mutate: (audit) => {
            const matrix = audit.fullMatrixAuditReceipt as Record<
              string,
              unknown
            >;
            const fullCell = (matrix.cells as Array<Record<string, unknown>>)
              .find((cell) =>
                cell.surfaceId === "goodmemory-export-after-seeding" &&
                cell.artifactId === "gold-patches"
              )!;
            const liveCell = (audit.liveCells as Array<Record<string, unknown>>)
              .find((cell) =>
                cell.surfaceId === fullCell.surfaceId &&
                cell.artifactId === fullCell.artifactId
              )!;
            fullCell.candidateFragmentCount =
              Number(fullCell.candidateFragmentCount) + 1;
            liveCell.candidateFragmentCount = fullCell.candidateFragmentCount;
            bindMatrixAuditHash(matrix);
            audit.fullMatrixAuditSha256 = matrix.auditSha256;
          },
          name: "coherent-full-matrix-receipt",
          reason: /live matrix drifted from frozen artifacts/u,
        },
        {
          mutate: (audit) => {
            audit.trajectoryOriginAuditSha256 = "c".repeat(64);
          },
          name: "trajectory-audit-hash",
          reason: /trajectory-origin audit hash/u,
        },
        {
          mutate: (audit) => {
            const origins = audit.trajectoryOrigins as Array<
              Record<string, unknown>
            >;
            origins[0]!.id = `${target.stage.stageId}:effective-prompt`;
          },
          name: "current-stage-origin",
          reason: /trajectory origin receipt/u,
        },
        {
          mutate: (audit) => {
            const origins = audit.trajectoryOrigins as Array<
              Record<string, unknown>
            >;
            origins.find((origin) =>
              String(origin.id).endsWith(":effective-prompt")
            )!.sha256 = "c".repeat(64);
          },
          name: "prompt-hash",
          reason: /trajectory origin receipt/u,
        },
        {
          mutate: (audit) => {
            const origins = audit.trajectoryOrigins as Array<
              Record<string, unknown>
            >;
            origins.find((origin) =>
              String(origin.id).endsWith(":agent-patch")
            )!.sha256 = "c".repeat(64);
          },
          name: "patch-hash",
          reason: /trajectory origin receipt/u,
        },
        {
          mutate: (audit) => {
            const origins = audit.trajectoryOrigins as Array<
              Record<string, unknown>
            >;
            origins.find((origin) =>
              String(origin.id).endsWith(":codex-jsonl-output")
            )!.sha256 = "c".repeat(64);
          },
          name: "codex-output-hash-binding",
          reason: /not bound/u,
        },
        {
          mutate: (audit) => {
            const origins = audit.trajectoryOrigins as Array<
              Record<string, unknown>
            >;
            const index = origins.findIndex((origin) =>
              String(origin.id).endsWith(":codex-jsonl-output")
            );
            origins.splice(index, 1);
            audit.trajectoryOriginAuditSha256 = sha256(JSON.stringify(origins));
          },
          name: "missing-codex-output-origin",
          reason: /receipts are incomplete/u,
        },
        {
          mutate: (audit) => {
            const origins = audit.trajectoryOrigins as Array<
              Record<string, unknown>
            >;
            const origin = origins.find((candidate) =>
              String(candidate.id).endsWith(":codex-jsonl-output")
            )!;
            const matrix = origin.matrixAuditReceipt as Record<string, unknown>;
            const cell = (matrix.cells as Array<Record<string, unknown>>)
              .find((candidate) =>
                candidate.surfaceId === "effective-codex-input-after-seeding"
              )!;
            cell.candidateFragmentCount = Number(cell.candidateFragmentCount) + 1;
            bindMatrixAuditHash(matrix);
            audit.trajectoryOriginAuditSha256 = sha256(JSON.stringify(origins));
          },
          name: "codex-output-origin-matrix",
          reason: /drifted from frozen artifacts/u,
        },
        {
          mutate: (audit) => {
            const origins = audit.trajectoryOrigins as Array<
              Record<string, unknown>
            >;
            const matrix = origins[0]!.matrixAuditReceipt as Record<
              string,
              unknown
            >;
            const cell = (matrix.cells as Array<Record<string, unknown>>)[0]!;
            cell.candidateFragmentCount = Number(cell.candidateFragmentCount) + 1;
            bindMatrixAuditHash(matrix);
            audit.trajectoryOriginAuditSha256 = sha256(JSON.stringify(origins));
          },
          name: "origin-matrix-receipt",
          reason: /matrix was not recomputed/u,
        },
        {
          mutate: (audit) => {
            const cell = (audit.liveCells as Array<Record<string, unknown>>)[0]!;
            cell.exactOverlapCount = 1;
            cell.matchedFragmentSha256 = ["c".repeat(64)];
            cell.status = "rejected";
            audit.liveOverlapCount = 1;
          },
          name: "partition",
          reason: /live matrix claims an unknown candidate/u,
        },
        {
          mutate: (audit) => {
            audit.trajectoryOriginOverlapCount = 1;
          },
          name: "origin-count",
          reason: /leakage result/u,
        },
        {
          mutate: (audit) => {
            const digest = "c".repeat(64);
            const cell = (audit.liveCells as Array<Record<string, unknown>>)[0]!;
            cell.exactOverlapCount = 1;
            cell.matchedFragmentSha256 = [digest];
            cell.provenanceStatus = "rejected";
            cell.status = "rejected";
            cell.unexplainedMatchSha256 = [digest];
            audit.liveOverlapCount = 1;
            audit.unexplainedLiveOverlapCount = 1;
          },
          name: "accepted-unexplained-overlap",
          reason: /unknown candidate|leakage cell|leakage result/u,
        },
      ];

      for (const mutation of mutations) {
        const audit = JSON.parse(JSON.stringify(target.audit)) as Record<
          string,
          unknown
        >;
        mutation.mutate(audit);
        bindAuditHash(audit);
        await replaceLeakageEvidence(fixture, target, audit);
        await expect(projectC5RunEvidence({
          outputDirectory: join(root, `projection-${mutation.name}`),
          rawRunDirectory: fixture.raw,
        })).rejects.toThrow(mutation.reason);
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }, 600_000);

  it("accepts a strictly bound schema v5 infrastructure-rejected leakage variant", async () => {
    const root = await mkdtemp(join(tmpdir(), "goodmemory-c5-leakage-failure-"));
    try {
      const fixture = await createRawFixture(root);
      const target = await readLeakageTarget(fixture, 2);
      const audit: Record<string, unknown> = {
        failureReasonSha256: sha256("host canary did not produce live surfaces"),
        schemaVersion: 5,
        status: "rejected",
        variant: "infrastructure-rejected",
      };
      bindAuditHash(audit);
      await replaceLeakageEvidence(fixture, target, audit, true);

      const projection = join(root, "projection");
      await projectC5RunEvidence({
        outputDirectory: projection,
        rawRunDirectory: fixture.raw,
      });
      const verification = await verifyC5EvidenceProjection({
        projectionDirectory: projection,
      });
      expect(verification.decision).toBe("accepted");
      expect(verification.checks.noLeakageRejection).toBe(false);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects a missing scheduled attempt before creating a projection", async () => {
    const root = await mkdtemp(join(tmpdir(), "goodmemory-c5-missing-attempt-"));
    try {
      const fixture = await createRawFixture(root);
      const ledgerPath = join(fixture.raw, "stage-executions.jsonl");
      const rows = (await readFile(ledgerPath, "utf8")).trim().split("\n");
      await writeText(ledgerPath, `${rows.slice(1).join("\n")}\n`);

      await expect(projectC5RunEvidence({
        outputDirectory: join(root, "projection"),
        rawRunDirectory: fixture.raw,
      })).rejects.toThrow("cluster commit is not bound");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects a sanitized rollout that no longer matches its host-canary hash", async () => {
    const root = await mkdtemp(join(tmpdir(), "goodmemory-c5-rollout-mutation-"));
    try {
      const fixture = await createRawFixture(root);
      const run = fixture.plan.episodeArmRuns.find((candidate) =>
        candidate.arm === "goodmemory-installed"
      )!;
      const stage = run.stages[0]!;
      const rolloutPath = join(
        fixture.raw,
        "trajectories",
        clusterDigest(run.clusterId),
        run.arm,
        stage.stageId,
        "host-canary",
        "codex-rollout.sanitized.jsonl",
      );
      await writeText(
        rolloutPath,
        `${await readFile(rolloutPath, "utf8")}{"mutated":true}\n`,
      );

      await expect(projectC5RunEvidence({
        outputDirectory: join(root, "projection"),
        rawRunDirectory: fixture.raw,
      })).rejects.toThrow("sanitized transcript hash");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects single-sided live-source receipt mutations after rebinding outer evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "goodmemory-c5-source-receipts-"));
    try {
      const fixture = await createRawFixture(root);
      const run = fixture.plan.episodeArmRuns.find((candidate) =>
        candidate.arm === "goodmemory-installed" &&
        candidate.stages.some((stage) => stage.memoryExpectation === "required")
      )!;
      const stage = run.stages.find((candidate) =>
        candidate.memoryExpectation === "required"
      )!;
      const stageRoot = join(
        fixture.raw,
        "trajectories",
        clusterDigest(run.clusterId),
        run.arm,
        stage.stageId,
      );
      const canaryPath = join(
        stageRoot,
        "host-canary",
        "host-canary.sanitized.json",
      );
      const stagePath = join(stageRoot, "stage-execution.sanitized.json");
      const leakageTarget = {
        clusterId: run.clusterId,
        path: join(
          fixture.raw,
          "pairs",
          clusterDigest(run.clusterId),
          stage.stageId,
          "live-leakage-audit.json",
        ),
        stage,
      };
      const originalCanary = JSON.parse(
        await readFile(canaryPath, "utf8"),
      ) as Record<string, unknown>;
      const originalAudit = JSON.parse(
        await readFile(leakageTarget.path, "utf8"),
      ) as Record<string, unknown>;
      const mutations: Array<{
        mutate(input: {
          audit: Record<string, unknown>;
          canary: Record<string, unknown>;
        }): "audit" | "canary";
        name: string;
        reason: RegExp;
      }> = [
        {
          mutate: ({ canary }) => {
            const result = canary.canary as Record<string, unknown>;
            const contexts = result.hookContexts as Array<Record<string, unknown>>;
            contexts[0]!.contentHash = `content:${"c".repeat(24)}`;
            return "canary";
          },
          name: "hook-content-hash",
          reason: /hook context hash is not derived/u,
        },
        {
          mutate: ({ canary }) => {
            const receipts = canary.sourceReceipts as Record<string, unknown>;
            const injection = receipts.injection as Record<string, unknown>;
            injection.sourceSha256 = "c".repeat(64);
            return "canary";
          },
          name: "injection-source-binding",
          reason: /injection source receipt is not bound/u,
        },
        {
          mutate: ({ canary }) => {
            const receipts = canary.sourceReceipts as Record<string, unknown>;
            const memoryExport = receipts.memoryExport as Record<string, unknown>;
            memoryExport.semanticSurfaceCommitmentSha256 = "c".repeat(64);
            return "canary";
          },
          name: "memory-export-semantic-commitment",
          reason: /live semantic surface is not source-bound/u,
        },
        {
          mutate: ({ canary }) => {
            const receipts = canary.sourceReceipts as Record<string, unknown>;
            const memoryExport = receipts.memoryExport as Record<string, unknown>;
            memoryExport.recordIds = [];
            return "canary";
          },
          name: "memory-export-missing-stop-lineage",
          reason: /prior-memory lineage|prior native Stop/u,
        },
        {
          mutate: ({ audit }) => {
            const receipts = audit.liveSurfaceReceipts as Array<
              Record<string, unknown>
            >;
            const exported = receipts.find((receipt) =>
              receipt.id === "goodmemory-export-after-seeding"
            )!;
            exported.utf8Bytes = Number(exported.utf8Bytes) + 1;
            return "audit";
          },
          name: "memory-export-byte-length",
          reason: /live surface claims drifted from host receipts/u,
        },
      ];

      for (const mutation of mutations) {
        const canary = JSON.parse(JSON.stringify(originalCanary)) as Record<
          string,
          unknown
        >;
        const audit = JSON.parse(JSON.stringify(originalAudit)) as Record<
          string,
          unknown
        >;
        const target = mutation.mutate({ audit, canary });
        if (target === "canary") {
          await writeJson(canaryPath, canary);
          await rebindHostCanaryEvidence(fixture, stage.id, stagePath, canaryPath);
        } else {
          bindAuditHash(audit);
          await replaceLeakageEvidence(fixture, leakageTarget, audit);
        }
        await expect(projectC5RunEvidence({
          outputDirectory: join(root, `projection-${mutation.name}`),
          rawRunDirectory: fixture.raw,
        })).rejects.toThrow(mutation.reason);

        await writeJson(canaryPath, originalCanary);
        await rebindHostCanaryEvidence(fixture, stage.id, stagePath, canaryPath);
        await replaceLeakageEvidence(fixture, leakageTarget, originalAudit);
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects forbidden files injected into an otherwise valid projection", async () => {
    const root = await mkdtemp(join(tmpdir(), "goodmemory-c5-forbidden-file-"));
    try {
      const fixture = await createRawFixture(root);
      const projection = join(root, "projection");
      await projectC5RunEvidence({
        outputDirectory: projection,
        rawRunDirectory: fixture.raw,
      });
      await writeText(join(projection, "auth.json"), "forbidden-secret\n");

      const verification = await verifyC5EvidenceProjection({
        projectionDirectory: projection,
      });
      expect(verification.decision).toBe("rejected");
      expect(verification.reasons.join(" ")).toContain("unsupported file");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects runner-source drift and independently recomputed report drift", async () => {
    const root = await mkdtemp(join(tmpdir(), "goodmemory-c5-report-drift-"));
    try {
      const runnerFixture = await createRawFixture(join(root, "runner"));
      const postPath = join(
        runnerFixture.raw,
        "runner-source-state-post-run.json",
      );
      const post = JSON.parse(await readFile(postPath, "utf8")) as {
        files: Array<{ bytes: number }>;
      };
      post.files[0]!.bytes += 1;
      await writeJson(postPath, post);
      await expect(projectC5RunEvidence({
        outputDirectory: join(root, "runner-projection"),
        rawRunDirectory: runnerFixture.raw,
      })).rejects.toThrow("runner source changed");

      const reportFixture = await createRawFixture(join(root, "report"));
      const reportPath = join(reportFixture.raw, "report.json");
      const report = JSON.parse(await readFile(reportPath, "utf8")) as {
        attempts: { accountedCount: number };
      };
      report.attempts.accountedCount = 71;
      await writeJson(reportPath, report);
      await expect(projectC5RunEvidence({
        outputDirectory: join(root, "report-projection"),
        rawRunDirectory: reportFixture.raw,
      })).rejects.toThrow("report attempts");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects review provenance when author and reviewer are not independent", async () => {
    const root = await mkdtemp(join(tmpdir(), "goodmemory-c5-review-mutation-"));
    try {
      const fixture = await createRawFixture(root);
      const projection = join(root, "projection");
      const manifest = await projectC5RunEvidence({
        outputDirectory: projection,
        rawRunDirectory: fixture.raw,
      });
      const verification = await verifyC5EvidenceProjection({
        projectionDirectory: projection,
      });
      await persistC5EvidenceVerification({
        path: join(projection, "c5-verification.json"),
        verification,
      });
      await writeReviewArtifacts({ manifest, projection, verification });
      const provenancePath = join(projection, "review", "provenance.json");
      const provenance = JSON.parse(
        await readFile(provenancePath, "utf8"),
      ) as {
        authorTaskName: string;
        reviewer: { agentName: string };
      };
      provenance.authorTaskName = provenance.reviewer.agentName;
      await writeJson(provenancePath, provenance);

      const gate = await runC5EvidenceGate({ projectionDirectory: projection });
      expect(gate.decision).toBe("rejected");
      expect(gate.reasons.join(" ")).toContain("must differ");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

interface RawFixture {
  leakageInputs: ReadonlyMap<string, {
    artifacts: C4HiddenArtifact[];
    staticSurfaces: C4LeakageSurface[];
  }>;
  plan: C5PilotPlan;
  promptContents: ReadonlyMap<string, string>;
  raw: string;
}

async function createRawFixture(
  root: string,
  options: { baselineArm?: C5BaselineArm } = {},
): Promise<RawFixture> {
  const baselineArm = options.baselineArm ?? "no-memory";
  const raw = join(root, "raw");
  await mkdir(raw, { recursive: true });
  const loaded = await loadCodexCodingEffectDataset(
    "fixtures/codex-coding-effect/c4-controlled-pilot",
  );
  const readiness = await withAcceptedC4ReadinessFixture((fixture) =>
    loadC5PilotReadiness({
      ...fixture.paths,
      ...(baselineArm === "flat-summary"
        ? { baselineArm, comparator: COMPARATOR }
        : {}),
      datasetRoot: "fixtures/codex-coding-effect/c4-controlled-pilot",
      materialEffectPercentagePoints: 10,
      orderSeed: 73,
    })
  );
  const plan = readiness.plan;
  if (loaded.dataset.schemaVersion !== 2) {
    throw new Error("C5 evidence fixture requires the v2 controlled dataset");
  }
  const repositoryRoots = new Map<string, string>();
  const leakageInputs = new Map<string, {
    artifacts: C4HiddenArtifact[];
    staticSurfaces: C4LeakageSurface[];
  }>();
  const promptContents = new Map<string, string>();
  for (const episode of loaded.dataset.episodes) {
    let repositoryRoot = repositoryRoots.get(episode.repository.url);
    if (repositoryRoot === undefined) {
      repositoryRoot = join(
        root,
        "fixture-repositories",
        c4RepositoryIdForUrl(episode.repository.url),
      );
      await materializeC4SourceRepository({
        datasetRoot: "fixtures/codex-coding-effect/c4-controlled-pilot",
        destination: repositoryRoot,
        repositoryId: c4RepositoryIdForUrl(episode.repository.url),
      });
      repositoryRoots.set(episode.repository.url, repositoryRoot);
    }
    for (const stage of episode.stages) {
      const key = `${episode.id}/${stage.id}`;
      promptContents.set(key, buildC4BaselinePrompt({
        allowedFeedback: stage.allowedFeedback,
        prompt: await readFile(
          join(
            "fixtures/codex-coding-effect/c4-controlled-pilot",
            stage.promptPath,
          ),
          "utf8",
        ),
      }));
      leakageInputs.set(
        key,
        await buildC5StageLeakageInput({
          datasetRoot: "fixtures/codex-coding-effect/c4-controlled-pilot",
          episode,
          repositoryRoot,
          stage,
        }),
      );
    }
  }
  const planBytes = serializeC5PilotPlan(plan);
  const planSha256 = sha256(planBytes);
  await Promise.all([
    writeText(
      join(raw, "c4-prerequisite-evidence.json"),
      readiness.prerequisiteEvidenceBytes,
    ),
    writeText(join(raw, "pilot-plan.json"), planBytes),
  ]);

  // The runner closure reaches mixed-case source names; the capture orders
  // them by code point (rerankPool before reranker), which a locale-aware
  // comparison would reject.
  const runnerEntrypointSource =
    'import "../src/recall/rerankPool";\nimport "../src/recall/reranker";\n';
  const runnerFiles = [
    ["bun.lock", "x"],
    ["bunfig.toml", "x"],
    ["package.json", "x"],
    ["scripts/prepare-codex-coding-effect-c5-pilot.ts", "x"],
    ["scripts/run-codex-coding-effect-c5-pilot.ts", runnerEntrypointSource],
    ["src/recall/rerankPool.ts", "x"],
    ["src/recall/reranker.ts", "x"],
    ["tsconfig.json", "x"],
  ].map(([path, source]) => ({
    bytes: Buffer.byteLength(source!, "utf8"),
    path: path!,
    sha256: sha256(source!),
    sourceBase64: Buffer.from(source!).toString("base64"),
  }));
  const runnerSource = {
    aggregateSha256: sha256(`${JSON.stringify(runnerFiles)}\n`),
    files: runnerFiles,
    schemaVersion: 2,
  };
  await Promise.all([
    writeJson(join(raw, "runner-source-state.json"), runnerSource),
    writeJson(join(raw, "runner-source-state-post-run.json"), runnerSource),
  ]);
  await writeJson(join(raw, "run-identity.json"), {
    claimBoundary: "internal-native-longitudinal-pilot-only",
    evidenceClass: "native-longitudinal-pilot",
    generatedAt: GENERATED_AT,
    host: "codex",
    model: "gpt-test",
    mutableRootsSha256: SHA,
    networkAccess: false,
    phase: "C5",
    planSha256,
    publicClaimEligible: false,
    publicCodingEffectProof: false,
    reasoningEffort: "high",
    runId: RUN_ID,
    runnerSourceAggregateSha256: runnerSource.aggregateSha256,
    schemaVersion: 1,
    stageTimeoutMs: 1_000,
    testTimeoutMs: 1_000,
  });

  const stageExecutions: C5RecordedStageExecution[] = [];
  const pairs: C5LongitudinalPairResult[] = [];
  const comparatorSummaries = new Map<string, string>();
  const hostEnvironment = c5HostEnvironment(baselineArm);
  const hostIdentity = {
    ...(baselineArm === "flat-summary" ? { baselineArm } : {}),
    codexExecutableSha256: SHA,
    codexVersion: "codex-test",
    goodMemoryPackageSha256: SHA,
    goodMemoryPackageVersion: "0.6.0",
    comparableHostEnvironmentSha256:
      hashC5ComparableHostEnvironment(hostEnvironment),
    installedProfile: installedProfile(),
    model: "gpt-test",
    reasoningEffort: "high",
  };
  for (const cluster of plan.clusters) {
    const clusterHostEnvironment = withClusterHostConfigurationReceipts(
      hostEnvironment,
      cluster.id,
    );
    const trajectory = join(raw, "trajectories", clusterDigest(cluster.id));
    const runs = plan.episodeArmRuns
      .filter((run) => run.clusterId === cluster.id)
      .sort((first, second) =>
        first.armOrderPosition - second.armOrderPosition
      );
    const armPreflights: Array<Record<string, unknown>> = [];
    for (const run of runs) {
      const armRoot = join(trajectory, run.arm);
      const permission = permissionEvidence();
      const permissionPath = join(
        armRoot,
        "permission-isolation-preflight.sanitized.json",
      );
      await writeJson(permissionPath, permission);
      const alias = aliasEvidence();
      const aliasPath = join(armRoot, "task-alias-isolation.json");
      await writeJson(aliasPath, alias);
      armPreflights.push({
        arm: run.arm,
        instructionSha256: SHA,
        noMemoryAbsence: run.arm === "goodmemory-installed"
          ? null
          : {
              goodMemoryFileCount: 0,
              hookConfigPresent: run.arm === "flat-summary",
              mcpConfigPresent: false,
              passed: true,
              preexistingSessionCount: 0,
            },
        permissionIsolationSha256: sha256(
          await readFile(permissionPath, "utf8"),
        ),
        taskAliasIsolationSha256: sha256(await readFile(aliasPath, "utf8")),
      });

      const priorWrittenMemoryIds: string[] = [];
      for (const [stageIndex, stage] of run.stages.entries()) {
        const writebackRequired = priorWrittenMemoryIds.length === 0 &&
          run.stages.slice(stageIndex + 1).some(
            ({ memoryExpectation }) => memoryExpectation === "required",
          );
        const stageRoot = join(armRoot, stage.stageId);
        const threadId = `thread-${stage.stageRunIdentitySha256}`;
        const patch = agentPatchForStage(stage);
        await writeText(join(stageRoot, "agent.patch"), patch);
        let canaryEvidenceSha256: string | null = null;
        const memoryObservation = run.arm !== "goodmemory-installed"
          ? null
          : memoryObservationFor(stage.memoryExpectation, writebackRequired);
        const comparator = run.arm === "flat-summary"
          ? await writeComparatorStageEvidence({
              promptContents,
              run,
              stageIndex,
              stageRoot,
            })
          : null;
        if (comparator !== null) {
          comparatorSummaries.set(stage.id, comparator.summary);
        }
        if (run.arm === "goodmemory-installed") {
          const transcript = sanitizedTranscript(threadId);
          const transcriptPath = join(
            stageRoot,
            "host-canary",
            "codex-rollout.sanitized.jsonl",
          );
          await writeText(transcriptPath, transcript);
          const canary = hostCanaryEvidence({
            effectivePrompt: requiredPrompt(
              promptContents,
              run.episodeId,
              stage.stageId,
            ),
            expectedPriorMemoryIds: priorWrittenMemoryIds,
            memoryExpectation: stage.memoryExpectation,
            sanitizedTranscriptSha256: sha256(transcript),
            stageId: stage.id,
            writebackRequired,
          });
          const canaryPath = join(
            stageRoot,
            "host-canary",
            "host-canary.sanitized.json",
          );
          await writeJson(canaryPath, canary);
          canaryEvidenceSha256 = sha256(await readFile(canaryPath, "utf8"));
          priorWrittenMemoryIds.push(...canary.canary.currentWrittenMemoryIds);
        }
        const executionBasis = {
          arm: run.arm,
          codexDurationMs: 100,
          codexStatus: "completed",
          codexUsage: {
            cachedInputTokens: 10,
            inputTokens: 20,
            outputTokens: 5,
          },
          ...(comparator === null
            ? {}
            : { comparatorInjection: comparator.injectionRow }),
          infrastructureFailureStage: null,
          memoryObservation,
          memoryChannelStatus: run.arm !== "goodmemory-installed"
            ? "not-applicable" as const
            : "passed" as const,
          stageRunId: stage.id,
          threadId,
        };
        const stageEvidence = {
          canaryEvidenceSha256,
          ...(comparator === null
            ? {}
            : { comparatorEvidenceSha256: comparator.evidenceSha256 }),
          codex: {
            durationMs: 100,
            eventCount: 2,
            exitCode: 0,
            status: "completed",
            timedOut: false,
            usage: executionBasis.codexUsage,
          },
          effectivePromptSha256: sha256(requiredPrompt(
            promptContents,
            run.episodeId,
            stage.stageId,
          )),
          events: stageEvents({
            arm: run.arm,
            episodeId: run.episodeId,
            repetition: run.repetition,
            seed: plan.randomization.orderSeed,
            stageId: stage.stageId,
            stageRunId: stage.id,
          }),
          execution: executionBasis,
          failureReasonSha256: null,
          patch: {
            changedFiles: ["src/index.ts"],
            forbiddenFiles: [],
            hasPatch: true,
            sha256: sha256(patch),
            untrackedFiles: [],
          },
          permissionIsolationSha256: armPreflights.at(-1)!
            .permissionIsolationSha256,
          schemaVersion: 1,
          visibleBaseHealth: {
            durationMs: 10,
            exitCode: 0,
            passed: true,
            status: "passed",
          },
        };
        const stageEvidencePath = join(
          stageRoot,
          "stage-execution.sanitized.json",
        );
        await writeJson(stageEvidencePath, stageEvidence);
        stageExecutions.push({
          ...executionBasis,
          stageEvidenceSha256: sha256(
            await readFile(stageEvidencePath, "utf8"),
          ),
          clusterId: cluster.id,
          episodeId: run.episodeId,
          repetition: run.repetition,
          stageId: stage.stageId,
        });
      }
    }
    await writeJson(join(trajectory, "host-preflight.sanitized.json"), {
      arms: armPreflights,
      clusterId: cluster.id,
      hostEnvironment: clusterHostEnvironment,
      hostIdentity,
      hostIdentitySha256: sha256(JSON.stringify(hostIdentity)),
      networkAccess: false,
      repository: { commit: GIT_OBJECT, tree: GIT_OBJECT },
      schemaVersion: 2,
    });

    const installedRun = runs.find((run) => run.arm === "goodmemory-installed")!;
    const baselineRun = runs.find((run) => run.arm === baselineArm)!;
    for (const stage of runs[0]!.stages) {
      const pairRoot = join(
        raw,
        "pairs",
        clusterDigest(cluster.id),
        stage.stageId,
      );
      const installedStage = installedRun.stages.find((candidate) =>
        candidate.stageId === stage.stageId
      )!;
      const leakage = leakageEvidence({
        ...(baselineArm === "flat-summary"
          ? {
              baselineRun,
              flatSummary: comparatorSummaries.get(
                `${baselineRun.id}/${stage.stageId}`,
              ) ?? "",
            }
          : {}),
        leakageInput: leakageInputs.get(
          `${cluster.episodeId}/${installedStage.stageId}`,
        )!,
        promptContents,
        run: installedRun,
        stage: installedStage,
      });
      await writeJson(join(pairRoot, "live-leakage-audit.json"), leakage);
      const evaluations = [] as C5LongitudinalPairResult["evaluations"];
      for (const arm of [baselineArm, "goodmemory-installed"] as const) {
        const resolved = arm === "goodmemory-installed";
        const reasons = resolved ? [] : ["hidden-fail-to-pass-failed"];
        const evidence = evaluatorEvidence({ arm, reasons, resolved });
        const path = join(pairRoot, `${arm}-evaluation.json`);
        await writeJson(path, evidence);
        evaluations.push({
          arm,
          disposition: "finalized",
          evaluationEvidenceSha256: sha256(await readFile(path, "utf8")),
          resolved,
          taskFailureReasons: reasons,
        });
      }
      pairs.push({
        clusterId: cluster.id,
        comparable: true,
        episodeId: cluster.episodeId,
        evaluations,
        incomparabilityReasons: [],
        leakageAuditSha256: leakage.auditSha256,
        memoryExpectation: stage.memoryExpectation,
        outcome: "rescue",
        repetition: cluster.repetition,
        stageId: stage.stageId,
      });
    }
  }

  await writeText(
    join(raw, "stage-executions.jsonl"),
    `${stageExecutions.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
  await writeText(
    join(raw, "pairs.jsonl"),
    `${pairs.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
  await writeText(
    join(raw, "cluster-commits.jsonl"),
    `${plan.clusters.map((cluster) => JSON.stringify({
      clusterId: cluster.id,
      schemaVersion: 1,
    })).join("\n")}\n`,
  );
  await writeText(join(raw, "run-attempts.jsonl"), "");
  const report = buildC5PilotReport({
    generatedAt: GENERATED_AT,
    plan,
    planSha256,
    result: { pairs, stageExecutions },
    runId: RUN_ID,
  });
  await writeText(join(raw, "report.json"), serializeC5PilotReport(report));

  await Promise.all([
    writeText(join(raw, "auth.json"), "secret-auth-must-not-project\n"),
    writeText(
      join(raw, "raw-transcript.jsonl"),
      '{"raw":"must-not-project"}\n',
    ),
    writeText(
      join(raw, "evaluator", "runner.ts"),
      "throw new Error('hidden evaluator source');\n",
    ),
    writeText(join(raw, "gold.patch"), "hidden gold patch\n"),
    writeText(
      join(
        raw,
        "trajectories",
        clusterDigest(plan.clusters[0]!.id),
        "no-memory",
        "permission-isolation-preflight.json",
      ),
      '{"path":"/private/raw/path"}\n',
    ),
  ]);
  return { leakageInputs, plan, promptContents, raw };
}

// Mirrors a summarizer outage: the flat-summary stage never launched Codex,
// carries no injection receipt, its evaluator scored an infrastructure
// failure, the pair is incomparable, and the next stage's trajectory origins
// no longer include a patch or Codex output for it.
async function makeFlatSummaryStageNotStarted(fixture: RawFixture): Promise<{
  run: C5PilotEpisodeArmRun;
  stage: C5PilotStageRun;
}> {
  const cluster = fixture.plan.clusters[0]!;
  const runs = fixture.plan.episodeArmRuns
    .filter((candidate) => candidate.clusterId === cluster.id)
    .sort((first, second) => first.armOrderPosition - second.armOrderPosition);
  const run = runs.find((candidate) => candidate.arm === "flat-summary")!;
  const installedRun = runs.find((candidate) =>
    candidate.arm === "goodmemory-installed"
  )!;
  const stage = run.stages[1]!;
  const stageRoot = join(
    fixture.raw,
    "trajectories",
    clusterDigest(cluster.id),
    run.arm,
    stage.stageId,
  );
  const stagePath = join(stageRoot, "stage-execution.sanitized.json");
  const evidence = JSON.parse(await readFile(stagePath, "utf8")) as Record<
    string,
    unknown
  > & { execution: Record<string, unknown> };
  evidence.execution = {
    ...evidence.execution,
    codexDurationMs: 0,
    codexStatus: "not-started",
    codexUsage: null,
    comparatorInjection: null,
    infrastructureFailureStage: "flat-summary-injection",
    threadId: null,
  };
  evidence.comparatorEvidenceSha256 = null;
  evidence.codex = {
    durationMs: 0,
    eventCount: 0,
    exitCode: null,
    status: "not-started",
    timedOut: false,
    usage: null,
  };
  evidence.events = [];
  evidence.failureReasonSha256 = sha256(
    "C5 flat-summary provider returned HTTP 502",
  );
  evidence.patch = {
    changedFiles: [],
    forbiddenFiles: [],
    hasPatch: false,
    sha256: null,
    untrackedFiles: [],
  };
  await writeText(join(stageRoot, "agent.patch"), "");
  await rm(join(stageRoot, "flat-summary"), { force: true, recursive: true });
  await writeJson(stagePath, evidence);
  await rebindStageEvidenceAndReport(fixture, stage.id, stagePath, {
    execution: evidence.execution,
  });

  const pairRoot = join(
    fixture.raw,
    "pairs",
    clusterDigest(cluster.id),
    stage.stageId,
  );
  const evaluationPath = join(pairRoot, "flat-summary-evaluation.json");
  const evaluation = JSON.parse(await readFile(evaluationPath, "utf8")) as {
    failToPass: { exitCode: number; status: string };
    score: Record<string, unknown>;
  };
  evaluation.failToPass = { ...evaluation.failToPass, exitCode: 1, status: "failed" };
  evaluation.score = {
    disposition: "infrastructure-failure",
    executionFailureStage: "codex-not-started",
    resolved: false,
    taskFailureReasons: [],
  };
  await writeJson(evaluationPath, evaluation);
  const evaluationSha256 = sha256(await readFile(evaluationPath, "utf8"));
  const pairsPath = join(fixture.raw, "pairs.jsonl");
  const pairs = (await readFile(pairsPath, "utf8")).trim().split("\n")
    .map((row) => JSON.parse(row) as C5LongitudinalPairResult);
  const pair = pairs.find((candidate) =>
    candidate.clusterId === cluster.id && candidate.stageId === stage.stageId
  )!;
  pair.evaluations = pair.evaluations.map((entry) =>
    entry.arm === "flat-summary"
      ? {
          ...entry,
          disposition: "infrastructure-failure",
          evaluationEvidenceSha256: evaluationSha256,
          resolved: false,
          taskFailureReasons: [],
        }
      : entry
  );
  pair.comparable = false;
  pair.incomparabilityReasons = [
    "flat-summary-infrastructure-flat-summary-injection",
    "flat-summary-injection-mode-mismatch",
    "flat-summary-evaluator-infrastructure-failure",
  ];
  pair.outcome = "incomparable";
  await writeText(
    pairsPath,
    `${pairs.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );

  for (const [index, target] of [stage, run.stages[2]!].entries()) {
    const installedStage = installedRun.stages.find((candidate) =>
      candidate.stageId === target.stageId
    )!;
    const audit = leakageEvidence({
      baselineRun: run,
      flatSummary: index === 0
        ? ""
        : `Compact summary of the prior stages before ${target.id}.`,
      leakageInput: fixture.leakageInputs.get(
        `${cluster.episodeId}/${target.stageId}`,
      )!,
      promptOnlyOrigins: new Set([stage.stageId]),
      promptContents: fixture.promptContents,
      run: installedRun,
      stage: installedStage,
    });
    await replaceLeakageEvidence(fixture, {
      clusterId: cluster.id,
      path: join(
        fixture.raw,
        "pairs",
        clusterDigest(cluster.id),
        target.stageId,
        "live-leakage-audit.json",
      ),
      stage: target,
    }, audit as unknown as Record<string, unknown>);
  }
  return { run, stage };
}

interface ReturnedCodexStageEvidence extends Record<string, unknown> {
  codex: Record<string, unknown>;
  events: Array<{ details: Record<string, unknown>; event: string }>;
  execution: Record<string, unknown>;
  failureReasonSha256?: unknown;
}

// Mirrors runCodexProcess returning a failed result without throwing: the
// native adapter records status/exit receipts but has no exception to hash.
type ReturnedCodexFailureStatus = "non-zero-exit" | "timed-out" | "spawn-failed" |
  "event-parse-failed" | "missing-final-message";

async function makeReturnedCodexFailures(fixture: RawFixture, requested?: Array<{
  exitCode?: number;
  run: C5PilotEpisodeArmRun;
  stage: C5PilotStageRun;
  status: ReturnedCodexFailureStatus;
}>): Promise<Array<{
  path: string;
  stage: C5PilotStageRun;
}>> {
  const statuses = [
    "non-zero-exit", "timed-out", "spawn-failed",
    "event-parse-failed", "missing-final-message",
  ] as const;
  const runs = fixture.plan.episodeArmRuns.filter((run) => run.arm === "no-memory");
  const pairsPath = join(fixture.raw, "pairs.jsonl");
  const pairs = (await readFile(pairsPath, "utf8")).trim().split("\n")
    .map((row) => JSON.parse(row) as C5LongitudinalPairResult);
  const targets = [];
  const cases = requested ?? statuses.map((status, index) => ({
    run: runs[index]!, stage: runs[index]!.stages[0]!, status,
  }));
  for (const entry of cases) {
    const { run, stage, status } = entry;
    const path = join(fixture.raw, "trajectories", clusterDigest(run.clusterId),
      run.arm, stage.stageId, "stage-execution.sanitized.json");
    const evidence = JSON.parse(await readFile(path, "utf8")) as ReturnedCodexStageEvidence;
    const noParsedEvents = status === "timed-out" || status === "spawn-failed" ||
      status === "event-parse-failed";
    const exitCode = ("exitCode" in entry ? entry.exitCode : undefined) ??
      (status === "non-zero-exit" ? 1 : status === "timed-out"
      ? 143 : status === "spawn-failed" ? null : 0);
    const processStatus = status === "timed-out" || status === "spawn-failed"
      ? status : "exited";
    Object.assign(evidence.execution, {
      codexStatus: status,
      infrastructureFailureStage: "codex-execution",
      ...(noParsedEvents ? { codexUsage: null, threadId: null } : {}),
    });
    Object.assign(evidence.codex, {
      eventCount: noParsedEvents ? 0 : 2,
      exitCode,
      status,
      timedOut: status === "timed-out",
      usage: evidence.execution.codexUsage,
    });
    Object.assign(evidence.events[1]!.details, {
      exitCode,
      status: processStatus,
      timedOut: status === "timed-out",
    });
    if (status === "non-zero-exit" || status === "event-parse-failed") {
      evidence.events.splice(2, 0, {
        ...evidence.events[1]!,
        event: status === "non-zero-exit" ? "codex_process_failure" : "codex_event_parse_failed",
        details: status === "non-zero-exit"
          ? { failureEventCount: 1, failureEventsSha256: sha256("process failure") }
          : { errorSha256: sha256("event parse failure") },
      });
    }
    evidence.failureReasonSha256 = null;
    if (run.arm === "flat-summary") {
      // The producer evaluates comparator hooks only after completed Codex
      // processes, so every returned failure keeps this evaluation false.
      const injection = evidence.execution.comparatorInjection;
      if (typeof injection !== "object" || injection === null) {
        throw new Error("flat-summary failure fixture requires comparator injection");
      }
      Object.assign(injection, { hookEvaluationPassed: false });
    }
    if (noParsedEvents && run.arm === "goodmemory-installed") {
      // The frozen producer collects the installed canary only for completed
      // Codex processes. Use stage 2, after stage 1's committed writeback, so
      // later-stage lineage continues to refer to that real prior writeback.
      if (stage !== run.stages[1]) throw new Error("installed failure fixture requires stage 2");
      evidence.canaryEvidenceSha256 = null;
      evidence.execution.memoryObservation = null;
      evidence.execution.memoryChannelStatus = "failed";
      await rm(join(dirname(path), "host-canary"), { force: true, recursive: true });
    }
    await writeJson(path, evidence);
    await rebindStageEvidenceAndReport(fixture, stage.id, path, {
      execution: evidence.execution,
    });

    const evaluationPath = join(fixture.raw, "pairs", clusterDigest(run.clusterId),
      stage.stageId, `${run.arm}-evaluation.json`);
    const evaluation = JSON.parse(await readFile(evaluationPath, "utf8")) as Record<string, unknown>;
    const timeout = status === "timed-out";
    evaluation.score = {
      disposition: timeout ? "finalized" : "infrastructure-failure",
      executionFailureStage: timeout ? null : status === "non-zero-exit"
        ? "codex-execution" : status === "spawn-failed" ? "codex-launch" : "codex-events",
      resolved: false,
      taskFailureReasons: timeout ? ["codex-timeout"] : [],
    };
    await writeJson(evaluationPath, evaluation);
    const pair = pairs.find((candidate) => candidate.clusterId === run.clusterId &&
      candidate.stageId === stage.stageId)!;
    Object.assign(pair.evaluations.find((entry) => entry.arm === run.arm)!, {
      disposition: timeout ? "finalized" : "infrastructure-failure",
      evaluationEvidenceSha256: sha256(await readFile(evaluationPath, "utf8")),
      resolved: false,
      taskFailureReasons: timeout ? ["codex-timeout"] : [],
    });
    pair.comparable = false;
    pair.incomparabilityReasons = [
      `${run.arm}-infrastructure-codex-execution`,
      ...(timeout ? [] : [`${run.arm}-evaluator-infrastructure-failure`]),
      ...(run.arm === "flat-summary" ? ["flat-summary-hook-canary-failed"] : []),
    ];
    if (noParsedEvents && run.arm === "goodmemory-installed") {
      const audit: Record<string, unknown> = {
        failureReasonSha256: sha256("installed timeout has no completed-stage live surfaces"),
        schemaVersion: 5, status: "rejected", variant: "infrastructure-rejected",
      };
      bindAuditHash(audit);
      await writeJson(join(fixture.raw, "pairs", clusterDigest(run.clusterId),
        stage.stageId, "live-leakage-audit.json"), audit);
      pair.leakageAuditSha256 = String(audit.auditSha256);
      pair.incomparabilityReasons.push("live-leakage-audit-rejected");
      if (stage.memoryExpectation === "required") {
        pair.incomparabilityReasons.push("goodmemory-required-memory-channel-failed");
      }
    }
    pair.outcome = "incomparable";
    targets.push({ path, stage });
  }
  await writeText(pairsPath, `${pairs.map((row) => JSON.stringify(row)).join("\n")}\n`);
  await rebindStageEvidenceAndReport(fixture, targets[0]!.stage.id, targets[0]!.path);
  return targets;
}

async function makeTimeoutOriginFixture(fixture: RawFixture) {
  const cases = (["goodmemory-installed", "flat-summary", "goodmemory-installed"] as const)
    .map((arm, index) => {
      const run = fixture.plan.episodeArmRuns.find((candidate) =>
        candidate.clusterId === fixture.plan.clusters[index]!.id && candidate.arm === arm
      )!;
      return { exitCode: 0, run, stage: run.stages[arm === "flat-summary" ? 0 : 1]!, status: "timed-out" as const };
    });
  const targets = await makeReturnedCodexFailures(fixture, cases);
  // The first two timeout processes retain nonempty stdout; the third has
  // empty stdout, so the producer emits no stdout origin in its later audits.
  const empty = cases[2]!;
  for (const stage of empty.run.stages.slice(2)) {
    const path = join(fixture.raw, "pairs", clusterDigest(empty.run.clusterId),
      stage.stageId, "live-leakage-audit.json");
    const audit = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    audit.trajectoryOrigins = (audit.trajectoryOrigins as Array<{ id: string }>)
      .filter((origin) => origin.id !== `${empty.stage.stageId}:codex-jsonl-output`);
    audit.trajectoryOriginAuditSha256 = sha256(JSON.stringify(audit.trajectoryOrigins));
    bindAuditHash(audit);
    await replaceLeakageEvidence(fixture, {
      clusterId: empty.run.clusterId, path, stage,
    }, audit);
  }
  return targets;
}

async function makeFirstInstalledStageFail(fixture: {
  plan: C5PilotPlan;
  raw: string;
}): Promise<void> {
  const run = fixture.plan.episodeArmRuns.find((item) =>
    item.arm === "goodmemory-installed"
  )!;
  const stage = run.stages[0]!;
  const stagePath = join(
    fixture.raw,
    "trajectories",
    clusterDigest(run.clusterId),
    run.arm,
    stage.stageId,
    "stage-execution.sanitized.json",
  );
  const evidence = JSON.parse(await readFile(stagePath, "utf8")) as Record<
    string,
    unknown
  >;
  const execution = evidence.execution as Record<string, unknown>;
  execution.infrastructureFailureStage = "host-canary";
  execution.memoryChannelStatus = "failed";
  const canaryRoot = join(dirname(stagePath), "host-canary");
  const canaryPath = join(canaryRoot, "host-canary.sanitized.json");
  const transcriptPath = join(canaryRoot, "codex-rollout.sanitized.jsonl");
  const canary = JSON.parse(await readFile(canaryPath, "utf8")) as {
    canary: { memoryChannelStatus: string; passed: boolean; reasons: string[] };
    collectionFailures: unknown[];
    sessionDigest: string;
    sources: {
      sanitizedTranscriptSha256: string;
      transcriptSourceSha256: string | null;
    };
  };
  const errorSha256 = sha256("transcript collection failed");
  const transcript = `${JSON.stringify({
    payload: {
      errorSha256,
      sessionDigest: canary.sessionDigest,
      source: "codex-transcript",
    },
    type: "source_failure",
  })}\n`;
  canary.collectionFailures = [{ errorSha256, source: "codex-transcript" }];
  canary.canary.memoryChannelStatus = "failed";
  canary.canary.passed = false;
  canary.canary.reasons = ["source-collection-failed:codex-transcript"];
  canary.sources.sanitizedTranscriptSha256 = sha256(transcript);
  canary.sources.transcriptSourceSha256 = null;
  await writeText(transcriptPath, transcript);
  await writeJson(canaryPath, canary);
  evidence.canaryEvidenceSha256 = sha256(await readFile(canaryPath, "utf8"));
  evidence.failureReasonSha256 = sha256("source-collection-failed:codex-transcript");
  await writeJson(stagePath, evidence);

  const stageExecutions = (await readFile(
    join(fixture.raw, "stage-executions.jsonl"),
    "utf8",
  )).trim().split("\n").map((line) =>
    JSON.parse(line) as C5RecordedStageExecution
  );
  const recorded = stageExecutions.find((item) => item.stageRunId === stage.id)!;
  Object.assign(recorded, execution, {
    stageEvidenceSha256: sha256(await readFile(stagePath, "utf8")),
  });

  const pairs = (await readFile(join(fixture.raw, "pairs.jsonl"), "utf8"))
    .trim().split("\n").map((line) =>
      JSON.parse(line) as C5LongitudinalPairResult
    );
  const pair = pairs.find((item) =>
    item.clusterId === run.clusterId && item.stageId === stage.stageId
  )!;
  pair.comparable = false;
  pair.incomparabilityReasons = [
    "goodmemory-installed-infrastructure-host-canary",
    ...(stage.memoryExpectation === "required"
      ? ["goodmemory-required-memory-channel-failed"]
      : []),
  ];
  pair.outcome = "incomparable";

  await writeText(
    join(fixture.raw, "stage-executions.jsonl"),
    `${stageExecutions.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
  await writeText(
    join(fixture.raw, "pairs.jsonl"),
    `${pairs.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
  const planBytes = serializeC5PilotPlan(fixture.plan);
  const report = buildC5PilotReport({
    generatedAt: GENERATED_AT,
    plan: fixture.plan,
    planSha256: sha256(planBytes),
    result: { pairs, stageExecutions },
    runId: RUN_ID,
  });
  await writeText(
    join(fixture.raw, "report.json"),
    serializeC5PilotReport(report),
  );
}

async function addInterruptedAttempt(fixture: {
  plan: C5PilotPlan;
  raw: string;
}, options: {
  artifactBytes?: string;
  artifactName?: string;
  empty?: boolean;
} = {}): Promise<void> {
  const cluster = fixture.plan.clusters.at(-1)!;
  const attemptId = `${clusterDigest(cluster.id)}-attempt-1`;
  const attemptEvidencePath =
    `interrupted-attempts/${attemptId}/attempt.sanitized.json`;
  const stages = (await readFile(
    join(fixture.raw, "stage-executions.jsonl"),
    "utf8",
  )).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  const stage = stages.find((row) => row.clusterId === cluster.id)!;
  const artifactBytes = options.artifactBytes ?? '{"partial":true}\n';
  const artifactName = options.artifactName ?? "stage-execution.sanitized.json";
  const evidence = {
    artifacts: options.empty
      ? []
      : [{
          bytesBase64: Buffer.from(artifactBytes).toString("base64"),
          path: `trajectories/${clusterDigest(cluster.id)}/goodmemory-installed/stage-1/${artifactName}`,
          sha256: sha256(artifactBytes),
        }],
    attemptId,
    clusterId: cluster.id,
    commitTornTail: null,
    disposition: "process-interrupted-before-cluster-commit",
    pairRows: [],
    pairTornTail: null,
    schemaVersion: 1,
    stageRows: options.empty ? [] : [stage],
    stageTornTail: null,
  };
  await writeJson(join(fixture.raw, attemptEvidencePath), evidence);
  const evidenceBytes = await readFile(
    join(fixture.raw, attemptEvidencePath),
    "utf8",
  );
  await writeText(join(fixture.raw, "run-attempts.jsonl"), `${JSON.stringify({
    attemptEvidencePath,
    attemptEvidenceSha256: sha256(evidenceBytes),
    attemptId,
    clusterId: cluster.id,
    disposition: "process-interrupted-before-cluster-commit",
    schemaVersion: 1,
  })}\n`);
}

async function replaceHostCanaryRecall(
  fixture: { plan: C5PilotPlan; raw: string },
  run: C5PilotEpisodeArmRun,
  stage: C5PilotStageRun,
  recalledId: string,
): Promise<void> {
  const stageRoot = join(
    fixture.raw,
    "trajectories",
    clusterDigest(run.clusterId),
    run.arm,
    stage.stageId,
  );
  const canaryPath = join(
    stageRoot,
    "host-canary",
    "host-canary.sanitized.json",
  );
  const canary = JSON.parse(await readFile(canaryPath, "utf8")) as {
    canary: {
      injectedRecordIds: string[];
      recalledPriorMemoryIds: string[];
    };
    sourceReceipts: {
      injection: {
        events: Array<{ decision: string; recordIds: string[] }>;
        injectedRecordIds: string[];
      };
    };
  };
  canary.canary.injectedRecordIds = [recalledId];
  canary.canary.recalledPriorMemoryIds = [recalledId];
  canary.sourceReceipts.injection.injectedRecordIds = [recalledId];
  for (const event of canary.sourceReceipts.injection.events) {
    if (event.decision === "injected" || event.decision === "duplicate_context") {
      event.recordIds = [recalledId];
    }
  }
  await writeJson(canaryPath, canary);

  await rebindHostCanaryEvidence(
    fixture,
    stage.id,
    join(stageRoot, "stage-execution.sanitized.json"),
    canaryPath,
  );
}

async function rebindHostCanaryEvidence(
  fixture: { plan: C5PilotPlan; raw: string },
  stageRunId: string,
  stagePath: string,
  canaryPath: string,
): Promise<void> {
  const evidence = JSON.parse(await readFile(stagePath, "utf8")) as Record<
    string,
    unknown
  >;
  evidence.canaryEvidenceSha256 = sha256(await readFile(canaryPath, "utf8"));
  await writeJson(stagePath, evidence);

  await rebindStageEvidenceAndReport(fixture, stageRunId, stagePath);
}

async function rebindStageEvidenceAndReport(
  fixture: { plan: C5PilotPlan; raw: string },
  stageRunId: string,
  stagePath: string,
  options: { execution?: Record<string, unknown> } = {},
): Promise<void> {
  const stagesPath = join(fixture.raw, "stage-executions.jsonl");
  const stages = (await readFile(stagesPath, "utf8")).trim().split("\n")
    .map((row) => JSON.parse(row) as C5RecordedStageExecution);
  const recorded = stages.find((candidate) =>
    candidate.stageRunId === stageRunId
  )!;
  Object.assign(recorded, options.execution ?? {});
  recorded.stageEvidenceSha256 = sha256(await readFile(stagePath, "utf8"));
  await writeText(
    stagesPath,
    `${stages.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );

  const pairs = (await readFile(join(fixture.raw, "pairs.jsonl"), "utf8"))
    .trim().split("\n").map((row) =>
      JSON.parse(row) as C5LongitudinalPairResult
    );
  const report = buildC5PilotReport({
    generatedAt: GENERATED_AT,
    plan: fixture.plan,
    planSha256: sha256(serializeC5PilotPlan(fixture.plan)),
    result: { pairs, stageExecutions: stages },
    runId: RUN_ID,
  });
  await writeText(
    join(fixture.raw, "report.json"),
    serializeC5PilotReport(report),
  );
}

async function readLeakageTarget(
  fixture: { plan: C5PilotPlan; raw: string },
  position: number,
): Promise<{
  audit: Record<string, unknown>;
  clusterId: string;
  path: string;
  stage: C5PilotStageRun;
}> {
  const cluster = fixture.plan.clusters[0]!;
  const run = fixture.plan.episodeArmRuns.find((candidate) =>
    candidate.clusterId === cluster.id &&
    candidate.arm === "goodmemory-installed"
  )!;
  const stage = run.stages[position - 1]!;
  const path = join(
    fixture.raw,
    "pairs",
    clusterDigest(cluster.id),
    stage.stageId,
    "live-leakage-audit.json",
  );
  return {
    audit: JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>,
    clusterId: cluster.id,
    path,
    stage,
  };
}

async function replaceLeakageEvidence(
  fixture: { plan: C5PilotPlan; raw: string },
  target: { clusterId: string; path: string; stage: C5PilotStageRun },
  audit: Record<string, unknown>,
  accountForRejection = false,
): Promise<void> {
  const auditSha256 = String(audit.auditSha256);
  await writeJson(target.path, audit);
  const pairsPath = join(fixture.raw, "pairs.jsonl");
  const pairs = (await readFile(pairsPath, "utf8")).trim().split("\n")
    .map((row) => JSON.parse(row) as C5LongitudinalPairResult);
  const pair = pairs.find((candidate) =>
    candidate.clusterId === target.clusterId &&
    candidate.stageId === target.stage.stageId
  )!;
  pair.leakageAuditSha256 = auditSha256;
  if (accountForRejection) {
    pair.comparable = false;
    pair.incomparabilityReasons = ["live-leakage-audit-rejected"];
    pair.outcome = "incomparable";
  }
  await writeText(
    pairsPath,
    `${pairs.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
  const stages = (await readFile(
    join(fixture.raw, "stage-executions.jsonl"),
    "utf8",
  )).trim().split("\n").map((row) =>
    JSON.parse(row) as C5RecordedStageExecution
  );
  const planSha256 = sha256(serializeC5PilotPlan(fixture.plan));
  const report = buildC5PilotReport({
    generatedAt: GENERATED_AT,
    plan: fixture.plan,
    planSha256,
    result: { pairs, stageExecutions: stages },
    runId: RUN_ID,
  });
  await writeText(
    join(fixture.raw, "report.json"),
    serializeC5PilotReport(report),
  );
}

function bindAuditHash(audit: Record<string, unknown>): void {
  delete audit.auditSha256;
  audit.auditSha256 = sha256(JSON.stringify(audit));
}

function bindMatrixAuditHash(audit: Record<string, unknown>): void {
  delete audit.auditSha256;
  audit.auditSha256 = sha256(JSON.stringify(audit));
}

function permissionEvidence() {
  return {
    configSha256: SHA,
    deniedReads: Array.from({ length: 12 }, (_, index) => ({
      denied: true,
      exitCode: 1,
      label: `denied-${String(index).padStart(2, "0")}`,
      pathSha256: sha256(`path-${index}`),
    })),
    networkAccess: false,
    networkDenied: true,
    networkPositiveControl: true,
    passed: true,
    phase: "preflight",
    profileName: "c3-task",
    reasons: [],
    schemaVersion: 1,
    workspaceRead: true,
    workspaceWrite: true,
  };
}

function aliasEvidence() {
  return {
    aliases: REQUIRED_ALIAS_LABELS.map((label) => ({
      denied: true,
      exitCode: 1,
      label,
      targetPathSha256: sha256(label),
    })),
    passed: true,
    profileName: "c3-task",
    schemaVersion: 1,
  };
}

function installedProfile() {
  return {
    activationMode: "global",
    hookRegistered: true,
    mcpRegistered: true,
    persistRawTranscript: false,
    retrievalProfile: "coding_agent",
    workspaceStatus: "ok",
    writebackMode: "selective",
  } as const;
}

function memoryObservationFor(
  expectation: "irrelevant-control" | "none" | "required",
  writebackRequired: boolean,
) {
  const required = expectation === "required";
  return {
    injectedRecordCount: required ? 1 : 0,
    irrelevantInjection: false,
    recalledPriorMemoryCount: required ? 1 : 0,
    writebackCommitted: writebackRequired,
    writtenMemoryCount: writebackRequired ? 1 : 0,
  };
}

function sanitizedTranscript(threadId: string): string {
  return [
    JSON.stringify({ payload: { id: threadId }, type: "session_meta" }),
    JSON.stringify({
      payload: {
        content: [{
          length: 10,
          text: "<redacted-user-text>",
          textSha256: SHA,
          type: "input_text",
        }],
        role: "user",
        type: "message",
      },
      type: "response_item",
    }),
    JSON.stringify({
      payload: {
        content: [{
          length: 10,
          text: "<redacted-assistant-text>",
          textSha256: SHA,
          type: "output_text",
        }],
        role: "assistant",
        type: "message",
      },
      type: "response_item",
    }),
  ].join("\n") + "\n";
}

function hostCanaryEvidence(input: {
  effectivePrompt: string;
  expectedPriorMemoryIds: readonly string[];
  memoryExpectation: "irrelevant-control" | "none" | "required";
  sanitizedTranscriptSha256: string;
  stageId: string;
  writebackRequired: boolean;
}) {
  const required = input.memoryExpectation === "required";
  const recalled = required ? [input.expectedPriorMemoryIds[0]!] : [];
  const written = input.writebackRequired ? [`written-${input.stageId}`] : [];
  const hookContext = fixtureHookContext(input.memoryExpectation, input.stageId);
  const contentHashes = hookContext.length === 0
    ? []
    : [`content:${sha256(hookContext).slice(0, 24)}`];
  const sessionDigest = sha256(input.stageId);
  const hookContextReceipts = contentHashes.map((contentHash) => ({
    contentByteLength: Buffer.byteLength(hookContext, "utf8"),
    contentHash,
    contentSha256: sha256(hookContext),
  }));
  const effectiveInputSurfaceSha256 = sha256(
    hookContext.length === 0
      ? input.effectivePrompt
      : `${input.effectivePrompt}\n\n${hookContext}`,
  );
  const effectiveInputComposition = {
    hookContextReceiptSha256: sha256(JSON.stringify(hookContextReceipts)),
    promptSha256: sha256(input.effectivePrompt),
    semanticSurfaceCommitmentSha256: sha256(JSON.stringify([
      hookContext.length === 0
        ? input.effectivePrompt
        : `${input.effectivePrompt}\n\n${hookContext}`,
    ])),
    separatorPolicy: "prompt-then-double-lf-hook-context-v1",
    surfaceSha256: effectiveInputSurfaceSha256,
  };
  return {
    canary: {
      currentWrittenMemoryIds: written,
      hookContexts: hookContextReceipts,
      injectedRecordIds: recalled,
      irrelevantInjection: false,
      memoryChannelStatus: "passed",
      passed: true,
      recalledPriorMemoryIds: recalled,
      reasons: [],
      stopCursorAdvanced: true,
      writebackCommitted: input.writebackRequired,
    },
    collectionFailures: [],
    liveSurfaceSha256: Object.fromEntries(fixtureLiveSurfaces(
      input.effectivePrompt,
      hookContext,
    ).map((surface) => [surface.id, sha256(surface.content)])),
    schemaVersion: 3,
    sessionDigest,
    sourceReceipts: {
      cursor: {
        sessionDigest,
        sessionDigests: [sessionDigest],
        sourceSha256: SHA,
      },
      effectiveInput: {
        ...effectiveInputComposition,
        compositionSha256: sha256(JSON.stringify(effectiveInputComposition)),
      },
      injection: {
        contentHashes,
        events: recalled.length === 0
          ? []
          : [{
              command: "user-prompt-submit",
              decision: "injected",
              recordIds: recalled,
            }],
        hookContextSegments: hookContext.length === 0
          ? []
          : [{
              contentByteLength: Buffer.byteLength(hookContext, "utf8"),
              contentSha256: sha256(hookContext),
            }],
        hookContextSurfaceCommitmentSha256: sha256(JSON.stringify(
          hookContext.length === 0 ? [] : [hookContext],
        )),
        injectedRecordIds: recalled,
        sessionDigest,
        sourceSha256: SHA,
      },
      memoryExport: {
        recordIds: input.expectedPriorMemoryIds,
        semanticDocumentSha256: [],
        semanticSurfaceCommitmentSha256: sha256(JSON.stringify([])),
        sourceSha256: sha256(emptyMemoryExport()),
        utf8Bytes: Buffer.byteLength(emptyMemoryExport(), "utf8"),
      },
      writeback: {
        events: written.length === 0
          ? []
          : [{
              command: "turn-end",
              linkedRecordIds: written.map((id) => ({ id, type: "memory" })),
              status: "committed",
            }],
        sessionDigest,
        sourceSha256: SHA,
      },
    },
    sources: {
      cursorSourceSha256: SHA,
      injectionSourceSha256: SHA,
      memoryExportSha256: sha256(emptyMemoryExport()),
      sanitizedTranscriptSha256: input.sanitizedTranscriptSha256,
      transcriptSourceSha256: SHA,
      writebackSourceSha256: SHA,
    },
  };
}

function stageEvents(input: {
  arm: C5PilotArm;
  episodeId: string;
  repetition: number;
  seed: number;
  stageId: string;
  stageRunId: string;
}) {
  const base = {
    arm: input.arm,
    attemptId: `${input.stageRunId}#attempt-1`,
    episodeId: input.episodeId,
    repetition: input.repetition,
    runId: RUN_ID,
    seed: input.seed,
    stageId: input.stageId,
    timestamp: GENERATED_AT,
    traceId: input.stageRunId,
  };
  return [
    {
      ...base,
      details: { argumentCount: 10, executableSha256: SHA },
      event: "codex_process_started",
    },
    {
      ...base,
      details: {
        durationMs: 100,
        exitCode: 0,
        status: "exited",
        timedOut: false,
      },
      event: "codex_process_exited",
    },
    {
      ...base,
      details: {
        changedFileCount: 1,
        forbiddenFileCount: 0,
        hasPatch: true,
        sha256: sha256(
          `diff --git a/src/index.ts b/src/index.ts\n${input.stageRunId}\n`,
        ),
        untrackedFileCount: 0,
      },
      event: "patch_captured",
    },
  ];
}

function leakageEvidence(input: {
  baselineRun?: C5PilotEpisodeArmRun;
  flatSummary?: string;
  leakageInput: {
    artifacts: C4HiddenArtifact[];
    staticSurfaces: C4LeakageSurface[];
  };
  promptContents: ReadonlyMap<string, string>;
  // Baseline prior stages that never launched Codex contribute only their
  // prompt as a trajectory origin (no patch, no Codex output).
  promptOnlyOrigins?: ReadonlySet<string>;
  run: C5PilotEpisodeArmRun;
  stage: C5PilotStageRun;
}) {
  const originRuns: Array<{
    originId: (stageId: string) => string;
    run: C5PilotEpisodeArmRun;
  }> = [
    { originId: (stageId) => stageId, run: input.run },
    ...(input.baselineRun === undefined
      ? []
      : [{
          originId: (stageId: string) => `${stageId}:flat-summary`,
          run: input.baselineRun,
        }]),
  ];
  return auditC5LiveLeakageSurfaces({
    artifacts: input.leakageInput.artifacts,
    liveSurfaces: fixtureLiveSurfaces(
      requiredPrompt(
        input.promptContents,
        input.run.episodeId,
        input.stage.stageId,
      ),
      fixtureHookContext(input.stage.memoryExpectation, input.stage.id),
      input.flatSummary ?? "",
    ),
    staticSurfaces: input.leakageInput.staticSurfaces,
    trajectoryOrigins: input.stage.priorStageIds.flatMap((priorStageId) =>
      originRuns.flatMap(({ originId, run }) => {
        const priorStage = run.stages.find((candidate) =>
          candidate.stageId === priorStageId
        )!;
        const id = originId(priorStageId);
        const promptOnly = run === input.baselineRun &&
          input.promptOnlyOrigins?.has(priorStageId) === true;
        return [{
          content: requiredPrompt(
            input.promptContents,
            run.episodeId,
            priorStageId,
          ),
          id: `${id}:effective-prompt`,
        }, ...(promptOnly ? [] : [{
          content: agentPatchForStage(priorStage),
          id: `${id}:agent-patch`,
        }, {
          content: codexJsonlOutputForStage(priorStage),
          id: `${id}:codex-jsonl-output`,
        }])];
      })
    ),
  });
}

// The flat-summary comparator fixture mirrors the runner: one capped summary
// of the arm's own prior stages on stages with history, zero injection on
// position 1, a sanitized receipt bound by hash, and raw summary/history text
// that must never be projected.
async function writeComparatorStageEvidence(input: {
  promptContents: ReadonlyMap<string, string>;
  run: C5PilotEpisodeArmRun;
  stageIndex: number;
  stageRoot: string;
}): Promise<{
  evidenceSha256: string;
  injectionRow: NonNullable<C5RecordedStageExecution["comparatorInjection"]>;
  summary: string;
}> {
  const stage = input.run.stages[input.stageIndex]!;
  const history = buildC5FlatSummaryHistory(
    input.run.stages.slice(0, input.stageIndex).map((prior, index) => ({
      finalMessage: `done ${prior.stageId}`,
      patchDiff: agentPatchForStage(prior),
      position: index + 1,
      prompt: requiredPrompt(
        input.promptContents,
        input.run.episodeId,
        prior.stageId,
      ),
      stageId: prior.stageId,
    })),
  );
  const injection = resolveC5FlatSummaryInjection({
    history,
    summary: history.text.length === 0
      ? null
      : `Compact summary of the prior stages before ${stage.id}.`,
  });
  const zero = injection.mode === "no-history-zero-injection";
  const receipt = {
    generation: zero
      ? null
      : {
          leakageAuditSha256: SHA,
          model: COMPARATOR.summaryModel,
          promptSha256: COMPARATOR.summaryPromptSha256,
          redactedRequestSha256: SHA,
          requestSha256: SHA,
          responseSha256: SHA,
          usage: { cachedInputTokens: 0, inputTokens: 100, outputTokens: 20 },
        },
    historySourceSha256: history.sha256,
    injection: {
      injectedUtf8Bytes: Buffer.byteLength(injection.injectedText, "utf8"),
      mode: injection.mode,
      semanticSurfaceCommitmentSha256: sha256(JSON.stringify([
        injection.injectedText,
      ])),
      sessionStart: injection.sessionStart,
      userPromptSubmit: injection.userPromptSubmit,
    },
    priorStageIds: stage.priorStageIds,
    schemaVersion: 1,
  };
  const evidenceRoot = join(input.stageRoot, "flat-summary");
  const receiptPath = join(evidenceRoot, "injection.sanitized.json");
  await writeJson(receiptPath, receipt);
  await writeText(join(evidenceRoot, "summary.txt"), injection.injectedText);
  await writeText(join(evidenceRoot, "history.txt"), history.text);
  return {
    evidenceSha256: sha256(await readFile(receiptPath, "utf8")),
    injectionRow: {
      historySourceSha256: history.sha256,
      hookEvaluationPassed: true,
      injectedContentSha256: zero
        ? null
        : injection.userPromptSubmit.contentSha256,
      injectedTokenCount: injection.userPromptSubmit.injectedTokenCount,
      mode: injection.mode,
    },
    summary: injection.injectedText,
  };
}

function codexJsonlOutputForStage(stage: C5PilotStageRun): string {
  return `${JSON.stringify({
    item: { id: stage.id, type: "agent_message" },
    type: "item.completed",
  })}\n`;
}

function fixtureHookContext(
  memoryExpectation: "irrelevant-control" | "none" | "required",
  stageId: string,
): string {
  return memoryExpectation === "required"
    ? `Same-trajectory prior context for ${stageId}.`
    : "";
}

function fixtureLiveSurfaces(
  effectivePrompt: string,
  hookContext = "",
  flatSummary = "",
): C4LeakageSurface[] {
  return [
    {
      content: hookContext.length === 0
        ? effectivePrompt
        : `${effectivePrompt}\n\n${hookContext}`,
      id: "effective-codex-input-after-seeding",
    },
    { content: flatSummary, id: "flat-summary-after-seeding" },
    {
      content: emptyMemoryExport(),
      hiddenValueContents: [],
      id: "goodmemory-export-after-seeding",
    },
    {
      content: hookContext,
      hiddenValueContents: hookContext.length === 0 ? [] : [hookContext],
      id: "goodmemory-hook-context-after-seeding",
    },
  ];
}

function emptyMemoryExport(): string {
  return JSON.stringify({
    durable: {
      archives: [],
      episodes: [],
      evidence: [],
      experiences: [],
      facts: [],
      feedback: [],
      preferences: [],
      profile: null,
      promotions: [],
      proposals: [],
      references: [],
      sourceMessages: [],
    },
  });
}

function agentPatchForStage(stage: C5PilotStageRun): string {
  return `diff --git a/src/index.ts b/src/index.ts\n${stage.id}\n`;
}

function requiredPrompt(
  prompts: ReadonlyMap<string, string>,
  episodeId: string,
  stageId: string,
): string {
  const prompt = prompts.get(`${episodeId}/${stageId}`);
  if (prompt === undefined) throw new Error("missing C5 evidence fixture prompt");
  return prompt;
}

function c5HostEnvironment(baselineArm: C5BaselineArm = "no-memory") {
  const flat = baselineArm === "flat-summary";
  const installedConfigSha256 = sha256("installed-codex-config");
  const noMemoryConfigSha256 = sha256("no-memory-codex-config");
  const goodmemoryConfigSha256 = sha256("goodmemory-config");
  const hooksConfigSha256 = sha256("hooks-config");
  const configurations = buildC3HostConfigurationEvidence({
    goodmemoryInstalled: {
      codexConfig: {
        normalizedText: "features.hooks=true",
        sourceSha256: installedConfigSha256,
      },
      environment: c5ControlledHostEnvironment(),
      goodmemoryConfig: {
        normalizedText: '{"writebackMode":"selective"}',
        sourceSha256: goodmemoryConfigSha256,
      },
      hooksConfig: {
        normalizedText: '{"hooks":["SessionStart","Stop"]}',
        sourceSha256: hooksConfigSha256,
      },
      profile: installedProfile(),
    },
    noMemory: {
      codexConfig: {
        normalizedText: `features.hooks=${flat}`,
        sourceSha256: noMemoryConfigSha256,
      },
      environment: c5ControlledHostEnvironment(),
      goodmemoryConfig: null,
      hooksConfig: flat
        ? {
            normalizedText: FLAT_SUMMARY_HOOKS_NORMALIZED,
            sourceSha256: sha256("flat-summary-hooks-config"),
          }
        : null,
      profile: null,
    },
  });

  return parseC5HostEnvironment({
    ...(flat ? { baselineArm: "flat-summary" as const } : {}),
    codexFeatures: {
      goodmemoryInstalled: c5FeatureEvidence(true),
      noMemory: c5FeatureEvidence(flat),
    },
    configurations,
    goodmemory: {
      configSha256: goodmemoryConfigSha256,
      executableSha256: SHA,
      hooksSha256: hooksConfigSha256,
      mcpExecutableSha256: SHA,
      packageSha256: SHA,
    },
    platform: {
      arch: "arm64",
      cpuCount: 8,
      name: "darwin",
      totalMemoryBytes: 16_000_000_000,
    },
    repositoryPolicy: {
      dirtyStatePolicy: "reject",
      workspaceIsolation: "fresh-isolated-clone-per-stage",
    },
    toolchain: Object.fromEntries(
      ["bun", "git", "node", "npm", "python"].map((name) => [
        name,
        { sha256: SHA, version: `${name}-test` },
      ]),
    ),
  });
}

function withClusterHostConfigurationReceipts(
  environment: ReturnType<typeof c5HostEnvironment>,
  clusterId: string,
) {
  const installed = environment.configurations.arms.goodmemoryInstalled;
  const noMemory = environment.configurations.arms.noMemory;
  const goodmemoryConfigSha256 = sha256(`${clusterId}:goodmemory-config`);
  const hooksConfigSha256 = sha256(`${clusterId}:hooks-config`);
  const configurations = buildC3HostConfigurationEvidence({
    goodmemoryInstalled: {
      ...installed,
      codexConfig: {
        ...installed.codexConfig,
        sourceSha256: sha256(`${clusterId}:installed-codex-config`),
      },
      goodmemoryConfig: {
        ...installed.goodmemoryConfig!,
        sourceSha256: goodmemoryConfigSha256,
      },
      hooksConfig: {
        ...installed.hooksConfig!,
        sourceSha256: hooksConfigSha256,
      },
    },
    noMemory: {
      ...noMemory,
      codexConfig: {
        ...noMemory.codexConfig,
        sourceSha256: sha256(`${clusterId}:no-memory-codex-config`),
      },
    },
  });

  return parseC5HostEnvironment({
    ...environment,
    configurations,
    goodmemory: {
      ...environment.goodmemory,
      configSha256: goodmemoryConfigSha256,
      hooksSha256: hooksConfigSha256,
    },
  });
}

function c5ControlledHostEnvironment(): Record<string, string> {
  return {
    CODEX_HOME: "<codex-home>",
    GOODMEMORY_HOME: "<home>/.goodmemory",
    HOME: "<home>",
    PATH: "<package-prefix>/bin:<host-path>",
    TMPDIR: "<temp>",
  };
}

function c5FeatureEvidence(hooksEnabled: boolean) {
  const rawOutput = `hooks stable ${hooksEnabled}\nmemories stable false\n`;
  return {
    hooks: { enabled: hooksEnabled, maturity: "stable" },
    memories: { enabled: false, maturity: "stable" },
    outputSha256: sha256(rawOutput),
    rawOutput,
  };
}

function evaluatorEvidence(input: {
  arm: C5PilotArm;
  reasons: string[];
  resolved: boolean;
}) {
  const testResult = (
    kind: "fail-to-pass" | "pass-to-pass",
    status: "failed" | "passed",
  ) => ({
    commandSha256: SHA,
    durationMs: 10,
    exitCode: status === "passed" ? 0 : 1,
    kind,
    status,
  });
  return {
    arm: input.arm,
    evaluatorFiles: [
      { relativePath: "cases.json", sha256: SHA },
      { relativePath: "runner.ts", sha256: SHA },
    ],
    failToPass: testResult(
      "fail-to-pass",
      input.resolved ? "passed" : "failed",
    ),
    passToPass: testResult("pass-to-pass", "passed"),
    sandbox: {
      configSha256: SHA,
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
    schemaVersion: 1,
    score: {
      disposition: "finalized",
      executionFailureStage: null,
      resolved: input.resolved,
      taskFailureReasons: input.reasons,
    },
  };
}

async function writeReviewArtifacts(input: {
  manifest: C5EvidenceProjectionManifest;
  projection: string;
  verification: Awaited<ReturnType<typeof verifyC5EvidenceProjection>>;
}): Promise<void> {
  const manifestSha256 = sha256(await readFile(
    join(input.projection, "projection-manifest.json"),
    "utf8",
  ));
  const reportSha256 = sha256(await readFile(
    join(input.projection, "report.json"),
    "utf8",
  ));
  const verificationSha256 = sha256(
    serializeC5EvidenceVerification(input.verification),
  );
  const manifestBytes = await readFile(
    join(input.projection, "projection-manifest.json"),
    "utf8",
  );
  const reportBytes = await readFile(
    join(input.projection, "report.json"),
    "utf8",
  );
  const verificationBytes = serializeC5EvidenceVerification(input.verification);
  const bundle = buildC5ReviewInputBundle({
    createdAt: GENERATED_AT,
    projectionManifestBytes: manifestBytes,
    projectionRootPath: input.projection,
    reportBytes,
    runId: RUN_ID,
    verificationBytes,
  });
  const inputBundleBytes = serializeC5ReviewArtifact(bundle);
  const requestBytes = buildC5ReviewRequest({
    inputBundle: bundle,
    inputBundleSha256: sha256(inputBundleBytes),
  });
  const dispatchBytes = serializeC5ReviewArtifact(
    buildC5IndependentReviewDispatch({
      projectionRootPath: input.projection,
      spawnMessage: buildC5IndependentReviewSpawnMessage(input.projection),
    }),
  );
  const review = {
    assertions: {
      claimBoundary: true,
      everyAttemptAccounted: true,
      failureTaxonomyReviewed: true,
      noSilentFallback: true,
      powerAnalysis: true,
    },
    claimBoundary: "internal-native-longitudinal-pilot-only" as const,
    decision: "accepted",
    failureTaxonomySha256: bundle.artifacts.failureTaxonomy.sha256,
    findings: [],
    inputBundleSha256: sha256(inputBundleBytes),
    phase: "C5",
    projectionManifestSha256: manifestSha256,
    publicClaimEligible: false,
    publicCodingEffectProof: false,
    rationale: "The sanitized projection passes all independent assertions.",
    readmeRowAllowed: false,
    reportSha256,
    reviewedAt: GENERATED_AT,
    reviewer: "independent C5 reviewer",
    reviewerTaskName: "/root/c5_final_independent_review_v1",
    runId: RUN_ID,
    schemaVersion: 1,
    scope: "sanitized-projection-only",
    verificationSha256,
  };
  const reviewDirectory = join(input.projection, "review");
  await Promise.all([
    writeText(join(reviewDirectory, "request.md"), requestBytes),
    writeText(join(reviewDirectory, "dispatch.json"), dispatchBytes),
    writeText(join(reviewDirectory, "input-bundle.json"), inputBundleBytes),
  ]);
  const reviewPath = join(
    reviewDirectory,
    "independent-review.json",
  );
  const reviewBytes = serializeC5ReviewArtifact(review);
  await writeText(reviewPath, reviewBytes);
  const provenance = buildC5IndependentReviewProvenance({
    authorTaskName: "/root",
    dispatchBytes,
    inputBundleBytes,
    recordedAt: GENERATED_AT,
    requestBytes,
    responseBytes: reviewBytes,
    reviewerAgentName: "/root/c5_final_independent_review_v1",
  });
  await writeText(
    join(reviewDirectory, "provenance.json"),
    serializeC5ReviewArtifact(provenance),
  );
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, "utf8");
}

function clusterDigest(clusterId: string): string {
  return sha256(clusterId).slice(0, 16);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
