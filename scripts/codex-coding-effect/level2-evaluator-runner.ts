// Source of the Level-2 hidden evaluator runner. The dataset builder writes
// this text verbatim to `evaluator/runner.ts`; the C5 harness copies only
// `cases.json` and `runner.ts` into the sandbox and always launches the
// pinned Bun executable, so the Python lane is a child process of the Bun
// runner and uses the system interpreter available inside the sandbox.
//
// Output contract shared with C4: on the first failing case the runner
// prints `C4_F2P|<episode>|<stage>|case-<n>` (or `C4_P2P|...`) to stderr and
// exits 1; a missing target export counts as that case failing so the base
// tree of an "add this function" task still produces the expected
// fingerprint. A case may name its own `functionName` so pass-to-pass cases
// can protect an existing sibling while fail-to-pass cases target the new
// export.
export const LEVEL2_EVALUATOR_RUNNER_SOURCE = `import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

interface EvaluatorCase {
  args: unknown[];
  expected: unknown;
  functionName?: string;
}

interface StageCases {
  ecosystem: "bun" | "python";
  episodeId: string;
  failToPass: EvaluatorCase[];
  functionName: string;
  hiddenSentinel: string;
  modulePath: string;
  packageRoot?: string;
  passToPass: EvaluatorCase[];
  stageId: string;
}

const PYTHON_EXECUTABLE = "/usr/bin/python3";
const PYTHON_HARNESS = [
  "import importlib, json, sys",
  "spec = json.load(sys.stdin)",
  "sys.path.insert(0, spec.get('packageRoot') or '.')",
  "def norm(value):",
  "    if isinstance(value, bool) or value is None or isinstance(value, (int, float, str)):",
  "        return value",
  "    if isinstance(value, dict):",
  "        return {str(k): norm(v) for k, v in value.items()}",
  "    if isinstance(value, (list, tuple, set, frozenset, range)):",
  "        items = [norm(v) for v in value]",
  "        return sorted(items, key=lambda v: json.dumps(v, sort_keys=True)) if isinstance(value, (set, frozenset)) else items",
  "    if hasattr(value, '__iter__') and not isinstance(value, (str, bytes)):",
  "        return [norm(v) for v in value]",
  "    return str(value)",
  "try:",
  "    module = importlib.import_module(spec['modulePath'])",
  "except Exception as error:",
  "    module = None",
  "failures = []",
  "for index, case in enumerate(spec['cases']):",
  "    target = getattr(module, case.get('functionName') or spec['functionName'], None) if module is not None else None",
  "    if not callable(target):",
  "        failures.append(index + 1)",
  "        break",
  "    try:",
  "        actual = norm(target(*case['args']))",
  "    except Exception as error:",
  "        actual = {'__error__': type(error).__name__}",
  "    if json.dumps(actual, sort_keys=True) != json.dumps(case['expected'], sort_keys=True):",
  "        failures.append(index + 1)",
  "        break",
  "print(json.dumps({'failedCase': failures[0] if failures else None}))",
].join("\\n");

function canonical(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  if (value === null || typeof value !== "object") {
    if (typeof value === "bigint") {
      return value.toString();
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      return String(value);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value instanceof Map) {
    return canonical(Object.fromEntries(value));
  }
  if (value instanceof Set) {
    return [...value].map(canonical).sort((left, right) =>
      JSON.stringify(left) < JSON.stringify(right) ? -1 : 1
    );
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof (value as { then?: unknown }).then === "function") {
    return "[promise]";
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, canonical(entry)]),
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

const [kind, episodeId, stageId] = process.argv.slice(2);
if ((kind !== "fail-to-pass" && kind !== "pass-to-pass") || !episodeId || !stageId) {
  throw new Error("usage: runner.ts <fail-to-pass|pass-to-pass> <episode> <stage>");
}
const registry = JSON.parse(await readFile(new URL("./cases.json", import.meta.url), "utf8")) as {
  cases: StageCases[];
  schemaVersion: 1;
};
const selected = registry.cases.find((candidate) =>
  candidate.episodeId === episodeId && candidate.stageId === stageId
);
if (!selected) {
  throw new Error(\`unknown Level-2 evaluator case \${episodeId}/\${stageId}\`);
}
const prefix = kind === "fail-to-pass" ? "C4_F2P" : "C4_P2P";
const tests = kind === "fail-to-pass" ? selected.failToPass : selected.passToPass;

function fail(index: number): never {
  console.error(\`\${prefix}|\${episodeId}|\${stageId}|case-\${index}\`);
  process.exit(1);
}

if (selected.ecosystem === "python") {
  const child = Bun.spawnSync({
    cmd: [PYTHON_EXECUTABLE, "-c", PYTHON_HARNESS],
    cwd: process.cwd(),
    env: {
      HOME: process.env.HOME ?? process.cwd(),
      LANG: "en_US.UTF-8",
      PATH: "/usr/bin:/bin",
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONHASHSEED: "0",
      TMPDIR: process.env.TMPDIR ?? "/tmp",
    },
    stdin: new TextEncoder().encode(JSON.stringify({
      cases: tests,
      functionName: selected.functionName,
      modulePath: selected.modulePath,
      packageRoot: selected.packageRoot ?? ".",
    })),
  });
  const stdout = new TextDecoder().decode(child.stdout).trim();
  const lastLine = stdout.split("\\n").filter((line) => line.length > 0).at(-1) ?? "";
  let parsed: { failedCase: number | null } | null = null;
  try {
    parsed = JSON.parse(lastLine) as { failedCase: number | null };
  } catch {
    parsed = null;
  }
  if (child.exitCode !== 0 || parsed === null) {
    console.error(new TextDecoder().decode(child.stderr));
    fail(1);
  }
  if (parsed.failedCase !== null) {
    fail(parsed.failedCase);
  }
  process.exit(0);
}

let taskModule: Record<string, unknown>;
try {
  taskModule = await import(pathToFileURL(resolve(process.cwd(), selected.modulePath)).href) as Record<string, unknown>;
} catch (error) {
  console.error(String(error));
  fail(1);
}
for (const [index, testCase] of tests.entries()) {
  const candidate = taskModule[testCase.functionName ?? selected.functionName];
  if (typeof candidate !== "function") {
    fail(index + 1);
  }
  let actual: unknown;
  try {
    actual = await Reflect.apply(candidate, undefined, structuredClone(testCase.args));
  } catch (error) {
    actual = { __error__: error instanceof Error ? error.constructor.name : "Error" };
  }
  if (stableJson(actual) !== stableJson(testCase.expected)) {
    fail(index + 1);
  }
}
`;
