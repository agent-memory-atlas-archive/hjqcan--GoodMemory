import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import { canonicalReleaseJson, createReleaseArtifactRef, summarizeReleaseChecks } from "../../scripts/release/artifact";
import type { ReleaseManifestV1, ReleaseProfile } from "../../scripts/release/contracts";
import { verifyReleaseBundle } from "../../scripts/release/verify";

function fixture() {
  const profile: ReleaseProfile = {
    id: "goodmemory-v0.8",
    package: { name: "goodmemory", version: "0.8.0", status: "stable", distTag: "latest", installCommandsApplyAfterPublish: true, tarballName: "goodmemory-0.8.0.tgz" },
    runtime: { bun: ">=1.3.0", node: ">=20.0.0" },
    artifact: { maxTarballBytes: 4194304, requiredFiles: [], consumerSmoke: "" },
    checks: [{ id: "tests", required: true, title: "Tests", command: "bun", args: ["test"], successDetail: "passed" }, { id: "kimi-plugin", required: true, title: "Plugin", command: "bun", args: [], successDetail: "passed", generatedEvidence: { id: "kimi-plugin-archive", path: "plugin.zip" } }],
    evidenceInputs: [],
  };
  const tarball = Buffer.from("synthetic tarball identity fixture");
  const plugin = Buffer.from("synthetic plugin identity fixture");
  const artifacts = [
    createReleaseArtifactRef({ id: "release-tarball", path: profile.package.tarballName, bytes: tarball, kind: "tarball", tracked: false, integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}` }),
    createReleaseArtifactRef({ id: "kimi-plugin-archive", path: "plugin.zip", bytes: plugin, kind: "file", tracked: false }),
  ];
  const checks = ["source-identity", "runtime-identity", "release-source-identity", "version", "tests", "kimi-plugin", "pack", "language-consumers", "source-stability"].map(id => ({ id, title: id, detail: "passed", durationMs: 1, evidenceArtifactIds: id === "kimi-plugin" ? ["kimi-plugin-archive"] : ["pack", "language-consumers"].includes(id) ? ["release-tarball"] : [], required: true, status: "pass" as const }));
  const source = { commit: "a".repeat(40), tree: "b".repeat(40), clean: true, tag: "v0.8.0" };
  const manifest: ReleaseManifestV1 = { schemaVersion: "goodmemory.release-manifest.v1", profileId: profile.id, package: profile.package, source, runtime: { bunVersion: "1.3.14", nodeVersion: "20.20.0" }, allRequiredPassed: true, checks, artifacts, summary: summarizeReleaseChecks(checks) };
  const evidence = [{ ref: artifacts[1]!, contentBase64: plugin.toString("base64") }];
  const files = new Map([[profile.package.tarballName, tarball], ["plugin.zip", plugin]]);
  return { profile, source, manifest, evidence, files };
}

function verify(value: ReturnType<typeof fixture>) {
  return verifyReleaseBundle({ profile: value.profile, source: value.source, manifestBytes: canonicalReleaseJson(value.manifest), archiveBytes: gzipSync(canonicalReleaseJson({ schemaVersion: "goodmemory.release-evidence-archive.v1", manifest: value.manifest, evidence: value.evidence })), artifactFiles: value.files });
}

describe("read-only exact release artifact verification", () => {
  it("accepts one source-bound artifact set without packing or publishing", () => {
    expect(verify(fixture())).toMatchObject({ version: "0.8.0", tag: "v0.8.0", verified: true });
  });

  it("rejects malformed UTF-8 instead of accepting decoder replacement characters", () => {
    const value = fixture();
    value.manifest.checks[0]!.detail = "\uFFFD";
    const archiveText = canonicalReleaseJson({ schemaVersion: "goodmemory.release-evidence-archive.v1", manifest: value.manifest, evidence: value.evidence });
    const archiveBytes = Buffer.from(archiveText);
    const offset = archiveBytes.indexOf(Buffer.from("\uFFFD"));
    expect(offset).toBeGreaterThan(-1);
    const malformed = Buffer.concat([archiveBytes.subarray(0, offset), Buffer.from([0xff]), archiveBytes.subarray(offset + 3)]);
    expect(() => verifyReleaseBundle({ profile: value.profile, source: value.source, manifestBytes: canonicalReleaseJson(value.manifest), archiveBytes: gzipSync(malformed), artifactFiles: value.files })).toThrow();
    const manifestBytes = Buffer.from(canonicalReleaseJson(value.manifest));
    const manifestOffset = manifestBytes.indexOf(Buffer.from("\uFFFD"));
    const malformedManifest = Buffer.concat([manifestBytes.subarray(0, manifestOffset), Buffer.from([0xff]), manifestBytes.subarray(manifestOffset + 3)]);
    expect(() => verifyReleaseBundle({ profile: value.profile, source: value.source, manifestBytes: malformedManifest, archiveBytes: gzipSync(archiveBytes), artifactFiles: value.files })).toThrow("UTF-8");
  });

  it("rejects an archive whose embedded manifest differs from the standalone manifest", () => {
    const value = fixture();
    const manifestBytes = canonicalReleaseJson(value.manifest);
    value.manifest.checks[0]!.detail = "Changed only inside archive";
    expect(() => verifyReleaseBundle({ profile: value.profile, source: value.source, manifestBytes, archiveBytes: gzipSync(canonicalReleaseJson({ schemaVersion: "goodmemory.release-evidence-archive.v1", manifest: value.manifest, evidence: value.evidence })), artifactFiles: value.files })).toThrow("embedded manifest");
  });

  it("rejects incomplete checks, substituted bytes, source drift and ambiguous paths", () => {
    const mutations: Array<(value: ReturnType<typeof fixture>) => void> = [
      value => { value.manifest.checks.pop(); },
      value => { value.manifest.checks.push(value.manifest.checks[0]!); },
      value => { value.manifest.checks[0]!.required = false; },
      value => { value.manifest.checks[0]!.status = "fail"; },
      value => { value.manifest.checks[0]!.status = "skip"; },
      value => { value.manifest.checks.find(check => check.id === "pack")!.evidenceArtifactIds = []; },
      value => { value.manifest.checks.find(check => check.id === "language-consumers")!.evidenceArtifactIds = ["kimi-plugin-archive"]; },
      value => { value.manifest.checks.find(check => check.id === "kimi-plugin")!.evidenceArtifactIds.push("kimi-plugin-archive"); },
      value => { value.manifest.checks[0]!.evidenceArtifactIds.push("release-tarball"); },
      value => { value.manifest.allRequiredPassed = false; },
      value => { value.manifest.source = { ...value.source, commit: "c".repeat(40) }; },
      value => { value.source = { ...value.source, clean: false }; },
      value => { value.source = { ...value.source, tag: "v0.8.1" }; },
      value => { value.files.set("goodmemory-0.8.0.tgz", Buffer.from("substituted")); },
      value => { value.files.set("plugin.zip", Buffer.from("substituted")); },
      value => { value.manifest.artifacts[0]!.integrity = "sha512-wrong"; },
      value => { value.manifest.artifacts[1]!.path = "a/../plugin.zip"; },
      value => { value.manifest.artifacts[1]!.path = "goodmemory-0.8.0.tgz"; },
      value => { value.evidence = []; },
      value => { value.evidence.push(value.evidence[0]!); },
      value => { value.evidence[0]!.contentBase64 += "\n"; },
      value => { value.manifest.runtime.nodeVersion = "18.0.0"; },
      value => { value.manifest.summary.passed = 999; },
    ];
    for (const mutate of mutations) {
      const value = fixture();
      mutate(value);
      expect(() => verify(value)).toThrow();
    }
  });
});
