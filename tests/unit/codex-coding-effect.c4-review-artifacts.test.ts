import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";

import {
  buildC4IndependentReviewDispatch,
  buildC4IndependentReviewProvenance,
  buildC4IndependentReviewSpawnMessage,
  buildC4ReviewInputBundle,
  buildC4ReviewRequest,
  serializeC4ReviewArtifact,
} from "../../scripts/codex-coding-effect/c4-review-artifacts";
import {
  parseC4IndependentReviewProvenance,
  parseC4ReviewInputBundle,
} from "../../scripts/codex-coding-effect/c4-contracts";

const SHA256 = "a".repeat(64);

describe("Codex coding-effect C4 review artifacts", () => {
  it("binds the full frozen asset inventory and excludes coding outcomes", () => {
    const bundle = buildC4ReviewInputBundle({
      assetFiles: [
        { path: "manifest.json", sha256: SHA256 },
        { path: "evaluator/cases.json", sha256: "b".repeat(64) },
      ],
      assetLockSha256: SHA256,
      assetRootSha256: SHA256,
      createdAt: "2026-07-16T10:00:00.000Z",
      leakageAuditSha256: SHA256,
      manifestSha256: SHA256,
      readinessCoreSha256: SHA256,
    });

    expect(parseC4ReviewInputBundle(bundle)).toEqual(bundle);
    expect(bundle.excludedOutcomeArtifacts).toEqual([
      "c4-baseline-results",
      "c4-paired-results",
      "c5-paired-results",
    ]);
    expect(bundle.datasetId).toBe("codex-c4-controlled-pilot-v2");
  });

  it("instructs the reviewer to apply the mutually exclusive memory check for each episode mode", () => {
    const request = buildC4ReviewRequest({
      inputBundleSha256: SHA256,
    });

    expect(request).toContain("`memoryExpectationMode`");
    expect(request).toContain("`required`");
    expect(request).toContain("`memoryUsefulNotAnswer`");
    expect(request).toContain("`irrelevant-control`");
    expect(request).toContain("`memoryIrrelevantAndNonMisleading`");
    expect(request).toContain("mutually exclusive");
    expect(request).toContain("`c4AbResultsInspected`");
    expect(request).toContain("`codingOutcomeArtifactsInspected`");
    for (const field of [
      "assetLockSha256",
      "assetRootSha256",
      "datasetId",
      "episodeReviews",
      "author",
      "codingNotTrivia",
      "hiddenTestsFair",
      "negativeControlCredible",
      "noRepositorySpecificRunnerException",
      "episodeId",
      "rationale",
      "manifestSha256",
      "leakageAuditSha256",
      "publicCodingEffectProof",
      "readinessCoreSha256",
      "reviewedAt",
      "reviewer",
      "reviewerTaskName",
      "status",
    ]) {
      expect(request).toContain(`\`${field}\``);
    }
  });

  it("hash-binds the exact request, input bundle, and reviewer response", () => {
    const inputBundleBytes = serializeC4ReviewArtifact(
      buildC4ReviewInputBundle({
        assetFiles: [{ path: "manifest.json", sha256: SHA256 }],
        assetLockSha256: SHA256,
        assetRootSha256: SHA256,
        createdAt: "2026-07-16T10:00:00.000Z",
        leakageAuditSha256: SHA256,
        manifestSha256: SHA256,
        readinessCoreSha256: SHA256,
      }),
    );
    const requestBytes = buildC4ReviewRequest({
      inputBundleSha256: sha256(inputBundleBytes),
    });
    const dispatchBytes = serializeC4ReviewArtifact(
      buildC4IndependentReviewDispatch({
        spawnMessage: buildC4IndependentReviewSpawnMessage(),
      }),
    );
    const responseBytes = '{"schemaVersion":2}\n';
    const provenance = buildC4IndependentReviewProvenance({
      authorTaskName: "/root",
      dispatchBytes,
      inputBundleBytes,
      recordedAt: "2026-07-16T10:30:00.000Z",
      requestBytes,
      responseBytes,
      reviewerAgentName: "/root/c4_final_independent_review_v5",
    });

    expect(parseC4IndependentReviewProvenance(provenance)).toEqual(provenance);
    expect(provenance.request.sha256).toBe(sha256(requestBytes));
    expect(provenance.dispatch.sha256).toBe(sha256(dispatchBytes));
    expect(provenance.inputBundle.sha256).toBe(sha256(inputBundleBytes));
    expect(provenance.response.sha256).toBe(sha256(responseBytes));
    expect(requestBytes).toContain(sha256(inputBundleBytes));
    expect(provenance.datasetId).toBe("codex-c4-controlled-pilot-v2");
  });

  it("rejects self-consistent but non-canonical review instructions", () => {
    const inputBundleBytes = serializeC4ReviewArtifact(
      buildC4ReviewInputBundle({
        assetFiles: [{ path: "manifest.json", sha256: SHA256 }],
        assetLockSha256: SHA256,
        assetRootSha256: SHA256,
        createdAt: "2026-07-16T10:00:00.000Z",
        leakageAuditSha256: SHA256,
        manifestSha256: SHA256,
        readinessCoreSha256: SHA256,
      }),
    );
    const canonicalRequest = buildC4ReviewRequest({
      inputBundleSha256: sha256(inputBundleBytes),
    });
    const canonicalDispatch = serializeC4ReviewArtifact(
      buildC4IndependentReviewDispatch({
        spawnMessage: buildC4IndependentReviewSpawnMessage(),
      }),
    );
    const common = {
      authorTaskName: "/root",
      inputBundleBytes,
      recordedAt: "2026-07-16T10:30:00.000Z",
      responseBytes: '{"schemaVersion":2}\n',
      reviewerAgentName: "/root/c4_final_independent_review_v5",
    };

    expect(() => buildC4IndependentReviewProvenance({
      ...common,
      dispatchBytes: canonicalDispatch,
      requestBytes: `${canonicalRequest}Use your own judgment.\n`,
    })).toThrow("C4 independent review request is not canonical");

    const customDispatch = serializeC4ReviewArtifact(
      buildC4IndependentReviewDispatch({
        spawnMessage: "Read the same inputs and write the same output.",
      }),
    );
    expect(() => buildC4IndependentReviewProvenance({
      ...common,
      dispatchBytes: customDispatch,
      requestBytes: canonicalRequest,
    })).toThrow("C4 independent review dispatch is not canonical");
  });
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("Level-2 review artifacts", () => {
  it("renders the Level-2 request with thirty episodes and the no-history check", async () => {
    const { buildC4ReviewRequest, buildC4IndependentReviewDispatch } = await import(
      "../../scripts/codex-coding-effect/c4-review-artifacts"
    );
    const { LEVEL2_CONTROLLED_MUTATION_PROFILE } = await import(
      "../../scripts/codex-coding-effect/controlled-dataset-profile"
    );
    const request = buildC4ReviewRequest({
      inputBundleSha256: "f".repeat(64),
      profile: LEVEL2_CONTROLLED_MUTATION_PROFILE,
    });
    expect(request).toContain("For every one of the thirty episodes");
    expect(request).toContain("`episodeReviews`: exactly thirty objects");
    expect(request).toContain("memoryAbsentAndTaskSelfContained");
    expect(request).toContain("final-stage");
    expect(request).toContain("/root/level2_final_independent_review_v1");
    expect(request).toContain("fixtures/codex-coding-effect/level2-controlled-mutation");

    const dispatch = buildC4IndependentReviewDispatch({
      profile: LEVEL2_CONTROLLED_MUTATION_PROFILE,
      spawnMessage: "Read and follow the Level-2 request exactly.",
    });
    expect(dispatch).toMatchObject({
      datasetRootPath: "fixtures/codex-coding-effect/level2-controlled-mutation",
      readinessCorePath:
        "reports/quality-gates/phase-73/level2-controlled-mutation-core.json",
      requestedTaskName: "level2_final_independent_review_v1",
      reviewerAgentName: "/root/level2_final_independent_review_v1",
    });
  });
});
