import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import {
  cleanupLevel2ControlledDataset,
  LEVEL2_OWNERSHIP_MARKER,
  prepareLevel2ControlledDataset,
} from "./codex-coding-effect/level2-controlled-dataset";
import { LEVEL2_CONTROLLED_MUTATION_PROFILE } from "./codex-coding-effect/controlled-dataset-profile";

const DEFAULT_OUTPUT = resolve(LEVEL2_CONTROLLED_MUTATION_PROFILE.datasetRootPath);
const DEFAULT_AUTHORING_ROOT = resolve("scripts/codex-coding-effect/level2-authoring");
const DEFAULT_SOURCES_ROOT = resolve(
  process.env.HOME ?? "",
  ".goodmemory-eval/codex-coding-effect/artifacts/level2-sources",
);

export async function freezeLevel2ControlledDataset(input: {
  authoringRoot: string;
  frozenAt: string;
  outputRoot: string;
  replace?: boolean;
  sourcesRoot: string;
}): Promise<{
  assetLockSha256: string;
  assetRootSha256: string;
  manifestEpisodeCount: number;
  outputRoot: string;
}> {
  const parent = await mkdtemp(join(tmpdir(), "goodmemory-level2-freeze-"));
  const fixture = await prepareLevel2ControlledDataset({
    authoringRoot: input.authoringRoot,
    frozenAt: input.frozenAt,
    root: join(parent, "dataset"),
    sourcesRoot: input.sourcesRoot,
  });
  try {
    const outputRoot = resolve(input.outputRoot);
    if (input.replace) {
      const existing = JSON.parse(
        await readFile(join(outputRoot, "manifest.json"), "utf8"),
      ) as { datasetId?: unknown };
      if (existing.datasetId !== LEVEL2_CONTROLLED_MUTATION_PROFILE.datasetId) {
        throw new Error("refusing to replace a non-Level-2 dataset directory");
      }
      await rm(outputRoot, { recursive: true });
    }
    await cp(fixture.root, outputRoot, {
      errorOnExist: true,
      filter: (source) => basename(source) !== LEVEL2_OWNERSHIP_MARKER,
      force: false,
      recursive: true,
    });
    return {
      assetLockSha256: fixture.assetLockSha256,
      assetRootSha256: fixture.assetLock.assetRootSha256,
      manifestEpisodeCount: fixture.dataset.episodes.length,
      outputRoot,
    };
  } finally {
    await cleanupLevel2ControlledDataset(fixture);
    await rm(parent, { force: true, recursive: true });
  }
}

function parseOptions(args: readonly string[]): {
  authoringRoot: string;
  frozenAt: string;
  outputRoot: string;
  replace: boolean;
  sourcesRoot: string;
} {
  const options = {
    authoringRoot: DEFAULT_AUTHORING_ROOT,
    frozenAt: new Date().toISOString(),
    outputRoot: DEFAULT_OUTPUT,
    replace: false,
    sourcesRoot: DEFAULT_SOURCES_ROOT,
  };
  for (const argument of args) {
    if (argument === "--replace") {
      options.replace = true;
      continue;
    }
    const separator = argument.indexOf("=");
    if (!argument.startsWith("--") || separator === -1) {
      throw new Error(`unknown Level-2 freeze argument ${argument}`);
    }
    const name = argument.slice(2, separator);
    const value = argument.slice(separator + 1);
    if (name === "output") {
      options.outputRoot = resolve(value);
    } else if (name === "authoring-root") {
      options.authoringRoot = resolve(value);
    } else if (name === "sources-root") {
      options.sourcesRoot = resolve(value);
    } else if (name === "frozen-at") {
      options.frozenAt = value;
    } else {
      throw new Error(`unknown Level-2 freeze option --${name}`);
    }
  }
  return options;
}

if (import.meta.main) {
  const options = parseOptions(process.argv.slice(2));
  const result = await freezeLevel2ControlledDataset(options);
  console.log(JSON.stringify(result, null, 2));
}
