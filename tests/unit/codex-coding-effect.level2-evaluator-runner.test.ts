import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LEVEL2_EVALUATOR_RUNNER_SOURCE } from "../../scripts/codex-coding-effect/level2-evaluator-runner";

const SYSTEM_PYTHON = "/usr/bin/python3";
const hasPython = existsSync(SYSTEM_PYTHON);

const PACKAGE_SOURCE = [
  "def pairs(items):",
  "    return [(item, item * 2) for item in items]",
  "",
  "def lazy_fail(items):",
  "    for item in items:",
  "        if item < 0:",
  "            raise TypeError('negative')",
  "        yield item",
  "",
  "def eager_fail(items):",
  "    raise ValueError('nope')",
  "",
].join("\n");

async function runCases(input: {
  cases: { failToPass: unknown[]; functionName: string; passToPass: unknown[] };
  kind: "fail-to-pass" | "pass-to-pass";
}): Promise<{ exitCode: number; stderr: string }> {
  const root = await mkdtemp(join(tmpdir(), "goodmemory-level2-runner-"));
  try {
    const workspace = join(root, "workspace");
    const evaluator = join(root, "evaluator");
    await mkdir(join(workspace, "demo_pkg"), { recursive: true });
    await mkdir(evaluator, { recursive: true });
    await writeFile(join(workspace, "demo_pkg", "__init__.py"), PACKAGE_SOURCE);
    await writeFile(join(evaluator, "runner.ts"), LEVEL2_EVALUATOR_RUNNER_SOURCE);
    await writeFile(
      join(evaluator, "cases.json"),
      JSON.stringify({
        cases: [{
          ecosystem: "python",
          episodeId: "demo",
          failToPass: input.cases.failToPass,
          functionName: input.cases.functionName,
          hiddenSentinel: "C4_HIDDEN|demo|stage-1",
          modulePath: "demo_pkg",
          packageRoot: ".",
          passToPass: input.cases.passToPass,
          stageId: "stage-1",
        }],
        schemaVersion: 1,
      }),
    );
    const child = Bun.spawnSync({
      cmd: [process.execPath, join(evaluator, "runner.ts"), input.kind, "demo", "stage-1"],
      cwd: workspace,
      env: { ...process.env, TMPDIR: root },
    });
    return {
      exitCode: child.exitCode,
      stderr: new TextDecoder().decode(child.stderr),
    };
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

describe.skipIf(!hasPython)("Level-2 evaluator runner Python lane", () => {
  it("normalizes tuples to lists and reports the first failing case", async () => {
    const passing = await runCases({
      cases: {
        failToPass: [{ args: [[1, 2]], expected: [[1, 2], [2, 4]] }],
        functionName: "pairs",
        passToPass: [{ args: [[3]], expected: [[3, 6]] }],
      },
      kind: "fail-to-pass",
    });
    expect(passing.exitCode).toBe(0);

    const failing = await runCases({
      cases: {
        failToPass: [
          { args: [[1]], expected: [[1, 2]] },
          { args: [[1]], expected: [[9, 9]] },
        ],
        functionName: "pairs",
        passToPass: [],
      },
      kind: "fail-to-pass",
    });
    expect(failing.exitCode).toBe(1);
    expect(failing.stderr).toContain("C4_F2P|demo|stage-1|case-2");
  });

  it("surfaces exceptions raised lazily inside generators like eager ones", async () => {
    const result = await runCases({
      cases: {
        failToPass: [
          { args: [[1, -1]], expected: { __error__: "TypeError" } },
          { args: [[2]], expected: { __error__: "ValueError" }, functionName: "eager_fail" },
        ],
        functionName: "lazy_fail",
        passToPass: [],
      },
      kind: "fail-to-pass",
    });
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("treats a missing export as the failing case", async () => {
    const result = await runCases({
      cases: {
        failToPass: [{ args: [[1]], expected: [[1, 2]] }],
        functionName: "pairs",
        passToPass: [{ args: [[1]], expected: 1, functionName: "does_not_exist" }],
      },
      kind: "pass-to-pass",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("C4_P2P|demo|stage-1|case-1");
  });
});
