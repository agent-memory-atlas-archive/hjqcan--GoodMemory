import { createHash } from "node:crypto";
import {
  appendFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { C5PilotPlan } from "./c5-pilot-plan";
import type {
  C5LongitudinalPairResult,
  C5RecordedStageExecution,
} from "./c5-longitudinal";

const SAFE_INTERRUPTED_ARTIFACTS = new Set([
  "agent.patch",
  "codex-rollout.sanitized.jsonl",
  "goodmemory-installed-evaluation-failure.sanitized.json",
  "goodmemory-installed-evaluation.json",
  "host-canary.sanitized.json",
  "host-preflight.sanitized.json",
  "live-leakage-audit.json",
  "no-memory-evaluation-failure.sanitized.json",
  "no-memory-evaluation.json",
  "permission-isolation-preflight.sanitized.json",
  "stage-execution.sanitized.json",
  "task-alias-isolation.json",
]);

export interface C5EvidenceLedger {
  appendPair(pair: C5LongitudinalPairResult): Promise<void>;
  appendStageExecution(execution: C5RecordedStageExecution): Promise<void>;
  commitCluster(clusterId: string): Promise<void>;
  pairs: C5LongitudinalPairResult[];
  remainingClusterIds: string[];
  stageExecutions: C5RecordedStageExecution[];
}

export async function openC5EvidenceLedger(input: {
  clusterId?: string;
  directory: string;
  identity: Record<string, unknown>;
  plan: C5PilotPlan;
  resume?: boolean;
}): Promise<C5EvidenceLedger> {
  const clusters = input.clusterId === undefined
    ? input.plan.clusters
    : [requiredCluster(input.plan, input.clusterId)];
  await mkdir(input.directory, { recursive: true });
  const identityPath = join(input.directory, "run-identity.json");
  const commitsPath = join(input.directory, "cluster-commits.jsonl");
  const pairsPath = join(input.directory, "pairs.jsonl");
  const stagesPath = join(input.directory, "stage-executions.jsonl");
  const attemptsPath = join(input.directory, "run-attempts.jsonl");
  const identityBytes = `${JSON.stringify(input.identity, null, 2)}\n`;
  if (input.resume === true) {
    if (await readRequired(identityPath) !== identityBytes) {
      throw new Error("C5 resume run identity bytes do not match");
    }
    if (!await exists(attemptsPath)) {
      await writeFile(attemptsPath, "", { encoding: "utf8", flag: "wx" });
    }
    await readRequired(commitsPath);
  } else {
    if (
      await exists(identityPath) ||
      await exists(pairsPath) ||
      await exists(stagesPath) ||
      await exists(attemptsPath) ||
      await exists(commitsPath)
    ) {
      throw new Error("fresh C5 evidence ledger already contains result rows");
    }
    await Promise.all([
      writeFile(identityPath, identityBytes, { encoding: "utf8", flag: "wx" }),
      writeFile(attemptsPath, "", { encoding: "utf8", flag: "wx" }),
      writeFile(commitsPath, "", { encoding: "utf8", flag: "wx" }),
    ]);
  }

  const expectedStages = orderedExpectedStages(input.plan, clusters);
  const expectedPairs = orderedExpectedPairs(input.plan, clusters);
  const parsedStages = parseRows<C5RecordedStageExecution>(
    await readOptional(stagesPath),
    "C5 stage ledger",
  );
  const parsedPairs = parseRows<C5LongitudinalPairResult>(
    await readOptional(pairsPath),
    "C5 pair ledger",
  );
  const parsedCommits = parseRows<C5ClusterCommit>(
    await readRequired(commitsPath),
    "C5 cluster commit ledger",
  );
  validateStagePrefix(parsedStages.rows, expectedStages);
  validatePairPrefix(parsedPairs.rows, expectedPairs);
  const perCluster = clusterRowCounts(input.plan);
  validateCommitPrefix(
    parsedCommits,
    clusters,
    parsedStages.rows,
    parsedPairs.rows,
    perCluster,
  );

  let completedClusterCount = parsedCommits.rows.length;
  const stagePrefixCount = completedClusterCount * perCluster.stageRuns;
  const pairPrefixCount = completedClusterCount * perCluster.pairs;
  const partialCluster = clusters[completedClusterCount];
  if (
    parsedStages.rows.length > stagePrefixCount + perCluster.stageRuns ||
    parsedPairs.rows.length > pairPrefixCount + perCluster.pairs
  ) {
    throw new Error("C5 resume ledger spans more than one incomplete cluster");
  }
  if (partialCluster !== undefined && (
    parsedStages.rows.length > stagePrefixCount ||
    parsedPairs.rows.length > pairPrefixCount ||
    parsedCommits.tornTail !== null ||
    parsedStages.tornTail !== null ||
    parsedPairs.tornTail !== null ||
    await clusterArtifactsExist(input.directory, partialCluster.id)
  )) {
    await preserveInterruptedCluster({
      attemptsPath,
      clusterId: partialCluster.id,
      commitTornTail: parsedCommits.tornTail,
      directory: input.directory,
      pairRows: parsedPairs.rows.slice(pairPrefixCount),
      pairTornTail: parsedPairs.tornTail,
      stageRows: parsedStages.rows.slice(stagePrefixCount),
      stageTornTail: parsedStages.tornTail,
    });
    parsedStages.rows.splice(stagePrefixCount);
    parsedPairs.rows.splice(pairPrefixCount);
    await Promise.all([
      writeAtomicJsonLines(stagesPath, parsedStages.rows),
      writeAtomicJsonLines(pairsPath, parsedPairs.rows),
      writeAtomicJsonLines(commitsPath, parsedCommits.rows),
    ]);
    await moveInterruptedClusterArtifacts({
      attemptId: await latestAttemptId(attemptsPath),
      clusterId: partialCluster.id,
      directory: input.directory,
    });
  } else if (
    parsedStages.tornTail !== null ||
    parsedPairs.tornTail !== null ||
    parsedCommits.tornTail !== null
  ) {
    throw new Error("C5 completed ledger has a torn final row");
  }

  completedClusterCount = parsedCommits.rows.length;
  const stageIds = new Set(parsedStages.rows.map((row) => row.stageRunId));
  const pairKeys = new Set(parsedPairs.rows.map((row) =>
    `${row.clusterId}/${row.stageId}`
  ));
  let appendTail = Promise.resolve();
  const serialize = (operation: () => Promise<void>): Promise<void> => {
    const current = appendTail.then(operation);
    appendTail = current.catch(() => {});
    return current;
  };
  return {
    appendPair(pair) {
      return serialize(async () => {
        const key = `${pair.clusterId}/${pair.stageId}`;
        if (pairKeys.has(key)) throw new Error(`duplicate C5 pair result ${key}`);
        validatePair(pair, expectedPairs[pairKeys.size]);
        await appendJsonLine(pairsPath, pair);
        parsedPairs.rows.push(pair);
        pairKeys.add(key);
      });
    },
    appendStageExecution(execution) {
      return serialize(async () => {
        if (stageIds.has(execution.stageRunId)) {
          throw new Error(`duplicate C5 stage execution ${execution.stageRunId}`);
        }
        validateStage(execution, expectedStages[stageIds.size]);
        await appendJsonLine(stagesPath, execution);
        parsedStages.rows.push(execution);
        stageIds.add(execution.stageRunId);
      });
    },
    commitCluster(clusterId) {
      return serialize(async () => {
        const clusterIndex = parsedCommits.rows.length;
        const cluster = clusters[clusterIndex];
        if (cluster?.id !== clusterId) {
          throw new Error("C5 cluster commit is outside the frozen execution order");
        }
        const stageRows = parsedStages.rows.slice(
          clusterIndex * perCluster.stageRuns,
          (clusterIndex + 1) * perCluster.stageRuns,
        );
        const pairRows = parsedPairs.rows.slice(
          clusterIndex * perCluster.pairs,
          (clusterIndex + 1) * perCluster.pairs,
        );
        if (
          parsedStages.rows.length !== (clusterIndex + 1) * perCluster.stageRuns ||
          parsedPairs.rows.length !== (clusterIndex + 1) * perCluster.pairs ||
          stageRows.some((row) => row.clusterId !== clusterId) ||
          pairRows.some((row) => row.clusterId !== clusterId)
        ) {
          throw new Error("C5 cluster cannot commit before all exact rows are durable");
        }
        const commit: C5ClusterCommit = {
          clusterId,
          schemaVersion: 1,
        };
        await appendJsonLine(commitsPath, commit);
        parsedCommits.rows.push(commit);
      });
    },
    pairs: parsedPairs.rows,
    remainingClusterIds: clusters
      .slice(completedClusterCount)
      .map((cluster) => cluster.id),
    stageExecutions: parsedStages.rows,
  };
}

interface C5ClusterCommit {
  clusterId: string;
  schemaVersion: 1;
}

// Every cluster runs both arms over the episode's stages, so its durable
// rows are two stage rows per stage and one pair row per stage.
export function clusterRowCounts(
  plan: Pick<C5PilotPlan, "clusters" | "counts">,
): { pairs: number; stageRuns: number } {
  const stageRuns = plan.counts.stageRuns / plan.clusters.length;
  if (!Number.isInteger(stageRuns) || stageRuns <= 0 || stageRuns % 2 !== 0) {
    throw new Error("C5 plan stage runs do not divide evenly across clusters");
  }
  return { pairs: stageRuns / 2, stageRuns };
}

function validateCommitPrefix(
  commits: { rows: C5ClusterCommit[]; tornTail: string | null },
  clusters: C5PilotPlan["clusters"],
  stages: readonly C5RecordedStageExecution[],
  pairs: readonly C5LongitudinalPairResult[],
  perCluster: { pairs: number; stageRuns: number },
): void {
  if (commits.rows.length > clusters.length) {
    throw new Error("C5 cluster commit ledger is incomplete");
  }
  for (const [index, commit] of commits.rows.entries()) {
    const cluster = clusters[index];
    const stageRows = stages.slice(
      index * perCluster.stageRuns,
      (index + 1) * perCluster.stageRuns,
    );
    const pairRows = pairs.slice(
      index * perCluster.pairs,
      (index + 1) * perCluster.pairs,
    );
    if (
      commit.schemaVersion !== 1 ||
      commit.clusterId !== cluster?.id ||
      stageRows.length !== perCluster.stageRuns ||
      pairRows.length !== perCluster.pairs
    ) {
      throw new Error("C5 cluster commit is not bound to its exact durable rows");
    }
  }
}

function orderedExpectedStages(
  plan: C5PilotPlan,
  clusters: C5PilotPlan["clusters"],
): Array<{
  arm: string;
  clusterId: string;
  episodeId: string;
  repetition: number;
  stageId: string;
  stageRunId: string;
}> {
  return clusters.flatMap((cluster) => {
    const runs = cluster.armOrder.map((arm) => plan.episodeArmRuns.find((run) =>
      run.clusterId === cluster.id && run.arm === arm
    )!);
    return runs[0]!.stages.flatMap((_, stageIndex) => runs.map((run) => {
      const stage = run.stages[stageIndex]!;
      return {
        arm: run.arm,
        clusterId: cluster.id,
        episodeId: cluster.episodeId,
        repetition: cluster.repetition,
        stageId: stage.stageId,
        stageRunId: stage.id,
      };
    }));
  });
}

function orderedExpectedPairs(
  plan: C5PilotPlan,
  clusters: C5PilotPlan["clusters"],
): Array<{
  clusterId: string;
  episodeId: string;
  memoryExpectation: string;
  repetition: number;
  stageId: string;
}> {
  return clusters.flatMap((cluster) => {
    const run = plan.episodeArmRuns.find((candidate) =>
      candidate.clusterId === cluster.id
    )!;
    return run.stages.map((stage) => ({
      clusterId: cluster.id,
      episodeId: cluster.episodeId,
      memoryExpectation: stage.memoryExpectation,
      repetition: cluster.repetition,
      stageId: stage.stageId,
    }));
  });
}

function validateStagePrefix(
  rows: readonly C5RecordedStageExecution[],
  expected: ReturnType<typeof orderedExpectedStages>,
): void {
  if (rows.length > expected.length) throw new Error("C5 stage ledger has extra rows");
  rows.forEach((row, index) => validateStage(row, expected[index]));
}

function validatePairPrefix(
  rows: readonly C5LongitudinalPairResult[],
  expected: ReturnType<typeof orderedExpectedPairs>,
): void {
  if (rows.length > expected.length) throw new Error("C5 pair ledger has extra rows");
  rows.forEach((row, index) => validatePair(row, expected[index]));
}

function validateStage(
  execution: C5RecordedStageExecution,
  expected: ReturnType<typeof orderedExpectedStages>[number] | undefined,
): void {
  if (
    expected === undefined ||
    execution.arm !== expected.arm ||
    execution.clusterId !== expected.clusterId ||
    execution.episodeId !== expected.episodeId ||
    execution.repetition !== expected.repetition ||
    execution.stageId !== expected.stageId ||
    execution.stageRunId !== expected.stageRunId ||
    !/^[a-f0-9]{64}$/u.test(execution.stageEvidenceSha256)
  ) {
    throw new Error("C5 stage execution is outside the frozen plan");
  }
}

function validatePair(
  pair: C5LongitudinalPairResult,
  expected: ReturnType<typeof orderedExpectedPairs>[number] | undefined,
): void {
  if (
    expected === undefined ||
    pair.clusterId !== expected.clusterId ||
    pair.episodeId !== expected.episodeId ||
    pair.repetition !== expected.repetition ||
    pair.stageId !== expected.stageId ||
    pair.memoryExpectation !== expected.memoryExpectation
  ) {
    throw new Error("C5 pair result is outside the frozen plan");
  }
  if (
    !/^[a-f0-9]{64}$/u.test(pair.leakageAuditSha256) ||
    pair.evaluations.some((evaluation) =>
      !/^[a-f0-9]{64}$/u.test(evaluation.evaluationEvidenceSha256)
    )
  ) {
    throw new Error("C5 pair result has unbound evidence");
  }
}

function requiredCluster(
  plan: C5PilotPlan,
  clusterId: string,
): C5PilotPlan["clusters"][number] {
  const cluster = plan.clusters.find((candidate) => candidate.id === clusterId);
  if (cluster === undefined) {
    throw new Error("C5 evidence ledger cluster is outside the frozen plan");
  }
  return cluster;
}

async function preserveInterruptedCluster(input: {
  attemptsPath: string;
  clusterId: string;
  commitTornTail: string | null;
  directory: string;
  pairRows: C5LongitudinalPairResult[];
  pairTornTail: string | null;
  stageRows: C5RecordedStageExecution[];
  stageTornTail: string | null;
}): Promise<void> {
  const existingAttempts = parseRows<Record<string, unknown>>(
    await readOptional(input.attemptsPath),
    "C5 run attempt ledger",
  );
  if (existingAttempts.tornTail !== null) {
    throw new Error("C5 run attempt ledger has a torn final row");
  }
  const attemptNumber = existingAttempts.rows.filter((row) =>
    row.clusterId === input.clusterId
  ).length + 1;
  const attemptId = `${clusterDigest(input.clusterId)}-attempt-${attemptNumber}`;
  const attemptEvidencePath = `interrupted-attempts/${attemptId}/attempt.sanitized.json`;
  const record = {
    artifacts: await collectInterruptedArtifacts(input.directory, input.clusterId),
    attemptId,
    clusterId: input.clusterId,
    commitTornTail: tornTailReceipt(input.commitTornTail),
    disposition: "process-interrupted-before-cluster-commit",
    pairRows: input.pairRows,
    pairTornTail: tornTailReceipt(input.pairTornTail),
    schemaVersion: 1,
    stageRows: input.stageRows,
    stageTornTail: tornTailReceipt(input.stageTornTail),
  };
  const bytes = `${JSON.stringify(record, null, 2)}\n`;
  await mkdir(dirname(join(input.directory, attemptEvidencePath)), {
    recursive: true,
  });
  const evidencePath = join(input.directory, attemptEvidencePath);
  try {
    await writeFile(evidencePath, bytes, {
      encoding: "utf8",
      flag: "wx",
    });
  } catch (error) {
    if (!isAlreadyExists(error) || await readRequired(evidencePath) !== bytes) {
      throw error;
    }
  }
  await appendJsonLine(input.attemptsPath, {
    attemptEvidencePath,
    attemptEvidenceSha256: sha256(bytes),
    attemptId,
    clusterId: input.clusterId,
    disposition: "process-interrupted-before-cluster-commit",
    schemaVersion: 1,
  });
}

async function collectInterruptedArtifacts(
  directory: string,
  clusterId: string,
): Promise<Array<{
  bytesBase64: string;
  path: string;
  sha256: string;
}>> {
  const digest = clusterDigest(clusterId);
  const roots = [
    `trajectories/${digest}`,
    `pairs/${digest}`,
  ];
  const artifacts: Array<{
    bytesBase64: string;
    path: string;
    sha256: string;
  }> = [];
  for (const root of roots) {
    await collectFiles(join(directory, ...root.split("/")), root, artifacts);
  }
  return artifacts.sort((first, second) => first.path.localeCompare(second.path));
}

async function collectFiles(
  directory: string,
  relativeDirectory: string,
  output: Array<{ bytesBase64: string; path: string; sha256: string }>,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const relativePath = `${relativeDirectory}/${entry.name}`;
    if (entry.isDirectory()) {
      await collectFiles(path, relativePath, output);
    } else if (entry.isFile() && SAFE_INTERRUPTED_ARTIFACTS.has(entry.name)) {
      const bytes = await readFile(path);
      output.push({
        bytesBase64: bytes.toString("base64"),
        path: relativePath,
        sha256: sha256(bytes),
      });
    }
  }
}

async function moveInterruptedClusterArtifacts(input: {
  attemptId: string;
  clusterId: string;
  directory: string;
}): Promise<void> {
  const digest = clusterDigest(input.clusterId);
  for (const root of ["trajectories", "pairs"] as const) {
    const source = join(input.directory, root, digest);
    if (!await exists(source)) continue;
    const destination = join(
      input.directory,
      "interrupted-attempts",
      input.attemptId,
      "raw",
      root,
      digest,
    );
    await mkdir(dirname(destination), { recursive: true });
    await rename(source, destination);
  }
}

async function clusterArtifactsExist(
  directory: string,
  clusterId: string,
): Promise<boolean> {
  const digest = clusterDigest(clusterId);
  return await exists(join(directory, "trajectories", digest)) ||
    await exists(join(directory, "pairs", digest));
}

async function latestAttemptId(path: string): Promise<string> {
  const parsed = parseRows<Record<string, unknown>>(
    await readRequired(path),
    "C5 run attempt ledger",
  );
  const attemptId = parsed.rows.at(-1)?.attemptId;
  if (typeof attemptId !== "string") throw new Error("C5 run attempt was not recorded");
  return attemptId;
}

function tornTailReceipt(value: string | null): {
  bytesBase64: string;
  sha256: string;
} | null {
  return value === null ? null : {
    bytesBase64: Buffer.from(value).toString("base64"),
    sha256: sha256(value),
  };
}

function parseRows<T>(
  raw: string,
  label: string,
): { rows: T[]; tornTail: string | null } {
  const rows: T[] = [];
  const lines = raw.split("\n");
  for (const [index, line] of lines.entries()) {
    if (line.length === 0) continue;
    try {
      rows.push(JSON.parse(line) as T);
    } catch (error) {
      if (index === lines.length - 1 && !raw.endsWith("\n")) {
        return { rows, tornTail: line };
      }
      throw new Error(`${label} contains invalid JSON at line ${index + 1}`, {
        cause: error,
      });
    }
  }
  return { rows, tornTail: null };
}

async function writeAtomicJsonLines(path: string, rows: readonly unknown[]): Promise<void> {
  const temporary = `${path}.resume-tmp`;
  await rm(temporary, { force: true });
  await writeFile(
    temporary,
    rows.length === 0
      ? ""
      : `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  await rename(temporary, path);
}

async function appendJsonLine(path: string, row: unknown): Promise<void> {
  const current = await readOptional(path);
  const separator = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  await appendFile(path, `${separator}${JSON.stringify(row)}\n`, "utf8");
}

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return "";
    throw error;
  }
}

async function readRequired(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) throw new Error(`missing required C5 file ${basename(path)}`);
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function clusterDigest(clusterId: string): string {
  return sha256(clusterId).slice(0, 16);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
