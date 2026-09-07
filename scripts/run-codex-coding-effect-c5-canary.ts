import {
  runC5NativeLongitudinalCanary,
} from "./codex-coding-effect/c5-live-pilot";
import type {
  C5NativeLongitudinalCanaryInput,
  C5NativeLongitudinalCanaryResult,
} from "./codex-coding-effect/c5-live-pilot";
import {
  resolveCliFlagValueStrict,
} from "./cli-options";
import {
  parseC5LivePilotOptions,
} from "./run-codex-coding-effect-c5-pilot";
import type {
  C5LivePilotOptionDefaults,
} from "./run-codex-coding-effect-c5-pilot";

export function parseC5LiveCanaryOptions(
  argv: readonly string[],
  defaults: C5LivePilotOptionDefaults = {},
): Omit<C5NativeLongitudinalCanaryInput, "dependencies"> {
  const clusterId = resolveCliFlagValueStrict(argv, "--cluster-id");
  if (clusterId === undefined) {
    throw new Error("--cluster-id is required");
  }
  if (!/^[a-z0-9][a-z0-9-]*\/repetition-[1-9]$/u.test(clusterId)) {
    throw new Error("--cluster-id must name one frozen episode repetition");
  }
  return {
    ...parseC5LivePilotOptions(removeClusterOption(argv), defaults),
    clusterId,
  };
}

export function runC5LiveCanaryCommand(
  argv: readonly string[],
  options?: { defaults?: C5LivePilotOptionDefaults },
): Promise<C5NativeLongitudinalCanaryResult>;
export function runC5LiveCanaryCommand<Result>(
  argv: readonly string[],
  options: {
    defaults?: C5LivePilotOptionDefaults;
    run: (
      input: Omit<C5NativeLongitudinalCanaryInput, "dependencies">,
    ) => Promise<Result>;
  },
): Promise<Result>;
export function runC5LiveCanaryCommand<Result>(
  argv: readonly string[],
  options: {
    defaults?: C5LivePilotOptionDefaults;
    run?: (
      input: Omit<C5NativeLongitudinalCanaryInput, "dependencies">,
    ) => Promise<Result>;
  } = {},
): Promise<Result | C5NativeLongitudinalCanaryResult> {
  const input = parseC5LiveCanaryOptions(argv, options.defaults);
  return options.run === undefined
    ? runC5NativeLongitudinalCanary(input)
    : options.run(input);
}

function removeClusterOption(argv: readonly string[]): string[] {
  const forwarded: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--cluster-id") {
      index += 1;
      continue;
    }
    forwarded.push(argument);
  }
  return forwarded;
}

if (import.meta.main) {
  const result = await runC5LiveCanaryCommand(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
  if (result.report.decision !== "accepted") process.exitCode = 1;
}
