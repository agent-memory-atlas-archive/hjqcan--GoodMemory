// Controlled-dataset profiles: the dataset-specific literals that the C4
// readiness, review, and C5 paired-run modules used to hard-code (dataset id,
// episode and repository counts, stages per episode, repetitions, reviewer
// identity, fixture paths). The C4 profile reproduces the frozen pilot
// literals exactly so its tracked evidence keeps verifying; the Level-2
// profile describes the controlled-mutation set pre-registered in plan 0.3.

export interface ControlledDatasetRepository {
  ecosystem: "bun" | "python";
  id: string;
  url: string;
}

export interface ControlledDatasetProfile {
  // Author attestation scope literal and whether the attestation must carry
  // the C4 v1 baseline-ceiling redesign block.
  attestationScope: string;
  attestationCarriesPriorV1BaselineCeiling: boolean;
  datasetId: string;
  datasetRootPath: string;
  episodeCount: number;
  // "uniform-by-episode": every later stage is required, or irrelevant-control
  // for an irrelevant-memory episode (the C4 rule). "declared-per-stage": the
  // manifest declares each later stage's mode under the Level-2 rules.
  laterStagePolicy: "declared-per-stage" | "uniform-by-episode";
  readinessCorePath: string;
  repetitions: readonly number[];
  repositories: readonly ControlledDatasetRepository[];
  repositoryCount: number;
  reviewerAgentName: string;
  reviewerTaskName: string;
  stagesPerEpisode: number;
}

export const C4_CONTROLLED_PILOT_PROFILE: ControlledDatasetProfile = {
  attestationCarriesPriorV1BaselineCeiling: true,
  attestationScope:
    "v2-redesign-from-aggregate-v1-ceiling-no-paired-outcomes",
  datasetId: "codex-c4-controlled-pilot-v2",
  datasetRootPath: "fixtures/codex-coding-effect/c4-controlled-pilot",
  episodeCount: 6,
  laterStagePolicy: "uniform-by-episode",
  readinessCorePath:
    "reports/quality-gates/phase-73/c4-controlled-pilot-core.json",
  repetitions: [1, 2],
  repositories: [
    {
      ecosystem: "bun",
      id: "continuity-utils",
      url: "https://example.invalid/goodmemory-c4/continuity-utils.git",
    },
    {
      ecosystem: "bun",
      id: "policy-utils",
      url: "https://example.invalid/goodmemory-c4/policy-utils.git",
    },
  ],
  repositoryCount: 2,
  reviewerAgentName: "/root/c4_final_independent_review_v5",
  reviewerTaskName: "c4_final_independent_review_v5",
  stagesPerEpisode: 3,
};

export const LEVEL2_CONTROLLED_MUTATION_PROFILE: ControlledDatasetProfile = {
  attestationCarriesPriorV1BaselineCeiling: false,
  attestationScope: "level2-summary-window-design-no-paired-outcomes",
  datasetId: "codex-level2-controlled-mutation-v1",
  datasetRootPath: "fixtures/codex-coding-effect/level2-controlled-mutation",
  episodeCount: 30,
  laterStagePolicy: "declared-per-stage",
  readinessCorePath:
    "reports/quality-gates/phase-73/level2-controlled-mutation-core.json",
  repetitions: [1, 2, 3],
  repositories: [
    { ecosystem: "bun", id: "unjs-ufo", url: "https://github.com/unjs/ufo" },
    { ecosystem: "bun", id: "unjs-scule", url: "https://github.com/unjs/scule" },
    {
      ecosystem: "bun",
      id: "radashi-org-radashi",
      url: "https://github.com/radashi-org/radashi",
    },
    {
      ecosystem: "python",
      id: "jpvanhal-inflection",
      url: "https://github.com/jpvanhal/inflection",
    },
    {
      ecosystem: "python",
      id: "python-humanize-humanize",
      url: "https://github.com/python-humanize/humanize",
    },
    {
      ecosystem: "python",
      id: "more-itertools-more-itertools",
      url: "https://github.com/more-itertools/more-itertools",
    },
  ],
  repositoryCount: 6,
  reviewerAgentName: "/root/level2_final_independent_review_v1",
  reviewerTaskName: "level2_final_independent_review_v1",
  stagesPerEpisode: 4,
};

export const CONTROLLED_DATASET_PROFILES: readonly ControlledDatasetProfile[] = [
  C4_CONTROLLED_PILOT_PROFILE,
  LEVEL2_CONTROLLED_MUTATION_PROFILE,
];

export function resolveControlledDatasetProfile(
  datasetId: string,
): ControlledDatasetProfile {
  const profile = CONTROLLED_DATASET_PROFILES.find((candidate) =>
    candidate.datasetId === datasetId
  );
  if (profile === undefined) {
    throw new Error(`unknown controlled dataset id ${datasetId}`);
  }
  return profile;
}

// Fixture directory name for a manifest repository URL. The error text keeps
// the historical C4 wording that callers and tests match on.
export function controlledRepositoryIdForUrl(url: string): string {
  for (const profile of CONTROLLED_DATASET_PROFILES) {
    const repository = profile.repositories.find((candidate) =>
      candidate.url === url
    );
    if (repository !== undefined) {
      return repository.id;
    }
  }
  throw new Error(`unknown C4 repository URL ${url}`);
}

export interface ControlledPlanTopology {
  clusters: number;
  episodeArmRuns: number;
  goodMemoryFirstClusters: number;
  pairs: number;
  pairsPerCluster: number;
  stageRuns: number;
  stageRunsPerCluster: number;
  stages: number;
}

// The paired-run topology every profile implies: one cluster per episode and
// repetition, two arms per cluster, every stage run once per arm.
export function expectedControlledPlanTopology(
  profile: Pick<
    ControlledDatasetProfile,
    "episodeCount" | "repetitions" | "stagesPerEpisode"
  >,
): ControlledPlanTopology {
  const clusters = profile.episodeCount * profile.repetitions.length;
  const stages = profile.episodeCount * profile.stagesPerEpisode;
  return {
    clusters,
    episodeArmRuns: clusters * 2,
    goodMemoryFirstClusters: clusters / 2,
    pairs: clusters * profile.stagesPerEpisode,
    pairsPerCluster: profile.stagesPerEpisode,
    stageRuns: clusters * 2 * profile.stagesPerEpisode,
    stageRunsPerCluster: 2 * profile.stagesPerEpisode,
    stages,
  };
}

// The manifest file that identifies a repository workspace for isolation
// probes: TypeScript repositories carry package.json, Python repositories
// carry pyproject.toml. Every frozen Level-2 projection has exactly this file.
export function controlledRepositoryManifestFile(ecosystem: string): string {
  return ecosystem === "python" ? "pyproject.toml" : "package.json";
}
