import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  checkLevel2Episode,
  loadLevel2Authoring,
  renderLevel2Prompt,
} from "../../scripts/codex-coding-effect/level2-controlled-dataset";

const UPSTREAM_SOURCE = [
  "export function shout(value: string): string {",
  "  return value.toUpperCase();",
  "}",
  "",
  "export function whisper(value: string): string {",
  "  return value.toLowerCase();",
  "}",
  "",
].join("\n");

// Gold: shout appends an exclamation mark (the fork policy); whisper untouched.
const GOLD_SOURCE = [
  "export function shout(value: string): string {",
  '  return value.toUpperCase() + "!";',
  "}",
  "",
  "export function whisper(value: string): string {",
  "  return value.toLowerCase();",
  "}",
  "",
].join("\n");

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function withSyntheticAuthoring<Result>(
  prompt: string,
  run: (roots: { authoringRoot: string; sourcesRoot: string; workRoot: string }) => Promise<Result>,
): Promise<Result> {
  const root = await mkdtemp(join(tmpdir(), "goodmemory-level2-builder-"));
  try {
    const sourcesRoot = join(root, "sources");
    const projected = join(sourcesRoot, "demo-shout", "projected");
    await write(join(projected, "LICENSE"), "MIT License\n");
    await write(
      join(projected, "package.json"),
      `${JSON.stringify({ name: "demo-shout", private: true, type: "module" })}\n`,
    );
    await write(join(projected, "src", "index.ts"), UPSTREAM_SOURCE);

    const authoringRoot = join(root, "authoring");
    const repository = join(authoringRoot, "demo-shout");
    await write(
      join(repository, "repository.json"),
      `${JSON.stringify({
        ecosystem: "bun",
        language: "typescript",
        licensePath: "LICENSE",
        preparation: ["bun", "test", "tests/base-health.test.ts"],
        repositoryId: "demo-shout",
        upstream: {
          canonicalUrl: "https://example.invalid/demo/shout",
          commit: "1".repeat(40),
          licenseSpdx: "MIT",
          ref: "main",
          tree: "2".repeat(40),
        },
        visibleTest: ["bun", "test", "tests/base-health.test.ts"],
      }, null, 2)}\n`,
    );
    await write(join(repository, "overlay", "AGENTS.md"), "# Contributor Instructions\n");
    await write(
      join(repository, "overlay", "tests", "base-health.test.ts"),
      [
        'import { expect, it } from "bun:test";',
        'import { whisper } from "../src/index";',
        'it("keeps whisper working", () => {',
        '  expect(whisper("Quiet")).toBe("quiet");',
        "});",
        "",
      ].join("\n"),
    );
    const episode = join(repository, "episodes", "demo-shout-policy");
    await write(join(episode, "prompts", "stage-1.md"), `${prompt}\n`);
    await write(join(episode, "gold", "stage-1", "src", "index.ts"), GOLD_SOURCE);
    await write(
      join(episode, "episode.json"),
      `${JSON.stringify({
        history: [{ role: "user", text: "Establish the shout policy first." }],
        id: "demo-shout-policy",
        primaryStratum: "project-convention",
        repositoryId: "demo-shout",
        stages: [{
          expectedChangedFiles: ["src/index.ts"],
          failToPass: [
            { args: ["hey"], expected: "HEY!" },
            { args: ["ok"], expected: "OK!" },
          ],
          functionName: "shout",
          gold: "gold/stage-1",
          id: "stage-1",
          memory: { dependencies: [], mode: "none" },
          modulePath: "src/index.ts",
          passToPass: [
            { args: ["Quiet"], expected: "quiet", functionName: "whisper" },
          ],
          prompt: "prompts/stage-1.md",
          taskId: "shout",
        }],
        strata: ["project-convention"],
      }, null, 2)}\n`,
    );
    return await run({ authoringRoot, sourcesRoot, workRoot: join(root, "work") });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

describe("Level-2 controlled dataset authoring", () => {
  it("renders prompts with the ecosystem title and the fixed trailer", () => {
    expect(renderLevel2Prompt("python", "Do the thing.\n")).toBe(
      "# Python utility task\n\nDo the thing.\n\nKeep the implementation dependency-free and run the visible test.\n",
    );
    expect(renderLevel2Prompt("bun", "Do it.")).toStartWith("# TypeScript utility task\n\n");
  });

  it("accepts an episode whose base fails case 1, whose gold passes, and whose prompt states rules", async () => {
    const check = await withSyntheticAuthoring(
      "Establish the shout policy. Project policy: shouted text ends with exactly one exclamation mark. Apply it to shout in src/index.ts.",
      async (roots) => {
        const authoring = await loadLevel2Authoring(roots.authoringRoot);
        expect(authoring.episodes.map((episode) => episode.id)).toEqual([
          "demo-shout-policy",
        ]);
        return checkLevel2Episode({
          authoringRoot: roots.authoringRoot,
          episodeId: "demo-shout-policy",
          sourcesRoot: roots.sourcesRoot,
          workspaceRoot: roots.workRoot,
        });
      },
    );
    expect(check.ok).toBe(true);
    expect(check.stages[0]).toMatchObject({
      baseFailToPass: {
        fingerprint: "C4_F2P|demo-shout-policy|stage-1|case-1",
        status: "failed",
      },
      basePassToPass: "passed",
      baseVisible: "passed",
      goldFailToPass: "passed",
      goldPassToPass: "passed",
      goldVisible: "passed",
      leakedHiddenValues: [],
    });
  });

  it("reports a hidden expected value that leaks into the prompt", async () => {
    const check = await withSyntheticAuthoring(
      "Establish the shout policy. Project policy: shouting hey must return HEY! exactly. Apply it to shout in src/index.ts.",
      async (roots) =>
        checkLevel2Episode({
          authoringRoot: roots.authoringRoot,
          episodeId: "demo-shout-policy",
          sourcesRoot: roots.sourcesRoot,
          workspaceRoot: roots.workRoot,
        }),
    );
    expect(check.ok).toBe(false);
    expect(check.stages[0]?.leakedHiddenValues).toEqual(['"hey"', '"HEY!"']);
    expect(check.problems[0]).toContain("hidden test values appear");
  });
});
