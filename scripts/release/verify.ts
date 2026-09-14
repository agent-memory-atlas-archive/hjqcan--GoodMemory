import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { z } from "zod";

import { parseCanonicalJson } from "../proof/canonical";
import { assertReleaseManifestReferences, canonicalReleaseJson, sha256, summarizeReleaseChecks } from "./artifact";
import type { ReleaseArtifactRef, ReleaseProfile, ReleaseSourceIdentity } from "./contracts";
import { loadReleaseProfile, satisfiesReleaseRuntimePolicy } from "./profile";
import { runReleaseCommand } from "./runner";

const shaSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const artifactSchema = z.object({
  bytes: z.number().int().nonnegative(), id: z.string().min(1),
  integrity: z.string().optional(), kind: z.enum(["file", "tarball", "tree"]),
  path: z.string().min(1), sha256: shaSchema, tracked: z.boolean(),
}).strict();
const manifestSchema = z.object({
  schemaVersion: z.literal("goodmemory.release-manifest.v1"),
  allRequiredPassed: z.literal(true),
  profileId: z.string(),
  package: z.object({
    distTag: z.string(), installCommandsApplyAfterPublish: z.literal(true),
    name: z.string(), status: z.literal("stable"), tarballName: z.string(),
    version: z.string().regex(/^\d+\.\d+\.\d+$/u),
  }).strict(),
  source: z.object({
    clean: z.literal(true), commit: z.string().regex(/^[a-f0-9]{40}$/u),
    tree: z.string().regex(/^[a-f0-9]{40}$/u), tag: z.string(),
  }).strict(),
  runtime: z.object({ bunVersion: z.string(), nodeVersion: z.string() }).strict(),
  checks: z.array(z.object({
    id: z.string(), title: z.string(), detail: z.string(),
    durationMs: z.number().nonnegative(), evidenceArtifactIds: z.array(z.string()),
    required: z.boolean(), status: z.enum(["fail", "pass", "skip"]),
  }).strict()),
  artifacts: z.array(artifactSchema),
  summary: z.object({ failed: z.number(), passed: z.number(), skipped: z.number(), total: z.number() }).strict(),
}).strict();

function equal(actual: unknown, expected: unknown, label: string): void {
  if (canonicalReleaseJson(actual) !== canonicalReleaseJson(expected)) {
    throw new Error(`Release verification: ${label} mismatch`);
  }
}

function safePath(path: string): void {
  if (path.includes("\\") || path.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error("Release verification: non-canonical artifact path");
  }
}

// Identity replay only. It never rebuilds, packs, installs or publishes.
// Recorded checks are verified as a complete profile-bound receipt, not rerun.
export function verifyReleaseBundle(input: {
  profile: ReleaseProfile;
  source: ReleaseSourceIdentity;
  manifestBytes: Uint8Array | string;
  archiveBytes: Uint8Array;
  artifactFiles: ReadonlyMap<string, Uint8Array>;
}) {
  const manifest = manifestSchema.parse(parseCanonicalJson(input.manifestBytes));
  equal(manifest.profileId, input.profile.id, "profile");
  equal(manifest.package, input.profile.package, "package metadata");
  equal(manifest.source, input.source, "clean source identity");
  equal(manifest.source.tag, `v${manifest.package.version}`, "stable tag");
  for (const [actual, policy] of [
    [manifest.runtime.bunVersion, input.profile.runtime.bun],
    [manifest.runtime.nodeVersion, input.profile.runtime.node],
  ]) {
    if (!satisfiesReleaseRuntimePolicy(actual!, policy!)) throw new Error("Release verification: runtime policy mismatch");
  }
  assertReleaseManifestReferences(manifest);
  const requiredChecks = new Map([
    ...["source-identity", "runtime-identity", "release-source-identity", "version", "pack", "language-consumers", "source-stability"].map(id => [id, true] as const),
    ...input.profile.evidenceInputs.map(item => [item.checkId, true] as const),
    ...input.profile.checks.map(check => [check.id, check.required] as const),
  ]);
  equal(manifest.checks.map(check => check.id).sort(), [...requiredChecks.keys()].sort(), "complete check inventory");
  for (const check of manifest.checks) {
    equal(check.required, requiredChecks.get(check.id), `required check ${check.id}`);
    if (check.required && check.status !== "pass") throw new Error(`Release verification: failed check ${check.id}`);
  }
  equal(manifest.summary, summarizeReleaseChecks(manifest.checks), "check summary");
  const expectedArtifacts = new Map<string, Pick<ReleaseArtifactRef, "path" | "kind" | "tracked"> & { sha256?: string }>([
    ...input.profile.evidenceInputs.map(item => [item.id, { path: item.path, kind: item.kind, tracked: true, sha256: item.sha256 }] as const),
    ...input.profile.checks.flatMap(check => check.generatedEvidence ? [[check.generatedEvidence.id, { path: check.generatedEvidence.path, kind: "file", tracked: false }] as const] : []),
    ["release-tarball", { path: input.profile.package.tarballName, kind: "tarball", tracked: false }] as const,
  ]);
  equal(manifest.artifacts.map(artifact => artifact.id).sort(), [...expectedArtifacts.keys()].sort(), "complete artifact inventory");
  equal(new Set(manifest.artifacts.map(artifact => artifact.path)).size, manifest.artifacts.length, "unique artifact paths");
  for (const artifact of manifest.artifacts) {
    safePath(artifact.path);
    const expected = expectedArtifacts.get(artifact.id)!;
    for (const [field, value] of Object.entries(expected)) equal(artifact[field as keyof typeof artifact], value, `artifact ${artifact.id} ${field}`);
  }
  for (const check of manifest.checks) {
    const expectedIds = [
      ...input.profile.evidenceInputs.filter(item => item.checkId === check.id).map(item => item.id),
      ...input.profile.checks.flatMap(item => item.id === check.id && item.generatedEvidence ? [item.generatedEvidence.id] : []),
      ...(["pack", "language-consumers"].includes(check.id) ? ["release-tarball"] : []),
    ];
    equal([...check.evidenceArtifactIds].sort(), expectedIds.sort(), `exact evidence edges for ${check.id}`);
  }
  const archiveBytes = gunzipSync(input.archiveBytes, { maxOutputLength: 256 * 1024 * 1024 });
  const archive = z.object({
    schemaVersion: z.literal("goodmemory.release-evidence-archive.v1"),
    manifest: manifestSchema,
    evidence: z.array(z.object({ ref: artifactSchema, contentBase64: z.string() }).strict()),
  }).strict().parse(parseCanonicalJson(archiveBytes));
  equal(archive.manifest, manifest, "embedded manifest");
  equal(archive.evidence.map(item => item.ref.id).sort(), manifest.artifacts.filter(item => item.id !== "release-tarball").map(item => item.id).sort(), "complete archive evidence");
  for (const entry of archive.evidence) {
    equal(entry.ref, manifest.artifacts.find(artifact => artifact.id === entry.ref.id), "embedded artifact reference");
    const bytes = Buffer.from(entry.contentBase64, "base64");
    equal(bytes.toString("base64"), entry.contentBase64, "canonical evidence encoding");
    equal(bytes.length, entry.ref.bytes, "evidence byte length");
    equal(sha256(bytes), entry.ref.sha256, "evidence hash");
  }
  const standalone = manifest.artifacts.filter(artifact => artifact.id === "release-tarball" || artifact.id === "kimi-plugin-archive");
  equal([...input.artifactFiles.keys()].sort(), standalone.map(item => item.path).sort(), "standalone artifact inventory");
  for (const artifact of standalone) {
    const bytes = input.artifactFiles.get(artifact.path)!;
    equal(bytes.byteLength, artifact.bytes, `standalone length ${artifact.id}`);
    equal(sha256(bytes), artifact.sha256, `standalone hash ${artifact.id}`);
    if (artifact.id === "release-tarball") {
      if (bytes.byteLength >= input.profile.artifact.maxTarballBytes) throw new Error("Release verification: oversized tarball");
      equal(`sha512-${createHash("sha512").update(bytes).digest("base64")}`, artifact.integrity, "tarball integrity");
    }
  }
  return { verified: true as const, version: manifest.package.version, tag: manifest.source.tag, commit: manifest.source.commit, tree: manifest.source.tree, distTag: manifest.package.distTag, integrity: manifest.artifacts.find(item => item.id === "release-tarball")!.integrity! };
}

async function readRegular(path: string): Promise<Buffer> {
  if (!(await lstat(path)).isFile() || await realpath(path) !== resolve(path)) throw new Error(`Release verification: non-regular or symlink path ${path}`);
  return readFile(path);
}

export async function verifyPreparedRelease(input: { artifactDirectory: string; repoRoot: string }) {
  const profile = await loadReleaseProfile(input.repoRoot);
  const git = async (args: string[]) => {
    const result = await runReleaseCommand({ command: "git", args, cwd: input.repoRoot });
    if (result.code !== 0) throw new Error(`Release verification: git ${args[0]} failed`);
    return result.stdout.trim();
  };
  const tag = `v${profile.package.version}`;
  const [commit, tree, status, taggedCommit] = await Promise.all([
    git(["rev-parse", "HEAD"]), git(["rev-parse", "HEAD^{tree}"]),
    git(["status", "--porcelain", "--untracked-files=all"]),
    git(["rev-parse", "--verify", `refs/tags/${tag}^{commit}`]),
  ]);
  equal(taggedCommit, commit, "peeled tag");
  const root = resolve(input.artifactDirectory);
  const artifactFiles = new Map<string, Uint8Array>();
  for (const path of [profile.package.tarballName, ...profile.checks.flatMap(check => check.generatedEvidence?.id === "kimi-plugin-archive" ? [check.generatedEvidence.path] : [])]) {
    safePath(path);
    artifactFiles.set(path, await readRegular(join(root, path)));
  }
  return verifyReleaseBundle({
    profile, source: { commit, tree, clean: status.length === 0, tag }, artifactFiles,
    manifestBytes: await readRegular(join(root, "release-manifest.json")),
    archiveBytes: await readRegular(join(root, `${profile.package.name}-${profile.package.version}-release-evidence.json.gz`)),
  });
}

if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2);
    if (args.length !== 2 || args[0] !== "--artifact-dir" || !args[1]) throw new Error("Usage: bun scripts/release/verify.ts --artifact-dir <dir>");
    console.log(JSON.stringify(await verifyPreparedRelease({ artifactDirectory: args[1], repoRoot: resolve(dirname(import.meta.path), "../..") })));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
