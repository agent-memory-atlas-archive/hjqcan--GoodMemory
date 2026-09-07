import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  checkLevel2Episode,
  loadLevel2Authoring,
} from "./codex-coding-effect/level2-controlled-dataset";

const DEFAULT_AUTHORING_ROOT = resolve("scripts/codex-coding-effect/level2-authoring");
const DEFAULT_SOURCES_ROOT = resolve(
  process.env.HOME ?? "",
  ".goodmemory-eval/codex-coding-effect/artifacts/level2-sources",
);

interface Options {
  all: boolean;
  authoringRoot: string;
  episodes: string[];
  sourcesRoot: string;
  workRoot: string;
}

function parseOptions(args: readonly string[]): Options {
  const options: Options = {
    all: false,
    authoringRoot: DEFAULT_AUTHORING_ROOT,
    episodes: [],
    sourcesRoot: DEFAULT_SOURCES_ROOT,
    workRoot: join(tmpdir(), "goodmemory-level2-check"),
  };
  for (const argument of args) {
    if (argument === "--all") {
      options.all = true;
      continue;
    }
    const separator = argument.indexOf("=");
    if (!argument.startsWith("--") || separator === -1) {
      throw new Error(`unknown Level-2 check argument ${argument}`);
    }
    const name = argument.slice(2, separator);
    const value = argument.slice(separator + 1);
    if (name === "episode") {
      options.episodes.push(value);
    } else if (name === "authoring-root") {
      options.authoringRoot = resolve(value);
    } else if (name === "sources-root") {
      options.sourcesRoot = resolve(value);
    } else if (name === "work-root") {
      options.workRoot = resolve(value);
    } else {
      throw new Error(`unknown Level-2 check option --${name}`);
    }
  }
  if (!options.all && options.episodes.length === 0) {
    throw new Error("pass --episode=<id> (repeatable) or --all");
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const authoring = await loadLevel2Authoring(options.authoringRoot);
  const episodeIds = options.all
    ? authoring.episodes.map((episode) => episode.id)
    : options.episodes;
  let failed = 0;
  for (const episodeId of episodeIds) {
    const workspaceRoot = join(options.workRoot, episodeId);
    const check = await checkLevel2Episode({
      authoringRoot: options.authoringRoot,
      episodeId,
      sourcesRoot: options.sourcesRoot,
      workspaceRoot,
    });
    await rm(workspaceRoot, { force: true, recursive: true });
    console.log(JSON.stringify(check, null, 2));
    if (!check.ok) {
      failed += 1;
    }
  }
  console.log(JSON.stringify({
    checked: episodeIds.length,
    failed,
    ok: failed === 0,
  }));
  if (failed > 0) {
    process.exitCode = 1;
  }
}

await main();
