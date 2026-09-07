import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  loadC4BaselineStageEvidenceFiles,
} from "./codex-coding-effect/c4-baseline-ceiling";
import type {
  C4BaselineCeilingReport,
} from "./codex-coding-effect/c4-baseline-ceiling";
import {
  C4_BASELINE_CEILING_REPORT_PATH,
  finalizeC4DatasetReadiness,
  runC4DatasetCoreReadiness,
} from "./codex-coding-effect/c4-readiness";

interface C4ReadinessOptions {
  baselinePath: string;
  baselineStageEvidenceRoot?: string;
  coreOutput: string;
  datasetRoot: string;
  dispatchPath: string;
  inputBundlePath: string;
  provenancePath: string;
  reportOutput: string;
  requestPath: string;
  reviewPath: string;
}

const DEFAULT_DATASET_ROOT = resolve(
  "fixtures/codex-coding-effect/c4-controlled-pilot",
);
const DEFAULT_REPORT_ROOT = resolve(
  "reports/quality-gates/phase-73",
);

export async function runC4ReadinessGate(
  options: C4ReadinessOptions,
): Promise<{
  coreSha256: string;
  reportOutput: string;
  reportSha256: string;
  status: "accepted";
}> {
  await validateC4ReadinessPaths(options);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "goodmemory-c4-gate-"));
  try {
    const baselineBytes = await readFile(options.baselinePath, "utf8");
    const baselineReport = JSON.parse(
      baselineBytes,
    ) as C4BaselineCeilingReport;
    // The baseline's adaptive rounds are re-derived against the dataset's
    // ceiling plan inside finalizeC4DatasetReadiness once targets are known.
    const baselineStageEvidenceFiles =
      await loadC4BaselineStageEvidenceFiles(
        baselineStageEvidenceRoot(options),
        baselineReport,
      );
    const result = await runC4DatasetCoreReadiness({
      datasetRoot: options.datasetRoot,
      workspaceRoot: join(temporaryRoot, "readiness"),
    });
    const [
      dispatchBytes,
      inputBundleBytes,
      provenanceBytes,
      requestBytes,
      reviewBytes,
    ] = await Promise.all([
      readFile(options.dispatchPath, "utf8"),
      readFile(options.inputBundlePath, "utf8"),
      readFile(options.provenancePath, "utf8"),
      readFile(options.requestPath, "utf8"),
      readFile(options.reviewPath, "utf8"),
    ]);
    const final = finalizeC4DatasetReadiness({
      baselineBytes,
      baselinePath: baselineReportLocator(options.baselinePath),
      baselineStageEvidenceFiles,
      dispatchBytes,
      inputBundleBytes,
      provenanceBytes,
      requestBytes,
      result,
      reviewBytes,
    });
    await Promise.all([
      writeOutput(options.coreOutput, result.coreBytes),
      writeOutput(options.reportOutput, final.reportBytes),
    ]);
    return {
      coreSha256: result.coreSha256,
      reportOutput: options.reportOutput,
      reportSha256: final.reportSha256,
      status: "accepted",
    };
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

// The readiness report records where the baseline lives; a baseline inside
// the repository is recorded by its repository-relative path so the tracked
// evidence stays portable (Level-2 publishes under its own report directory).
function baselineReportLocator(path: string): string {
  const absolute = resolve(path);
  if (absolute === resolve(C4_BASELINE_CEILING_REPORT_PATH)) {
    return C4_BASELINE_CEILING_REPORT_PATH;
  }
  const repositoryRoot = resolve(".");
  return absolute.startsWith(`${repositoryRoot}${sep}`)
    ? absolute.slice(repositoryRoot.length + 1).split(sep).join("/")
    : absolute.split(sep).join("/");
}

export function parseC4ReadinessOptions(
  args: readonly string[],
): C4ReadinessOptions {
  const options: C4ReadinessOptions = {
    baselinePath: resolve(C4_BASELINE_CEILING_REPORT_PATH),
    coreOutput: join(DEFAULT_REPORT_ROOT, "c4-controlled-pilot-core.json"),
    datasetRoot: DEFAULT_DATASET_ROOT,
    dispatchPath: join(DEFAULT_DATASET_ROOT, "review", "dispatch.json"),
    inputBundlePath: join(DEFAULT_DATASET_ROOT, "review", "input-bundle.json"),
    provenancePath: join(DEFAULT_DATASET_ROOT, "review", "provenance.json"),
    reportOutput: join(DEFAULT_REPORT_ROOT, "c4-controlled-pilot-readiness.json"),
    requestPath: join(DEFAULT_DATASET_ROOT, "review", "request.md"),
    reviewPath: join(DEFAULT_DATASET_ROOT, "review", "independent-review.json"),
  };
  for (const argument of args) {
    const separator = argument.indexOf("=");
    if (!argument.startsWith("--") || separator === -1) {
      throw new Error(`invalid C4 readiness argument ${argument}`);
    }
    const name = argument.slice(2, separator);
    const value = resolve(argument.slice(separator + 1));
    if (name === "baseline-report") options.baselinePath = value;
    else if (name === "baseline-stage-evidence") {
      options.baselineStageEvidenceRoot = value;
    }
    else if (name === "core-output") options.coreOutput = value;
    else if (name === "dataset-root") options.datasetRoot = value;
    else if (name === "dispatch") options.dispatchPath = value;
    else if (name === "input-bundle") options.inputBundlePath = value;
    else if (name === "provenance") options.provenancePath = value;
    else if (name === "report-output") options.reportOutput = value;
    else if (name === "request") options.requestPath = value;
    else if (name === "review") options.reviewPath = value;
    else throw new Error(`unknown C4 readiness option --${name}`);
  }
  return options;
}

async function writeOutput(path: string, bytes: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, bytes, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function validateC4ReadinessPaths(
  options: C4ReadinessOptions,
): Promise<void> {
  const [
    baselinePath,
    baselineStageEvidence,
    coreOutput,
    datasetRoot,
    dispatchPath,
    inputBundlePath,
    provenancePath,
    reportOutput,
    requestPath,
    reviewPath,
  ] = await Promise.all([
    resolvePhysicalPath(options.baselinePath),
    resolvePhysicalPath(baselineStageEvidenceRoot(options)),
    resolvePhysicalPath(options.coreOutput),
    resolvePhysicalPath(options.datasetRoot),
    resolvePhysicalPath(options.dispatchPath),
    resolvePhysicalPath(options.inputBundlePath),
    resolvePhysicalPath(options.provenancePath),
    resolvePhysicalPath(options.reportOutput),
    resolvePhysicalPath(options.requestPath),
    resolvePhysicalPath(options.reviewPath),
  ]);
  if (pathsOverlap(coreOutput, reportOutput)) {
    throw new Error("C4 core and report outputs must be physically distinct");
  }
  for (const [label, output] of [
    ["core", coreOutput],
    ["report", reportOutput],
  ] as const) {
    if (pathsOverlap(datasetRoot, output)) {
      throw new Error(`C4 ${label} output must not overlap the dataset root`);
    }
    for (const [inputLabel, inputPath] of [
      ["baseline report", baselinePath],
      ["baseline stage evidence", baselineStageEvidence],
      ["dispatch", dispatchPath],
      ["input bundle", inputBundlePath],
      ["provenance", provenancePath],
      ["request", requestPath],
      ["review", reviewPath],
    ] as const) {
      if (pathsOverlap(inputPath, output)) {
        throw new Error(
          `C4 ${label} output must not overlap the ${inputLabel} input`,
        );
      }
    }
  }
}

function baselineStageEvidenceRoot(options: C4ReadinessOptions): string {
  return resolve(
    options.baselineStageEvidenceRoot ??
      join(dirname(options.baselinePath), "stages"),
  );
}

async function resolvePhysicalPath(path: string): Promise<string> {
  let candidate = resolve(path);
  const missingSegments: string[] = [];
  while (true) {
    try {
      return join(await realpath(candidate), ...missingSegments.reverse());
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
      const parent = dirname(candidate);
      if (parent === candidate) {
        throw error;
      }
      missingSegments.push(basename(candidate));
      candidate = parent;
    }
  }
}

function pathsOverlap(firstPath: string, secondPath: string): boolean {
  return pathInsideOrEqual(firstPath, secondPath) ||
    pathInsideOrEqual(secondPath, firstPath);
}

function pathInsideOrEqual(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child === "" ||
    (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

if (import.meta.main) {
  const result = await runC4ReadinessGate(
    parseC4ReadinessOptions(process.argv.slice(2)),
  );
  console.log(JSON.stringify(result, null, 2));
}
