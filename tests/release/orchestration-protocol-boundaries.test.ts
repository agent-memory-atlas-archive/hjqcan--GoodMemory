import { describe, expect, it } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const REPOSITORY_ROOT = join(import.meta.dir, "../..");

function collectBunRunTargets(content: string): string[] {
  return [...content.matchAll(/\bbun run ([A-Za-z0-9:._/-]+)/gu)]
    .map((match) => match[1]!);
}

describe("orchestration and proof protocol boundaries", () => {
  it("keeps the plugin scanner workflow read-only and source-pinned", async () => {
    const workflow = await readFile(
      join(REPOSITORY_ROOT, ".github/workflows/plugin-security-scan.yml"),
      "utf8",
    );

    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain(
      "hashgraph-online/ai-plugin-scanner-action@432eebe0fb9212be97c8d15cb1da9668a91e7914",
    );
    expect(workflow).toContain('plugin_dir: "."');
    expect(workflow).toContain("mode: scan");
    expect(workflow).toContain("format: json");
    expect(workflow).toContain("min_score: 80");
    expect(workflow).toContain("fail_on_severity: high");
    expect(workflow).not.toContain("online: true");
    expect(workflow).not.toContain("submission_enabled: true");
    expect(workflow).not.toContain("secrets.");
  });

  it("fetches the history required by source-bound unit tests", async () => {
    const workflow = await readFile(
      join(REPOSITORY_ROOT, ".github/workflows/ci.yml"),
      "utf8",
    );
    const testJob = workflow.slice(
      workflow.indexOf("  test:\n"),
      workflow.indexOf("  node-package-boundary:\n"),
    );

    expect(testJob).toContain("- uses: actions/checkout@v4");
    expect(testJob).toContain("fetch-depth: 0");
  });

  it("keeps active orchestration entrypoints within their growth budgets", async () => {
    const limits = new Map([
      ["scripts/release.ts", 200],
      ["scripts/release/runner.ts", 800],
      ["scripts/research.ts", 800],
      ["scripts/research/c6/source-v4-capture.ts", 800],
      ["scripts/research/c6/legacy-inputs/source-v4.ts", 1_200],
    ]);
    const oversized: Array<{ lines: number; limit: number; path: string }> = [];
    for (const [path, limit] of limits) {
      const source = await readFile(join(REPOSITORY_ROOT, path), "utf8");
      const lines = source.trimEnd().split("\n").length;
      if (lines > limit) {
        oversized.push({ lines, limit, path });
      }
    }
    expect(oversized).toEqual([]);
  });

  it("runs historical research only inside its bound checkout", async () => {
    const [research, capture] = await Promise.all([
      readFile(join(REPOSITORY_ROOT, "scripts/research.ts"), "utf8"),
      readFile(
        join(
          REPOSITORY_ROOT,
          "scripts/research/c6/source-v4-capture.ts",
        ),
        "utf8",
      ),
    ]);
    const checkoutFlow = research.slice(
      research.indexOf("const legacy = await withGitSourceCheckout("),
      research.indexOf("const result = await executeProtocol("),
    );

    expect(checkoutFlow).toContain("runExactHistoricalGates(");
    expect(checkoutFlow).toContain("installBoundDependencies(");
    expect(checkoutFlow).toContain("verifyGitSourceStability(");
    expect(checkoutFlow).toContain("protocol.inputSourceIdentity");
    expect(checkoutFlow.indexOf("loadBoundLegacyProjection(")).toBeLessThan(
      checkoutFlow.indexOf("runExactHistoricalGates("),
    );
    expect(checkoutFlow.indexOf("runExactHistoricalGates(")).toBeLessThan(
      checkoutFlow.lastIndexOf("verifyGitSourceStability("),
    );
    expect(research).toContain("cwd: checkoutRoot");
    expect(research).toContain('"--frozen-lockfile"');
    expect(research).toContain('"--ignore-scripts"');
    expect(research.match(/"--no-install"/gu)).toHaveLength(2);
    expect(research).not.toContain("linkCurrentDependencies");
    expect(research).toContain("snapshotRoot: resolve(resolved)");
    expect(capture).not.toContain("loadLegacySourceV4Projection");
    expect(capture).not.toContain("codex-coding-effect/");
  });

  it("keeps historical research entrypoints out of the package script API", async () => {
    const pkg = JSON.parse(
      await readFile(join(REPOSITORY_ROOT, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};

    expect(scripts["research:list"]).toBe("bun scripts/research.ts list");
    expect(scripts["research:run"]).toBe("bun scripts/research.ts run");
    expect(scripts["research:verify"]).toBe("bun scripts/research.ts verify");
    expect(scripts["release:prepare"]).toBe("bun scripts/release.ts prepare");
    expect(scripts["release:promote"]).toBeUndefined();

    const historicalAliases = Object.keys(scripts).filter((name) =>
      /phase-\d|codex-coding-effect:c[345](?:\b|:)|source-v[123]|wave3|gate:v0(?:-|\.7)/iu
        .test(name)
    );
    expect(historicalAliases).toEqual([]);
  });

  it("verifies exactly the published artifact set without repacking or publishing", async () => {
    const workflow = await readFile(
      join(REPOSITORY_ROOT, ".github/workflows/release.yml"),
      "utf8",
    );

    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("bun install --frozen-lockfile --ignore-scripts");
    expect(workflow).toContain('gh release download "$RELEASE_TAG"');
    expect(workflow.match(/--pattern /gu)).toHaveLength(4);
    for (const asset of [
      "release-manifest.json",
      "goodmemory-$VERSION.tgz",
      "goodmemory-$VERSION-release-evidence.json.gz",
      "goodmemory-kimi-plugin-$VERSION.zip",
    ]) {
      expect(workflow).toContain(`--pattern "${asset}"`);
    }
    expect(workflow).toContain(
      'bun scripts/release/verify.ts --artifact-dir "$ARTIFACT_DIR"',
    );
    expect(workflow).toContain('npm view "goodmemory@$VERSION" version');
    expect(workflow).toContain('npm view "goodmemory@$VERSION" dist.integrity');
    expect(workflow).toContain('npm view "goodmemory@latest" version');
    expect(workflow).not.toContain("bun scripts/release.ts prepare");
    expect(workflow).not.toContain("--strict");
    expect(workflow).not.toContain("reports/release/v0.7/");
    expect(workflow).not.toContain("prepare-v0-7-stable-artifact.ts");
    expect(workflow).not.toContain("verify-v0-7-release-artifact.ts");
    expect(workflow).not.toContain("bun pm pack");
    expect(workflow).not.toContain("npm pack");
    expect(workflow).not.toContain("npm publish");
    expect(workflow).not.toContain("gh release create");
    expect(workflow).not.toContain("secrets.");
    expect(workflow).not.toContain("docker");
  });

  it("verifies only an existing stable v0.8 release and its exact source tag", async () => {
    const workflow = await readFile(
      join(REPOSITORY_ROOT, ".github/workflows/release.yml"),
      "utf8",
    );
    expect(workflow).toContain("release:\n    types: [published]");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toContain("  push:");
    expect(workflow).toContain('[[ "$RELEASE_TAG" =~ ^v0\\.8\\.[0-9]+$ ]]');
    expect(workflow).toContain(
      'gh release view "$RELEASE_TAG" --json isDraft,isPrerelease',
    );
    expect(workflow).toContain("ref: refs/tags/${{ env.RELEASE_TAG }}");
  });

  it("keeps current public docs off removed package aliases", async () => {
    const [
      chineseReadme,
      currentStatus,
      implicitMemBench,
      packageRaw,
      reproducing,
      sequentialHardening,
    ] = await Promise.all([
      readFile(join(REPOSITORY_ROOT, "README.zh-CN.md"), "utf8"),
      readFile(
        join(REPOSITORY_ROOT, "docs/GoodMemory-Current-Status-and-Evidence.md"),
        "utf8",
      ),
      readFile(
        join(
          REPOSITORY_ROOT,
          "docs/GoodMemory-ImplicitMemBench-Full-300-Research-Summary.md",
        ),
        "utf8",
      ),
      readFile(join(REPOSITORY_ROOT, "package.json"), "utf8"),
      readFile(join(REPOSITORY_ROOT, "REPRODUCING.md"), "utf8"),
      readFile(
        join(REPOSITORY_ROOT, "docs/Sequential Benchmark Hardening Plan.md"),
        "utf8",
      ),
    ]);

    expect(chineseReadme).not.toContain("bun run gate:v0.7");
    expect(currentStatus).not.toContain("bun run test:legacy-fitted");
    expect(currentStatus).toContain(
      "scripts/release/capsules/v0.7.4-readiness.json",
    );
    expect(reproducing).not.toMatch(/bun run (?:eval|gate|prepare|test):phase-/u);

    const scripts = (JSON.parse(packageRaw) as {
      scripts?: Record<string, string>;
    }).scripts ?? {};
    const violations = [
      ["GoodMemory-ImplicitMemBench-Full-300-Research-Summary.md", implicitMemBench],
      ["Sequential Benchmark Hardening Plan.md", sequentialHardening],
    ].flatMap(([path, content]) =>
      collectBunRunTargets(content!).filter((target) =>
        !target.startsWith("scripts/") && scripts[target] === undefined
      ).map((target) => `${path}: bun run ${target}`)
    );
    expect(violations).toEqual([]);
  });

  it("keeps the repository proof kernel out of production source", async () => {
    const sourceFiles = await collectTypeScriptFiles(join(REPOSITORY_ROOT, "src"));
    const violations: string[] = [];

    for (const path of sourceFiles) {
      const source = await readFile(path, "utf8");
      if (/from\s+["'][^"']*scripts\/proof(?:\/|["'])/u.test(source)) {
        violations.push(relative(REPOSITORY_ROOT, path));
      }
    }

    expect(violations).toEqual([]);
  });
});

async function collectTypeScriptFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectTypeScriptFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files.sort();
}
