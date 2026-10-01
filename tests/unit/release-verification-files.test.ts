import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

import { createReleaseArtifactRef, summarizeReleaseChecks, writeReleaseArtifacts } from "../../scripts/release/artifact";
import type { ReleaseManifestV1 } from "../../scripts/release/contracts";
import { loadReleaseProfile } from "../../scripts/release/profile";
import { runReleaseCommand } from "../../scripts/release/runner";
import { verifyPreparedRelease } from "../../scripts/release/verify";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("release verifier filesystem and Git boundaries", () => {
  it("reads writer-produced synthetic receipts and rejects dirty, wrong-tag and symlink inputs", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "goodmemory-release-verifier-")));
    roots.push(root);
    const repoRoot = join(root, "source");
    const artifactDirectory = join(root, "artifacts");
    await mkdir(repoRoot);
    await mkdir(artifactDirectory);
    const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
    pkg.version = "0.8.0";
    pkg.goodmemoryRelease = { installCommandsApplyAfterPublish: true, status: "stable", npmDistTag: "latest" };
    const packageBytes = JSON.stringify(pkg);
    await writeFile(join(repoRoot, "package.json"), packageBytes);
    const git = async (args: string[]) => {
      const result = await runReleaseCommand({ command: "git", args, cwd: repoRoot });
      if (result.code !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    await git(["init"]);
    await git(["add", "package.json"]);
    await git(["-c", "user.name=Release fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Synthetic verifier fixture"]);
    const initialCommit = await git(["rev-parse", "HEAD"]);
    const profile = await loadReleaseProfile(repoRoot);
    const evidence = [];
    for (const input of profile.evidenceInputs) {
      const bytes = await readFile(new URL(`../../${input.path}`, import.meta.url));
      await mkdir(dirname(join(repoRoot, input.path)), { recursive: true });
      await writeFile(join(repoRoot, input.path), bytes);
      evidence.push({ bytes, ref: createReleaseArtifactRef({ ...input, bytes, tracked: true }) });
    }
    await git(["add", "."]);
    await git(["-c", "user.name=Release fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Synthetic evidence fixture"]);
    await git(["tag", "v0.8.0"]);
    const source = { commit: await git(["rev-parse", "HEAD"]), tree: await git(["rev-parse", "HEAD^{tree}"]), clean: true, tag: "v0.8.0" };
    for (const check of profile.checks) {
      if (!check.generatedEvidence) continue;
      const bytes = Buffer.from(`Synthetic ${check.id} evidence; no actual gate execution claimed`);
      const ref = createReleaseArtifactRef({ ...check.generatedEvidence, bytes, kind: "file", tracked: false });
      evidence.push({ bytes, ref });
      if (ref.id === "kimi-plugin-archive") await writeFile(join(artifactDirectory, ref.path), bytes);
    }
    const tarballBytes = Buffer.from("Synthetic artifact identity fixture; not an installable package");
    const tarball = createReleaseArtifactRef({ id: "release-tarball", path: profile.package.tarballName, bytes: tarballBytes, kind: "tarball", tracked: false, integrity: `sha512-${createHash("sha512").update(tarballBytes).digest("base64")}` });
    await writeFile(join(artifactDirectory, tarball.path), tarballBytes);
    const checks = [
      ...["source-identity", "runtime-identity", "release-source-identity", "version", "pack", "language-consumers", "source-stability"].map(id => ({ id, evidenceArtifactIds: ["pack", "language-consumers"].includes(id) ? ["release-tarball"] : [] })),
      ...profile.evidenceInputs.map(input => ({ id: input.checkId, evidenceArtifactIds: [input.id] })),
      ...profile.checks.map(check => ({ id: check.id, evidenceArtifactIds: check.generatedEvidence ? [check.generatedEvidence.id] : [] })),
    ].map(check => ({ ...check, required: true, title: check.id, detail: "Synthetic test receipt, not a release gate result", status: "pass" as const, durationMs: 0 }));
    const manifest: ReleaseManifestV1 = { allRequiredPassed: true, artifacts: [...evidence.map(entry => entry.ref), tarball], checks, source, runtime: { bunVersion: "1.3.14", nodeVersion: "20.20.0" }, package: profile.package, profileId: profile.id, schemaVersion: "goodmemory.release-manifest.v1", summary: summarizeReleaseChecks(checks) };
    await writeReleaseArtifacts({ evidence, manifest, outputDir: artifactDirectory });
    expect(await verifyPreparedRelease({ artifactDirectory, repoRoot })).toMatchObject({ verified: true, version: "0.8.0", commit: source.commit });
    await writeFile(join(repoRoot, "package.json"), `${packageBytes}\n`);
    await expect(verifyPreparedRelease({ artifactDirectory, repoRoot })).rejects.toThrow("clean source identity");
    await writeFile(join(repoRoot, "package.json"), packageBytes);
    await git(["tag", "-f", "v0.8.0", initialCommit]);
    await expect(verifyPreparedRelease({ artifactDirectory, repoRoot })).rejects.toThrow("peeled tag");
    await git(["tag", "-f", "v0.8.0", source.commit]);
    const zip = join(artifactDirectory, `goodmemory-kimi-plugin-0.8.0.zip`);
    await rename(zip, `${zip}.held`);
    await expect(verifyPreparedRelease({ artifactDirectory, repoRoot })).rejects.toThrow();
    await symlink(`${zip}.held`, zip);
    await expect(verifyPreparedRelease({ artifactDirectory, repoRoot })).rejects.toThrow("symlink");
    await rm(zip);
    await rename(`${zip}.held`, zip);
    const alias = join(root, "artifact-alias");
    await symlink(artifactDirectory, alias);
    await expect(verifyPreparedRelease({ artifactDirectory: alias, repoRoot })).rejects.toThrow("symlink");
  }, 30_000);
});
