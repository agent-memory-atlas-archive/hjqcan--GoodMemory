import { z } from "zod";

import {
  CONTROLLED_DATASET_PROFILES,
  resolveControlledDatasetProfile,
} from "./controlled-dataset-profile";
import type { ControlledDatasetProfile } from "./controlled-dataset-profile";
import type {
  CodexCodingEffectDataset,
  CodexCodingEffectDatasetV2,
} from "./dataset";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const trimmedStringSchema = z.string().min(1).refine(
  (value) => value.trim() === value,
  "value cannot be whitespace-padded",
);

export const C4_REQUIRED_MEMORY_STRATA = [
  "open-loop-handoff",
  "validated-approach",
  "failure-avoidance",
  "user-correction",
  "project-convention",
  "stale-update",
  "irrelevant-memory-negative-control",
  "no-history-negative-control",
] as const;

const sharedReviewCheckShape = {
  codingNotTrivia: z.boolean(),
  hiddenTestsFair: z.boolean(),
  negativeControlCredible: z.boolean(),
  noRepositorySpecificRunnerException: z.boolean(),
};

const requiredMemoryReviewCheckSchema = z.object({
  ...sharedReviewCheckShape,
  memoryUsefulNotAnswer: z.boolean(),
}).strict();

const irrelevantMemoryReviewCheckSchema = z.object({
  ...sharedReviewCheckShape,
  memoryIrrelevantAndNonMisleading: z.boolean(),
}).strict();
const noHistoryReviewCheckSchema = z.object({
  ...sharedReviewCheckShape,
  memoryAbsentAndTaskSelfContained: z.boolean(),
}).strict();

function profileForDatasetId(
  datasetId: string,
): ControlledDatasetProfile | undefined {
  return CONTROLLED_DATASET_PROFILES.find((profile) =>
    profile.datasetId === datasetId
  );
}

function profileForDatasetRootPath(
  datasetRootPath: string,
): ControlledDatasetProfile | undefined {
  return CONTROLLED_DATASET_PROFILES.find((profile) =>
    profile.datasetRootPath === datasetRootPath
  );
}

const reviewInputBundleSchema = z.object({
  assetFiles: z.array(z.object({
    path: trimmedStringSchema,
    sha256: sha256Schema,
  }).strict()).min(1),
  assetLockSha256: sha256Schema,
  assetRootSha256: sha256Schema,
  createdAt: trimmedStringSchema,
  datasetRootPath: trimmedStringSchema,
  datasetId: trimmedStringSchema,
  excludedOutcomeArtifacts: z.tuple([
    z.literal("c4-baseline-results"),
    z.literal("c4-paired-results"),
    z.literal("c5-paired-results"),
  ]),
  leakageAuditSha256: sha256Schema,
  manifestSha256: sha256Schema,
  readinessCorePath: trimmedStringSchema,
  readinessCoreSha256: sha256Schema,
  schemaVersion: z.literal(1),
  scope: z.literal("dataset-only-no-coding-outcomes"),
}).strict().superRefine((bundle, context) => {
  const profile = profileForDatasetId(bundle.datasetId);
  if (profile === undefined) {
    context.addIssue({
      code: "custom",
      message: `C4 review input bundle names unknown dataset ${bundle.datasetId}`,
      path: ["datasetId"],
    });
  } else if (
    bundle.datasetRootPath !== profile.datasetRootPath ||
    bundle.readinessCorePath !== profile.readinessCorePath
  ) {
    context.addIssue({
      code: "custom",
      message: "C4 review input bundle paths do not match the dataset profile",
      path: ["datasetRootPath"],
    });
  }
  const paths = new Set<string>();
  for (const [index, asset] of bundle.assetFiles.entries()) {
    if (paths.has(asset.path)) {
      context.addIssue({
        code: "custom",
        message: `C4 review input bundle repeats asset ${asset.path}`,
        path: ["assetFiles", index, "path"],
      });
    }
    paths.add(asset.path);
  }
});

const episodeReviewSchema = z.discriminatedUnion(
  "memoryExpectationMode",
  [
    z.object({
      author: trimmedStringSchema,
      checks: requiredMemoryReviewCheckSchema,
      episodeId: trimmedStringSchema,
      memoryExpectationMode: z.literal("required"),
      rationale: trimmedStringSchema,
    }).strict(),
    z.object({
      author: trimmedStringSchema,
      checks: irrelevantMemoryReviewCheckSchema,
      episodeId: trimmedStringSchema,
      memoryExpectationMode: z.literal("irrelevant-control"),
      rationale: trimmedStringSchema,
    }).strict(),
    z.object({
      author: trimmedStringSchema,
      checks: noHistoryReviewCheckSchema,
      episodeId: trimmedStringSchema,
      memoryExpectationMode: z.literal("none"),
      rationale: trimmedStringSchema,
    }).strict(),
  ],
);

const independentDatasetReviewSchema = z.object({
  assetLockSha256: sha256Schema,
  assetRootSha256: sha256Schema,
  c4AbResultsInspected: z.boolean(),
  codingOutcomeArtifactsInspected: z.boolean(),
  datasetId: trimmedStringSchema,
  episodeReviews: z.array(episodeReviewSchema).min(1),
  inputBundleSha256: sha256Schema,
  manifestSha256: sha256Schema,
  leakageAuditSha256: sha256Schema,
  publicCodingEffectProof: z.literal(false),
  readinessCoreSha256: sha256Schema,
  reviewedAt: trimmedStringSchema,
  reviewer: trimmedStringSchema,
  reviewerTaskName: trimmedStringSchema,
  schemaVersion: z.literal(2),
  scope: z.literal("dataset-only-no-coding-outcomes"),
  status: z.enum(["accepted", "changes-requested"]),
}).strict().superRefine((review, context) => {
  const profile = profileForDatasetId(review.datasetId);
  if (profile === undefined) {
    context.addIssue({
      code: "custom",
      message: `C4 independent review names unknown dataset ${review.datasetId}`,
      path: ["datasetId"],
    });
  } else {
    if (review.episodeReviews.length !== profile.episodeCount) {
      context.addIssue({
        code: "custom",
        message: `C4 independent review must cover exactly ${profile.episodeCount} episodes`,
        path: ["episodeReviews"],
      });
    }
    if (review.reviewerTaskName !== profile.reviewerAgentName) {
      context.addIssue({
        code: "custom",
        message: "C4 independent review names the wrong reviewer task",
        path: ["reviewerTaskName"],
      });
    }
  }
  if (review.c4AbResultsInspected || review.codingOutcomeArtifactsInspected) {
    context.addIssue({
      code: "custom",
      message: "C4 reviewer must not inspect C4/C5 A/B results",
      path: ["c4AbResultsInspected"],
    });
  }
  const episodeIds = new Set<string>();
  let failedCheckCount = 0;
  for (const [index, episode] of review.episodeReviews.entries()) {
    if (episodeIds.has(episode.episodeId)) {
      context.addIssue({
        code: "custom",
        message: `C4 independent review repeats episode ${episode.episodeId}`,
        path: ["episodeReviews", index, "episodeId"],
      });
    }
    episodeIds.add(episode.episodeId);
    failedCheckCount += countFailedEpisodeReviewChecks(episode);
  }
  if (review.status === "accepted" && failedCheckCount > 0) {
    context.addIssue({
      code: "custom",
      message: "accepted C4 review contains a failed check",
      path: ["status"],
    });
  }
  if (review.status === "changes-requested" && failedCheckCount === 0) {
    context.addIssue({
      code: "custom",
      message: "changes-requested C4 review must contain a failed check",
      path: ["status"],
    });
  }
});

const reviewArtifactReferenceSchema = z.object({
  path: z.string().min(1),
  sha256: sha256Schema,
}).strict();

const independentReviewDispatchSchema = z.object({
  authorTaskName: z.literal("/root"),
  contextPolicy: z.literal("fork-turns-none"),
  datasetRootPath: trimmedStringSchema,
  inputBundlePath: trimmedStringSchema,
  readinessCorePath: trimmedStringSchema,
  requestPath: trimmedStringSchema,
  requestedTaskName: trimmedStringSchema,
  responsePath: trimmedStringSchema,
  reviewerAgentName: trimmedStringSchema,
  schemaVersion: z.literal(1),
  spawnMessage: trimmedStringSchema,
}).strict().superRefine((dispatch, context) => {
  const profile = profileForDatasetRootPath(dispatch.datasetRootPath);
  if (
    profile === undefined ||
    dispatch.inputBundlePath !==
      `${profile.datasetRootPath}/review/input-bundle.json` ||
    dispatch.readinessCorePath !== profile.readinessCorePath ||
    dispatch.requestPath !== `${profile.datasetRootPath}/review/request.md` ||
    dispatch.requestedTaskName !== profile.reviewerTaskName ||
    dispatch.responsePath !==
      `${profile.datasetRootPath}/review/independent-review.json` ||
    dispatch.reviewerAgentName !== profile.reviewerAgentName
  ) {
    context.addIssue({
      code: "custom",
      message: "C4 independent review dispatch does not match a dataset profile",
      path: ["datasetRootPath"],
    });
  }
});

const independentReviewProvenanceSchema = z.object({
  authorTaskName: trimmedStringSchema,
  datasetId: trimmedStringSchema,
  dispatch: reviewArtifactReferenceSchema.extend({
    path: z.literal("review/dispatch.json"),
  }).strict(),
  inputBundle: reviewArtifactReferenceSchema.extend({
    path: z.literal("review/input-bundle.json"),
  }).strict(),
  recordedAt: trimmedStringSchema,
  request: reviewArtifactReferenceSchema.extend({
    path: z.literal("review/request.md"),
  }).strict(),
  response: reviewArtifactReferenceSchema.extend({
    path: z.literal("review/independent-review.json"),
  }).strict(),
  reviewer: z.object({
    agentName: trimmedStringSchema,
    contextPolicy: z.literal("fork-turns-none"),
    orchestratorAttestation: z.object({
      attestedByTaskName: trimmedStringSchema,
      basis: z.literal(
        "dispatch-plus-recorder-cli-no-cryptographic-receipt",
      ),
      canonicalTaskName: trimmedStringSchema,
    }).strict(),
    requestedTaskName: trimmedStringSchema,
    type: z.literal("independent-ai-agent"),
  }).strict(),
  schemaVersion: z.literal(2),
}).strict().superRefine((provenance, context) => {
  const profile = profileForDatasetId(provenance.datasetId);
  if (
    profile === undefined ||
    provenance.reviewer.agentName !== profile.reviewerAgentName ||
    provenance.reviewer.orchestratorAttestation.canonicalTaskName !==
      profile.reviewerAgentName ||
    provenance.reviewer.requestedTaskName !== profile.reviewerTaskName
  ) {
    context.addIssue({
      code: "custom",
      message: "C4 review provenance does not name the dataset profile reviewer",
      path: ["reviewer", "agentName"],
    });
  }
  if (provenance.authorTaskName === provenance.reviewer.agentName) {
    context.addIssue({
      code: "custom",
      message: "C4 reviewer task must differ from the author task",
      path: ["reviewer", "agentName"],
    });
  }
  if (
    provenance.reviewer.orchestratorAttestation.attestedByTaskName !==
      provenance.authorTaskName
  ) {
    context.addIssue({
      code: "custom",
      message: "C4 orchestrator attestation must be made by the author task",
      path: ["reviewer", "orchestratorAttestation", "attestedByTaskName"],
    });
  }
});

export type C4IndependentDatasetReview = z.infer<
  typeof independentDatasetReviewSchema
>;
export type C4IndependentReviewDispatch = z.infer<
  typeof independentReviewDispatchSchema
>;
export type C4IndependentReviewProvenance = z.infer<
  typeof independentReviewProvenanceSchema
>;
export type C4ReviewInputBundle = z.infer<typeof reviewInputBundleSchema>;

function countFailedEpisodeReviewChecks(
  episode: z.infer<typeof episodeReviewSchema>,
): number {
  const sharedChecks = [
    episode.checks.codingNotTrivia,
    episode.checks.hiddenTestsFair,
    episode.checks.negativeControlCredible,
    episode.checks.noRepositorySpecificRunnerException,
  ];
  const memoryCheck = episode.memoryExpectationMode === "required"
    ? episode.checks.memoryUsefulNotAnswer
    : episode.memoryExpectationMode === "irrelevant-control"
      ? episode.checks.memoryIrrelevantAndNonMisleading
      : episode.checks.memoryAbsentAndTaskSelfContained;
  return [...sharedChecks, memoryCheck].filter((passed) => !passed).length;
}

export function validateC4ControlledPilotDataset(
  dataset: CodexCodingEffectDataset,
): CodexCodingEffectDatasetV2 {
  if (dataset.schemaVersion !== 2) {
    throw new Error("C4 requires Codex coding-effect dataset schema version 2");
  }
  const profile = profileForDatasetId(dataset.datasetId);
  if (profile === undefined) {
    throw new Error(
      `C4 dataset id ${dataset.datasetId} is not a registered controlled dataset profile`,
    );
  }
  if (dataset.episodes.length !== profile.episodeCount) {
    throw new Error(
      `C4 requires exactly ${profile.episodeCount} episodes; received ${dataset.episodes.length}`,
    );
  }
  if (
    new Set(dataset.episodes.map((episode) => episode.repository.url)).size <
      profile.repositoryCount
  ) {
    throw new Error(
      `C4 requires at least ${profile.repositoryCount} repositories`,
    );
  }
  for (const episode of dataset.episodes) {
    if (episode.stages.length < profile.stagesPerEpisode) {
      throw new Error(
        `C4 episode ${episode.id} requires at least ${profile.stagesPerEpisode} stages`,
      );
    }
    if (episode.claimEligibility !== "pilot-only") {
      throw new Error(`C4 episode ${episode.id} must be pilot-only`);
    }
    const firstStage = episode.stages[0]!;
    if (firstStage.memoryExpectation.mode !== "none") {
      throw new Error(
        `C4 first stage ${episode.id}/${firstStage.id} must use no history`,
      );
    }
    validateLaterStageModes(profile, episode);
  }
  const strata = new Set(dataset.episodes.flatMap((episode) => episode.strata));
  for (const required of C4_REQUIRED_MEMORY_STRATA) {
    if (!strata.has(required)) {
      throw new Error(`C4 is missing memory stratum ${required}`);
    }
  }
  return dataset;
}

// Later-stage memory expectations. The C4 rule is uniform per episode: every
// later stage requires memory, or is an irrelevant control in an
// irrelevant-memory episode. The Level-2 rule is declared per stage: the
// final stage requires memory, intervening stages are irrelevant controls or
// required (corrections and supersessions), irrelevant-memory episodes stay
// irrelevant-control throughout, and no-history control episodes never
// expect memory.
function validateLaterStageModes(
  profile: ControlledDatasetProfile,
  episode: CodexCodingEffectDatasetV2["episodes"][number],
): void {
  const irrelevantControl = episode.strata.includes(
    "irrelevant-memory-negative-control",
  );
  if (profile.laterStagePolicy === "uniform-by-episode") {
    for (const stage of episode.stages.slice(1)) {
      const expectedMode = irrelevantControl ? "irrelevant-control" : "required";
      if (stage.memoryExpectation.mode !== expectedMode) {
        if (irrelevantControl) {
          throw new Error(
            `C4 irrelevant-memory episode ${episode.id}/${stage.id} must use irrelevant-control`,
          );
        }
        throw new Error(
          `C4 later stage ${episode.id}/${stage.id} must require relevant memory`,
        );
      }
    }
    return;
  }
  const noHistoryControl =
    episode.primaryStratum === "no-history-negative-control";
  const laterStages = episode.stages.slice(1);
  for (const [index, stage] of laterStages.entries()) {
    const mode = stage.memoryExpectation.mode;
    if (irrelevantControl) {
      if (mode !== "irrelevant-control") {
        throw new Error(
          `C4 irrelevant-memory episode ${episode.id}/${stage.id} must use irrelevant-control`,
        );
      }
      continue;
    }
    if (noHistoryControl) {
      if (mode !== "none") {
        throw new Error(
          `C4 no-history episode ${episode.id}/${stage.id} must use no history`,
        );
      }
      continue;
    }
    if (index === laterStages.length - 1) {
      if (mode !== "required") {
        throw new Error(
          `C4 final stage ${episode.id}/${stage.id} must require relevant memory`,
        );
      }
      continue;
    }
    if (mode === "none") {
      throw new Error(
        `C4 intervening stage ${episode.id}/${stage.id} must declare irrelevant-control or required`,
      );
    }
  }
}

export function parseC4IndependentDatasetReview(
  value: unknown,
): C4IndependentDatasetReview {
  const result = independentDatasetReviewSchema.safeParse(value);
  if (result.success) {
    return result.data;
  }
  const issue = result.error.issues[0];
  throw new Error(issue?.message ?? "invalid C4 independent dataset review");
}

export function parseC4IndependentReviewDispatch(
  value: unknown,
): C4IndependentReviewDispatch {
  const result = independentReviewDispatchSchema.safeParse(value);
  if (!result.success) {
    throw new Error("invalid C4 independent review dispatch");
  }
  return result.data;
}

export function parseC4IndependentReviewProvenance(
  value: unknown,
): C4IndependentReviewProvenance {
  const result = independentReviewProvenanceSchema.safeParse(value);
  if (result.success) {
    return result.data;
  }
  const issue = result.error.issues[0];
  throw new Error(issue?.message ?? "invalid C4 independent review provenance");
}

export function parseC4ReviewInputBundle(
  value: unknown,
): C4ReviewInputBundle {
  const result = reviewInputBundleSchema.safeParse(value);
  if (result.success) {
    return result.data;
  }
  const issue = result.error.issues[0];
  throw new Error(issue?.message ?? "invalid C4 review input bundle");
}
