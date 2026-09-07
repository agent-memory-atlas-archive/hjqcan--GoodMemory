import { createHash } from "node:crypto";

import {
  parseC4IndependentReviewDispatch,
  parseC4IndependentReviewProvenance,
  parseC4ReviewInputBundle,
} from "./c4-contracts";
import type {
  C4IndependentReviewDispatch,
  C4IndependentReviewProvenance,
  C4ReviewInputBundle,
} from "./c4-contracts";
import {
  C4_CONTROLLED_PILOT_PROFILE,
  resolveControlledDatasetProfile,
} from "./controlled-dataset-profile";
import type { ControlledDatasetProfile } from "./controlled-dataset-profile";

export const C4_FINAL_REVIEWER_TASK_NAME =
  C4_CONTROLLED_PILOT_PROFILE.reviewerTaskName;
export const C4_FINAL_REVIEWER_AGENT_NAME =
  C4_CONTROLLED_PILOT_PROFILE.reviewerAgentName;
export const C4_DATASET_ROOT_PATH = C4_CONTROLLED_PILOT_PROFILE.datasetRootPath;
export const C4_READINESS_CORE_PATH =
  C4_CONTROLLED_PILOT_PROFILE.readinessCorePath;

const NUMBER_WORDS: Record<number, string> = {
  6: "six",
  30: "thirty",
};

function numberWord(value: number): string {
  return NUMBER_WORDS[value] ?? String(value);
}

export function buildC4ReviewInputBundle(input: {
  assetFiles: ReadonlyArray<{ path: string; sha256: string }>;
  assetLockSha256: string;
  assetRootSha256: string;
  createdAt: string;
  leakageAuditSha256: string;
  manifestSha256: string;
  profile?: ControlledDatasetProfile;
  readinessCoreSha256: string;
}): C4ReviewInputBundle {
  const profile = input.profile ?? C4_CONTROLLED_PILOT_PROFILE;
  return parseC4ReviewInputBundle({
    assetFiles: [...input.assetFiles].sort((first, second) =>
      first.path.localeCompare(second.path)
    ),
    assetLockSha256: input.assetLockSha256,
    assetRootSha256: input.assetRootSha256,
    createdAt: input.createdAt,
    datasetRootPath: profile.datasetRootPath,
    datasetId: profile.datasetId,
    excludedOutcomeArtifacts: [
      "c4-baseline-results",
      "c4-paired-results",
      "c5-paired-results",
    ],
    leakageAuditSha256: input.leakageAuditSha256,
    manifestSha256: input.manifestSha256,
    readinessCorePath: profile.readinessCorePath,
    readinessCoreSha256: input.readinessCoreSha256,
    schemaVersion: 1,
    scope: "dataset-only-no-coding-outcomes",
  });
}

export function buildC4ReviewRequest(input: {
  inputBundleSha256: string;
  profile?: ControlledDatasetProfile;
}): string {
  const profile = input.profile ?? C4_CONTROLLED_PILOT_PROFILE;
  const datasetRootPath = profile.datasetRootPath;
  const readinessCorePath = profile.readinessCorePath;
  const episodeWord = numberWord(profile.episodeCount);
  const declaredPerStage = profile.laterStagePolicy === "declared-per-stage";
  return [
    "# Independent C4 dataset review",
    "",
    "Review only the frozen C4 dataset assets and deterministic readiness core",
    `listed by \`${datasetRootPath}/review/input-bundle.json\`. The`,
    `dataset root is \`${datasetRootPath}\` and the readiness core is`,
    `\`${readinessCorePath}\`. Do not inspect baseline results, C4`,
    "paired A/B results, C5 results, or any other coding outcome artifact.",
    "",
    `Required input-bundle SHA-256: \`${input.inputBundleSha256}\`.`,
    "",
    `For every one of the ${episodeWord} episodes, independently decide whether:`,
    "",
    "- the task is real coding work rather than trivia;",
    "- hidden tests are fair and prompt/repository discoverable;",
    "- negative controls are credible;",
    "- the shared evaluator has no repository-specific exception.",
    "",
    ...(declaredPerStage
      ? [
          "Set `memoryExpectationMode` from the episode's final-stage",
          "`memoryExpectation.mode`, then apply exactly one mode-specific check:",
        ]
      : [
          "Set `memoryExpectationMode` from the episode's later-stage",
          "`memoryExpectation.mode`, then apply exactly one mode-specific check:",
        ]),
    "",
    "- for `required`, include only `memoryUsefulNotAnswer` and decide whether",
    "  memory is useful context but does not contain the answer or patch;",
    "- for `irrelevant-control`, include only",
    "  `memoryIrrelevantAndNonMisleading` and decide whether the unrelated",
    "  memory is genuinely irrelevant and does not mislead the implementation.",
    ...(declaredPerStage
      ? [
          "- for `none` (no-history control episodes), include only",
          "  `memoryAbsentAndTaskSelfContained` and decide whether every stage is",
          "  solvable from its own prompt and repository with no prior session.",
        ]
      : []),
    "",
    ...(declaredPerStage
      ? [
          "These memory checks are mutually exclusive. Do not include the check",
          "for another mode in the episode's `checks` object.",
        ]
      : [
          "These two memory checks are mutually exclusive. Do not include the check",
          "for the other mode in the episode's `checks` object.",
        ]),
    "",
    "Write only `review/independent-review.json` as one strict JSON object.",
    "It must contain exactly these top-level fields:",
    "",
    "- `schemaVersion`: 2;",
    "- `datasetId`, `assetLockSha256`, `assetRootSha256`, `manifestSha256`,",
    "  `leakageAuditSha256`, and `readinessCoreSha256`: copy the exact values",
    "  from the input bundle;",
    `- \`inputBundleSha256\`: \`${input.inputBundleSha256}\`;`,
    "- `scope`: `dataset-only-no-coding-outcomes`;",
    `- \`reviewerTaskName\`: \`${profile.reviewerAgentName}\`;`,
    "- `reviewer`: a non-empty reviewer label;",
    "- `reviewedAt`: the review completion timestamp;",
    "- `c4AbResultsInspected`: false;",
    "- `codingOutcomeArtifactsInspected`: false;",
    "- `publicCodingEffectProof`: false;",
    "- `status`: `accepted` or `changes-requested`; and",
    `- \`episodeReviews\`: exactly ${episodeWord} objects, one for each manifest episode.`,
    "",
    "Each `episodeReviews` object must contain exactly:",
    "",
    "- `episodeId`: copy the manifest episode `id`;",
    "- `author`: copy the manifest episode `author`;",
    ...(declaredPerStage
      ? ["- `memoryExpectationMode`: `required`, `irrelevant-control`, or `none`;"]
      : ["- `memoryExpectationMode`: `required` or `irrelevant-control`;"]),
    "- `rationale`: a non-empty explanation; and",
    "- `checks`, with `codingNotTrivia`, `hiddenTestsFair`,",
    "  `negativeControlCredible`, and",
    "  `noRepositorySpecificRunnerException`, plus exactly one applicable",
    "  memory check described above.",
    "",
    "Use `accepted` only when every shared check and applicable memory check",
    "is true. Otherwise use `changes-requested` and leave each failed check",
    "false. Do not add aliases, per-episode status fields, or other keys.",
    "Do not edit any other file.",
    "",
  ].join("\n");
}

export function buildC4IndependentReviewDispatch(input: {
  profile?: ControlledDatasetProfile;
  spawnMessage: string;
}): C4IndependentReviewDispatch {
  const profile = input.profile ?? C4_CONTROLLED_PILOT_PROFILE;
  return parseC4IndependentReviewDispatch({
    authorTaskName: "/root",
    contextPolicy: "fork-turns-none",
    datasetRootPath: profile.datasetRootPath,
    inputBundlePath: `${profile.datasetRootPath}/review/input-bundle.json`,
    readinessCorePath: profile.readinessCorePath,
    requestPath: `${profile.datasetRootPath}/review/request.md`,
    requestedTaskName: profile.reviewerTaskName,
    responsePath: `${profile.datasetRootPath}/review/independent-review.json`,
    reviewerAgentName: profile.reviewerAgentName,
    schemaVersion: 1,
    spawnMessage: input.spawnMessage,
  });
}

export function buildC4IndependentReviewSpawnMessage(
  profile: ControlledDatasetProfile = C4_CONTROLLED_PILOT_PROFILE,
): string {
  return [
    `Read and follow ${profile.datasetRootPath}/review/request.md exactly.`,
    `Use only ${profile.datasetRootPath}/review/input-bundle.json,`,
    `${profile.readinessCorePath}, and the frozen asset paths listed by the`,
    "input bundle. Do not inspect baseline, C4 paired, or C5 outcome files.",
    `Write only ${profile.datasetRootPath}/review/independent-review.json.`,
  ].join(" ");
}

export function assertC4CanonicalIndependentReviewInstructions(input: {
  dispatchBytes: string;
  inputBundleBytes: string;
  requestBytes: string;
}): void {
  const bundle = parseC4ReviewInputBundle(
    JSON.parse(input.inputBundleBytes) as unknown,
  );
  const profile = resolveControlledDatasetProfile(bundle.datasetId);
  const expectedRequestBytes = buildC4ReviewRequest({
    inputBundleSha256: sha256(input.inputBundleBytes),
    profile,
  });
  if (input.requestBytes !== expectedRequestBytes) {
    throw new Error("C4 independent review request is not canonical");
  }
  const expectedDispatchBytes = serializeC4ReviewArtifact(
    buildC4IndependentReviewDispatch({
      profile,
      spawnMessage: buildC4IndependentReviewSpawnMessage(profile),
    }),
  );
  if (input.dispatchBytes !== expectedDispatchBytes) {
    throw new Error("C4 independent review dispatch is not canonical");
  }
}

export function buildC4IndependentReviewProvenance(input: {
  authorTaskName: string;
  dispatchBytes: string;
  inputBundleBytes: string;
  recordedAt: string;
  requestBytes: string;
  responseBytes: string;
  reviewerAgentName: string;
}): C4IndependentReviewProvenance {
  assertC4CanonicalIndependentReviewInstructions(input);
  const dispatch = parseC4IndependentReviewDispatch(
    JSON.parse(input.dispatchBytes) as unknown,
  );
  if (input.reviewerAgentName !== dispatch.reviewerAgentName) {
    throw new Error("C4 reviewer agent does not match the frozen dispatch");
  }
  const bundle = parseC4ReviewInputBundle(
    JSON.parse(input.inputBundleBytes) as unknown,
  );
  return parseC4IndependentReviewProvenance({
    authorTaskName: input.authorTaskName,
    datasetId: bundle.datasetId,
    dispatch: {
      path: "review/dispatch.json",
      sha256: sha256(input.dispatchBytes),
    },
    inputBundle: {
      path: "review/input-bundle.json",
      sha256: sha256(input.inputBundleBytes),
    },
    recordedAt: input.recordedAt,
    request: {
      path: "review/request.md",
      sha256: sha256(input.requestBytes),
    },
    response: {
      path: "review/independent-review.json",
      sha256: sha256(input.responseBytes),
    },
    reviewer: {
      agentName: input.reviewerAgentName,
      contextPolicy: "fork-turns-none",
      orchestratorAttestation: {
        attestedByTaskName: input.authorTaskName,
        basis: "dispatch-plus-recorder-cli-no-cryptographic-receipt",
        canonicalTaskName: input.reviewerAgentName,
      },
      requestedTaskName: dispatch.requestedTaskName,
      type: "independent-ai-agent",
    },
    schemaVersion: 2,
  });
}

export function serializeC4ReviewArtifact(value: object): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
