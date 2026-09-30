import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadReleaseProfile } from "../../scripts/release/profile";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function packageRoot(version: string, status = "release-candidate") {
  const root = await mkdtemp(join(tmpdir(), "goodmemory-v08-profile-"));
  roots.push(root);
  const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  pkg.version = version;
  pkg.goodmemoryRelease = { installCommandsApplyAfterPublish: true, npmDistTag: status === "stable" ? "latest" : "next", status };
  await writeFile(join(root, "package.json"), JSON.stringify(pkg));
  return root;
}

describe("v0.8 release profile", () => {
  it.each(["0.8.1", "0.8.2"])("uses reproducible current-product gates for %s", async (version) => {
    const profile = await loadReleaseProfile(await packageRoot(version, "stable"));
    expect(profile.id).toBe("goodmemory-v0.8-portable-v1");
    expect(profile.checks.map((check) => check.id)).toEqual([
      "ci", "public-claims", "scale", "postgres", "kimi-plugin",
    ]);
    expect(profile.checks.every((check) => check.required)).toBe(true);
    expect(profile.checks[0]).toMatchObject({ command: "bun", args: ["run", "test:ci"] });
    expect(profile.checks.find((check) => check.id === "postgres")).toMatchObject({
      requiredEnvironment: "GOODMEMORY_TEST_POSTGRES_URL",
      args: ["test", "tests/integration/storage.postgres.test.ts", "tests/integration/api.postgres.test.ts"],
    });
    expect(profile.evidenceInputs).toEqual([]);
    expect(JSON.stringify(profile)).not.toContain("phase73.ts");
    expect(JSON.stringify(profile)).not.toContain("/Volumes/");
    expect(profile.artifact.consumerSmoke).toContain("V08_CONSUMER_OK");
    expect(profile.artifact.requiredFiles).toContain("dist/index.d.ts");
    const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
    expect(pkg.scripts["test:ci"]).toContain("typecheck");
    expect(pkg.scripts["test:ci"]).toContain("test:coverage");
    expect(pkg.scripts["test:ci"]).toContain("run-ci-post-coverage-tests.ts");
    expect(pkg.scripts.prepack).toBe("bun run build");
  });

  it.each(["release-candidate", "stable"])("prepares %s with the required 0.8 product and Phase 73 gates", async (status) => {
    const profile = await loadReleaseProfile(await packageRoot("0.8.0", status));
    expect(profile.id).toBe("goodmemory-v0.8");
    expect(profile.package).toMatchObject({ version: "0.8.0", status, tarballName: "goodmemory-0.8.0.tgz" });
    expect(profile.checks.find(check => check.id === "phase-73")).toMatchObject({ command: "bun", args: ["scripts/release/phase73.ts"], required: true });
    expect(profile.checks.find(check => check.id === "kimi-plugin")).toMatchObject({
      command: "bun",
      args: ["scripts/release/kimiPlugin.ts", "--output", { outputPath: "goodmemory-kimi-plugin-0.8.0.zip" }],
      generatedEvidence: { id: "kimi-plugin-archive", path: "goodmemory-kimi-plugin-0.8.0.zip" },
      required: true,
    });
    expect(profile.artifact.requiredFiles).toContain("docs/GoodMemory-0.7-to-0.8-Migration-Guide.md");
    expect(profile.artifact.requiredFiles).toContain("docs/GoodMemory-Memory-Artifact-and-Interchange-Spec.md");
    expect(profile.artifact.requiredFiles).toContain("reports/quality-gates/phase-75/default-enablement-20260905.md");
    expect(profile.artifact.consumerSmoke).toContain("importMemory");
    expect(profile.artifact.consumerSmoke).toContain("V08_CONSUMER_OK");
    expect(profile.artifact.consumerSmoke).toContain("V08_WORKSPACE_IDENTITY_OK");
    expect(profile.checks.filter(check => check.required).map(check => check.id)).toEqual(expect.arrayContaining(["typecheck", "tests", "coverage", "build", "public-claims", "scale", "postgres", "phase-73"]));
  });

  it("preserves the 0.7 profile and rejects unsupported release lines", async () => {
    expect((await loadReleaseProfile(await packageRoot("0.7.5", "stable"))).id).toBe("goodmemory-v0.7");
    expect((await loadReleaseProfile(await packageRoot("0.7.5", "stable"))).checks.some(check => check.id === "kimi-plugin")).toBe(false);
    await expect(loadReleaseProfile(await packageRoot("0.9.0"))).rejects.toThrow();
  });

  it("ships the 0.8 migration guide and its local Phase 75 evidence link", async () => {
    const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
    const guide = await readFile(new URL("../../docs/GoodMemory-0.7-to-0.8-Migration-Guide.md", import.meta.url), "utf8");
    expect(pkg.files).toContain("docs/GoodMemory-0.7-to-0.8-Migration-Guide.md");
    expect(pkg.files).toContain("reports/quality-gates/phase-75/default-enablement-20260905.md");
    expect(guide).toContain("../reports/quality-gates/phase-75/default-enablement-20260905.md");
    expect(await readFile(new URL("../../reports/quality-gates/phase-75/default-enablement-20260905.md", import.meta.url), "utf8")).toContain("Phase 75");
  });

  it("exposes the manifest-bound plugin ZIP in the CLI and read-only release verification", async () => {
    const cli = await readFile(new URL("../../scripts/release.ts", import.meta.url), "utf8");
    const workflow = await readFile(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");
    expect(cli).toContain('artifact.id === "kimi-plugin-archive"');
    expect(cli).toContain("pluginArchivePath:");
    expect(workflow).toContain('goodmemory-kimi-plugin-$VERSION.zip');
    expect(workflow).toContain("scripts/release/verify.ts --artifact-dir");
    expect(workflow).not.toContain("scripts/release.ts prepare");
  });
});
