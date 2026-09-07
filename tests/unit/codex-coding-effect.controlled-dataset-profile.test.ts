import { describe, expect, it } from "bun:test";

import {
  C4_CONTROLLED_PILOT_PROFILE,
  CONTROLLED_DATASET_PROFILES,
  controlledRepositoryIdForUrl,
  controlledRepositoryManifestFile,
  expectedControlledPlanTopology,
  LEVEL2_CONTROLLED_MUTATION_PROFILE,
  resolveControlledDatasetProfile,
} from "../../scripts/codex-coding-effect/controlled-dataset-profile";

describe("Codex coding-effect controlled dataset profiles", () => {
  it("reproduces the frozen C4 literals exactly", () => {
    expect(C4_CONTROLLED_PILOT_PROFILE).toMatchObject({
      datasetId: "codex-c4-controlled-pilot-v2",
      datasetRootPath: "fixtures/codex-coding-effect/c4-controlled-pilot",
      episodeCount: 6,
      laterStagePolicy: "uniform-by-episode",
      readinessCorePath:
        "reports/quality-gates/phase-73/c4-controlled-pilot-core.json",
      repetitions: [1, 2],
      repositoryCount: 2,
      reviewerAgentName: "/root/c4_final_independent_review_v5",
      reviewerTaskName: "c4_final_independent_review_v5",
      stagesPerEpisode: 3,
    });
    expect(expectedControlledPlanTopology(C4_CONTROLLED_PILOT_PROFILE)).toEqual({
      clusters: 12,
      episodeArmRuns: 24,
      goodMemoryFirstClusters: 6,
      pairs: 36,
      pairsPerCluster: 3,
      stageRuns: 72,
      stageRunsPerCluster: 6,
      stages: 18,
    });
  });

  it("defines the Level-2 profile with four stages, three repetitions, and six repositories", () => {
    expect(LEVEL2_CONTROLLED_MUTATION_PROFILE).toMatchObject({
      datasetId: "codex-level2-controlled-mutation-v1",
      episodeCount: 30,
      laterStagePolicy: "declared-per-stage",
      repetitions: [1, 2, 3],
      repositoryCount: 6,
      stagesPerEpisode: 4,
    });
    expect(expectedControlledPlanTopology(LEVEL2_CONTROLLED_MUTATION_PROFILE))
      .toEqual({
        clusters: 90,
        episodeArmRuns: 180,
        goodMemoryFirstClusters: 45,
        pairs: 360,
        pairsPerCluster: 4,
        stageRuns: 720,
        stageRunsPerCluster: 8,
        stages: 120,
      });
    expect(LEVEL2_CONTROLLED_MUTATION_PROFILE.repositories).toHaveLength(6);
    expect(
      new Set(LEVEL2_CONTROLLED_MUTATION_PROFILE.repositories.map((r) => r.ecosystem))
        .size,
    ).toBe(2);
  });

  it("resolves profiles by dataset id and rejects unknown ids", () => {
    expect(resolveControlledDatasetProfile("codex-c4-controlled-pilot-v2"))
      .toBe(C4_CONTROLLED_PILOT_PROFILE);
    expect(() => resolveControlledDatasetProfile("codex-unknown")).toThrow(
      "unknown controlled dataset id codex-unknown",
    );
    expect(CONTROLLED_DATASET_PROFILES.map((profile) => profile.datasetId))
      .toEqual([
        "codex-c4-controlled-pilot-v2",
        "codex-level2-controlled-mutation-v1",
      ]);
  });

  it("maps repository URLs to fixture ids across every profile and rejects strangers", () => {
    expect(
      controlledRepositoryIdForUrl(
        "https://example.invalid/goodmemory-c4/continuity-utils.git",
      ),
    ).toBe("continuity-utils");
    expect(controlledRepositoryIdForUrl("https://github.com/unjs/ufo")).toBe(
      "unjs-ufo",
    );
    expect(() => controlledRepositoryIdForUrl("https://example.invalid/x"))
      .toThrow("unknown C4 repository URL https://example.invalid/x");
  });

  it("keeps repository ids and urls unique across profiles", () => {
    const ids = CONTROLLED_DATASET_PROFILES.flatMap((profile) =>
      profile.repositories.map((repository) => repository.id)
    );
    const urls = CONTROLLED_DATASET_PROFILES.flatMap((profile) =>
      profile.repositories.map((repository) => repository.url)
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(urls).size).toBe(urls.length);
    for (const profile of CONTROLLED_DATASET_PROFILES) {
      expect(profile.repositories).toHaveLength(profile.repositoryCount);
      expect(profile.episodeCount * profile.repetitions.length % 2).toBe(0);
    }
  });
});

describe("controlled repository manifest file", () => {
  it("probes package.json for TypeScript repositories and pyproject.toml for Python", () => {
    expect(controlledRepositoryManifestFile("bun")).toBe("package.json");
    expect(controlledRepositoryManifestFile("python")).toBe("pyproject.toml");
  });
});
