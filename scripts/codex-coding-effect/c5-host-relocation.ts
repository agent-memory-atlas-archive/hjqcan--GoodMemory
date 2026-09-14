import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";

import { buildC3HostConfigurationEvidence } from "./c3-host-configuration";
import { hashC5ComparableHostEnvironment, parseC5HostEnvironment } from "./c5-host-environment";

// A post-run policy approved by the maintainer. This is not a change to the
// frozen runner or a general host-equivalence rule. The strict route remains.
export const C5_HOST_RELOCATION_POLICY_ID =
  "run-c5-level2-flat-20260904T100113Z-runner-relocation-v1";
export const C5_RUNNER_RELOCATION_ROOTS = [
  "/Users/hjqcan/workspace/GoodMemory",
  "/Volumes/data/GoodMemory-external/phase73-recovery-20260905-40fbBO/runner",
] as const;
const RUN_ID = "run-c5-level2-flat-20260904T100113Z";
const PLAN_SHA = "91d358512d840f6547990bd28737b29d27e65650363387afa336db387a1da19e";
const SOURCE_SHA = "56fdf4fccb4b7b413443a4eece70a7fde7e3f01d77af7b53f3a6719667e5247e";
const REVIEW_MANIFEST_SHA = "f5a54161105564816d7ff7ca137d0801b643334c187dcbfec4a8525fdc57a8dd";
const CAPTURE_MANIFEST_SHA = "cf0f6c5cff65a61b94bb30bb934952daeba52c918e687186663aadf3e06c1939";
const HOST_HASHES = [
  "8bf82f2b1d2d1a1607dde918d2a130b3c75e268d41bc3d6a190c8994ac7f1b61",
  "a52d08931ef3b472ed52a720f67eec375e6f59e040e8217f2596f688f0c24f07",
] as const;
const DENIED_LABELS = [
  "asset-lock", "codex-auth-source", "current-runtime-auth", "current-runtime-config",
  "dataset-manifest", "evaluator-cases", "evaluator-runner", "frozen-prehistory",
  "gold-patch", "goodmemory-source-package", "installed-package", "other-arm-runtime-auth",
  "other-arm-runtime-config", "other-arm-workspace", "output-root", "package-tarball",
  "runner-source", "source-repository",
] as const;
const SHA = z.string().regex(/^[a-f0-9]{64}$/u);
export const C5_HOST_RELOCATION_EVIDENCE_PATH = "host-relocation-evidence.json";
const referenceSchema = z.object({
  policyId: z.literal(C5_HOST_RELOCATION_POLICY_ID),
  path: z.literal(C5_HOST_RELOCATION_EVIDENCE_PATH),
  bytes: z.number().int().positive(),
  sha256: SHA,
}).strict();
const capsuleSchema = z.object({
  policyId: z.literal(C5_HOST_RELOCATION_POLICY_ID),
  reviewManifest: z.string(),
  captureManifest: z.string(),
  supplementalFiles: z.array(z.object({ path: z.string(), content: z.string() }).strict()),
}).strict();
const reviewManifestSchema = z.object({
  files: z.array(z.object({ path: z.string(), byteLength: z.number().int(), sha256: SHA })),
  fileListAggregateSha256: SHA,
});
const permissionSchema = z.object({
  configSha256: SHA,
  deniedReads: z.array(z.object({
    denied: z.literal(true),
    exitCode: z.literal(1),
    label: z.string(),
    pathSha256: SHA,
  }).strict()).length(18),
  networkAccess: z.literal(false),
  networkDenied: z.literal(true),
  networkPositiveControl: z.literal(true),
  passed: z.literal(true),
  phase: z.literal("preflight"),
  profileName: z.literal("c3-task"),
  reasons: z.array(z.never()).length(0),
  schemaVersion: z.literal(1),
  workspaceRead: z.literal(true),
  workspaceWrite: z.literal(true),
}).strict();

export type C5HostRelocationEvidence = z.infer<typeof capsuleSchema>;
export type C5HostRelocationReference = z.infer<typeof referenceSchema>;

export function parseC5HostRelocationReference(value: unknown): C5HostRelocationReference {
  return referenceSchema.parse(value);
}
export interface C5HostRelocationDisclosure {
  policyId: typeof C5_HOST_RELOCATION_POLICY_ID;
  strictHostIdentityDecision: "rejected";
  originalHostIdentitySha256: string[];
  clusterPartition: [18, 72];
  permissionReceiptsVerified: 180;
  reviewInputManifestSha256: string;
  rawCaptureManifestSha256: string;
  relocatedComparableEnvironmentSha256: string;
  historicalSourceStabilityProven: false;
  externalAuthenticityVerified: false;
  scientificValidityEstablished: false;
}

export function parseC5HostRelocationEvidence(value: unknown): C5HostRelocationEvidence {
  const evidence = capsuleSchema.parse(value);
  requireEqual(sha256(evidence.reviewManifest), REVIEW_MANIFEST_SHA, "review input manifest");
  requireEqual(sha256(evidence.captureManifest), CAPTURE_MANIFEST_SHA, "raw capture manifest");
  const manifest = reviewManifestSchema.parse(JSON.parse(evidence.reviewManifest));
  const expected = manifest.files.filter(file => !file.path.startsWith("raw/"))
    .map(file => file.path).sort();
  const actual = evidence.supplementalFiles.map(file => file.path).sort();
  requireEqual(JSON.stringify(actual), JSON.stringify(expected), "supplemental file membership");
  return evidence;
}

// Sources are selected only from the pinned manifest. Never follow its
// informational absolute `source` paths, and never execute copied helpers.
export async function loadC5HostRelocationEvidence(input: {
  reviewDirectory: string;
  captureManifestPath: string;
}): Promise<C5HostRelocationEvidence> {
  const root = resolve(input.reviewDirectory);
  const reviewManifest = await readRegularFile(join(root, "manifest.json"));
  requireEqual(sha256(reviewManifest), REVIEW_MANIFEST_SHA, "review input manifest");
  const manifest = reviewManifestSchema.parse(JSON.parse(reviewManifest));
  const supplementalFiles = [];
  for (const file of manifest.files.filter(file => !file.path.startsWith("raw/"))) {
    supplementalFiles.push({ path: file.path, content: await readRegularFile(join(root, file.path)) });
  }
  return parseC5HostRelocationEvidence({
    policyId: C5_HOST_RELOCATION_POLICY_ID,
    reviewManifest,
    captureManifest: await readRegularFile(resolve(input.captureManifestPath)),
    supplementalFiles,
  });
}

export function normalizeC5RunnerDenyConfiguration(text: string, runnerRoot: string): string {
  if (!(C5_RUNNER_RELOCATION_ROOTS as readonly string[]).includes(runnerRoot) ||
      text.includes("<runner-source-root>")) {
    throw new Error("C5 relocation: unknown runner root or pre-normalized configuration");
  }
  const key = JSON.stringify(runnerRoot);
  if (text.split(key).length !== 2 || C5_RUNNER_RELOCATION_ROOTS.some(root =>
    root !== runnerRoot && text.includes(JSON.stringify(root)))) {
    throw new Error("C5 relocation: runner deny key is absent, ambiguous, or from both roots");
  }
  let section = "";
  let matches = 0;
  const lines = text.split("\n").map(line => {
    if (line.startsWith("[")) section = line;
    if (line !== `${key} = "deny"`) return line;
    if (section !== "[permissions.c3-task.filesystem]") {
      throw new Error("C5 relocation: runner deny key is in the wrong permission section");
    }
    matches += 1;
    return '"<runner-source-root>" = "deny"';
  });
  if (matches !== 1) throw new Error("C5 relocation: expected exactly one unchanged runner deny");
  return lines.join("\n");
}

export function verifyC5RelocationPermission(value: unknown, input: {
  configSha256: string;
  runnerRoot: string;
}): void {
  const receipt = permissionSchema.parse(value);
  requireEqual(receipt.configSha256, input.configSha256, "permission config cross-binding");
  requireEqual(JSON.stringify(receipt.deniedReads.map(probe => probe.label).sort()),
    JSON.stringify(DENIED_LABELS), "complete permission probe labels");
  for (const [label, suffix] of [
    ["runner-source", "scripts/codex-coding-effect/c5-native-adapter.ts"],
    ["goodmemory-source-package", "package.json"],
  ] as const) {
    requireEqual(receipt.deniedReads.find(probe => probe.label === label)!.pathSha256,
      sha256(`${input.runnerRoot}/${suffix}`), `${label} target path`);
  }
}

export function verifyC5HostRelocation(input: {
  evidence: C5HostRelocationEvidence;
  rawFiles: ReadonlyMap<string, string>;
}): C5HostRelocationDisclosure {
  const evidence = parseC5HostRelocationEvidence(input.evidence);
  const supplements = new Map(evidence.supplementalFiles.map(file => [file.path, file.content]));
  const read = (path: string) => {
    const bytes = path.startsWith("raw/") ? input.rawFiles.get(path.slice(4)) : supplements.get(path);
    if (bytes === undefined) throw new Error(`C5 relocation: missing bound input ${path}`);
    return bytes;
  };
  const identity = z.object({ runId: z.string(), planSha256: SHA,
    runnerSourceAggregateSha256: SHA, mutableRootsSha256: SHA,
  }).parse(JSON.parse(read("raw/run-identity.json")));
  requireEqual(identity.runId, RUN_ID, "run");
  requireEqual(identity.planSha256, PLAN_SHA, "run plan binding");
  requireEqual(identity.runnerSourceAggregateSha256, SOURCE_SHA, "run source binding");
  const planBytes = read("raw/pilot-plan.json");
  requireEqual(sha256(planBytes), PLAN_SHA, "frozen plan bytes");
  const plan = z.object({ clusters: z.array(z.object({
    id: z.string(), executionPosition: z.number().int(),
  })).length(90) }).parse(JSON.parse(planBytes));

  const materialization = z.object({ runId: z.string(), runnerRoot: z.string(),
    runnerSourceAggregateSha256: SHA, runnerSourceFileCount: z.literal(171),
    historicalSourceDriftAcknowledged: z.literal(true), historicalSourceStabilityProven: z.literal(false),
    independentReviewRequired: z.literal(true),
    ledger: z.array(z.object({ path: z.string(), bytes: z.number().int(), sha256: SHA })),
  }).parse(JSON.parse(read("recovery-history/1/materialization.json")));
  const recovery = z.object({ runId: z.string(), runnerSourceAggregateSha256: SHA,
    planSha256: SHA, mutableRootsSha256: SHA, packageSha256: SHA, codexExecutableSha256: SHA,
    historicalDriftRequiresIndependentReview: z.literal(true),
  }).parse(JSON.parse(read("recovery-history/1/preflight.json")));
  requireEqual(materialization.runId, RUN_ID, "materialization run");
  requireEqual(materialization.runnerRoot, C5_RUNNER_RELOCATION_ROOTS[1], "materialization runner root");
  requireEqual(materialization.runnerSourceAggregateSha256, SOURCE_SHA, "materialization source");
  requireEqual(recovery.runId, RUN_ID, "recovery run");
  requireEqual(recovery.planSha256, PLAN_SHA, "recovery plan");
  requireEqual(recovery.runnerSourceAggregateSha256, SOURCE_SHA, "recovery source");
  requireEqual(recovery.mutableRootsSha256, identity.mutableRootsSha256, "recovery mutable-roots binding");
  const prefix = read("raw/cluster-commits.jsonl").split("\n").slice(0, 18).join("\n") + "\n";
  const prefixReceipt = materialization.ledger.find(file => file.path === "cluster-commits.jsonl");
  requireEqual(prefixReceipt?.bytes, Buffer.byteLength(prefix), "recovery commit prefix length");
  requireEqual(prefixReceipt?.sha256, sha256(prefix), "recovery commit prefix");
  requireEqual(sha256(prefix), "5e4c220aee0149e90f99bca34d87540ceffd8cd856f239066addb3947dd3905b", "sealed 18-cluster prefix");

  let comparable: string | undefined;
  const observedHosts = new Set<string>();
  for (const [index, cluster] of plan.clusters.entries()) {
    requireEqual(cluster.executionPosition, index + 1, "cluster partition position");
    const group = index < 18 ? 0 : 1;
    const runnerRoot = C5_RUNNER_RELOCATION_ROOTS[group];
    const root = `raw/trajectories/${sha256(cluster.id).slice(0, 16)}`;
    const preflight = z.object({ clusterId: z.string(), hostEnvironment: z.unknown(),
      hostIdentity: z.record(z.string(), z.unknown()), hostIdentitySha256: SHA,
      arms: z.array(z.object({ arm: z.enum(["flat-summary", "goodmemory-installed"]), permissionIsolationSha256: SHA })).length(2),
    }).parse(JSON.parse(read(`${root}/host-preflight.sanitized.json`)));
    requireEqual(preflight.clusterId, cluster.id, "preflight cluster binding");
    const environment = parseC5HostEnvironment(preflight.hostEnvironment);
    requireEqual(preflight.hostIdentity.comparableHostEnvironmentSha256,
      hashC5ComparableHostEnvironment(environment), "original comparable host hash");
    requireEqual(sha256(JSON.stringify(preflight.hostIdentity)), preflight.hostIdentitySha256,
      "original host identity hash");
    const normalized = structuredClone(environment);
    const seenArms = new Set<string>();
    for (const arm of preflight.arms) {
      if (seenArms.has(arm.arm)) throw new Error("C5 relocation: duplicate preflight arm");
      seenArms.add(arm.arm);
      const configuration = normalized.configurations.arms[
        arm.arm === "flat-summary" ? "noMemory" : "goodmemoryInstalled"
      ];
      const permissionBytes = read(`${root}/${arm.arm}/permission-isolation-preflight.sanitized.json`);
      // Check semantics before sealed byte pins, so semantic negatives remain
      // meaningful even when their enclosing receipts are rebound.
      verifyC5RelocationPermission(JSON.parse(permissionBytes), {
        configSha256: configuration.codexConfig.sourceSha256, runnerRoot,
      });
      requireEqual(sha256(permissionBytes), arm.permissionIsolationSha256, "permission arm binding");
      configuration.codexConfig.normalizedText = normalizeC5RunnerDenyConfiguration(
        configuration.codexConfig.normalizedText, runnerRoot,
      );
    }
    normalized.configurations = buildC3HostConfigurationEvidence(normalized.configurations.arms);
    const hash = hashC5ComparableHostEnvironment(normalized);
    if (comparable === undefined) comparable = hash;
    requireEqual(hash, comparable, "non-relocation host configuration drift");
    requireEqual(preflight.hostIdentity.codexExecutableSha256, recovery.codexExecutableSha256, "recovery executable");
    requireEqual(preflight.hostIdentity.goodMemoryPackageSha256, recovery.packageSha256, "recovery package");
    requireEqual(preflight.hostIdentitySha256, HOST_HASHES[group], "original host partition");
    observedHosts.add(preflight.hostIdentitySha256);
  }
  requireEqual(observedHosts.size, 2, "two retained original host identities");
  requireEqual(comparable, "7ae9fa5fa4159af38c238a190a899f0f3711205705a7cb0440b9ba05885fb575",
    "sealed relocation comparison");

  const reviewManifest = reviewManifestSchema.parse(JSON.parse(evidence.reviewManifest));
  for (const file of reviewManifest.files) {
    const bytes = read(file.path);
    requireEqual(Buffer.byteLength(bytes), file.byteLength, `review input length ${file.path}`);
    requireEqual(sha256(bytes), file.sha256, `review input hash ${file.path}`);
  }
  const capture = z.object({ rawFiles: z.array(z.object({ path: z.string(), bytes: z.number().int(), sha256: SHA })) })
    .parse(JSON.parse(evidence.captureManifest));
  const capturedFiles = new Map(capture.rawFiles.map(file => [file.path, file]));
  // Bind EVERY currently projected raw file to the original complete capture,
  // not only the 284-file host-review subset. Exact projection membership is
  // separately derived and checked by the existing C5 evidence graph.
  for (const [path, bytes] of input.rawFiles) {
    const frozen = capturedFiles.get(path);
    requireEqual(frozen?.bytes, Buffer.byteLength(bytes), `captured input length ${path}`);
    requireEqual(frozen?.sha256, sha256(bytes), `captured input hash ${path}`);
  }
  return {
    policyId: C5_HOST_RELOCATION_POLICY_ID,
    strictHostIdentityDecision: "rejected",
    originalHostIdentitySha256: [...HOST_HASHES],
    clusterPartition: [18, 72],
    permissionReceiptsVerified: 180,
    reviewInputManifestSha256: REVIEW_MANIFEST_SHA,
    rawCaptureManifestSha256: CAPTURE_MANIFEST_SHA,
    relocatedComparableEnvironmentSha256: comparable!,
    historicalSourceStabilityProven: false,
    externalAuthenticityVerified: false,
    scientificValidityEstablished: false,
  };
}

function sha256(bytes: string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) throw new Error(`C5 relocation: ${label} mismatch`);
}

async function readRegularFile(path: string): Promise<string> {
  if (!(await lstat(path)).isFile() || await realpath(path) !== resolve(path)) {
    throw new Error(`C5 relocation: expected non-symlink regular file ${path}`);
  }
  return readFile(path, "utf8");
}
