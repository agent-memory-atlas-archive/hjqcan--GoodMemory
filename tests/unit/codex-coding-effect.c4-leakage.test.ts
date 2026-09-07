import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";

import {
  auditC4SurfaceHiddenArtifactMatrix,
  c4HiddenValueRelationAppearsInSurface,
  c4HiddenValueRelationAppearsInSurfaces,
  C4_HIDDEN_ARTIFACT_IDS,
  C4_LEAKAGE_SURFACE_IDS,
  mutationTestC4SurfaceHiddenArtifactMatrix,
} from "../../scripts/codex-coding-effect/c4-leakage";
import type {
  C4HiddenArtifact,
  C4LeakageSurface,
} from "../../scripts/codex-coding-effect/c4-leakage";

describe("Codex coding-effect C4 leakage matrix", () => {
  it("audits every surface against every hidden-artifact class", () => {
    const audit = auditC4SurfaceHiddenArtifactMatrix({
      artifacts: artifacts(),
      surfaces: surfaces(),
    });

    expect(audit.status).toBe("accepted");
    expect(audit.overlapCount).toBe(0);
    expect(audit.cells).toHaveLength(
      C4_LEAKAGE_SURFACE_IDS.length * C4_HIDDEN_ARTIFACT_IDS.length,
    );
    expect(new Set(audit.cells.map((cell) =>
      `${cell.surfaceId}/${cell.artifactId}`
    )).size).toBe(audit.cells.length);
    expect(audit.candidateBindingVersion).toBe(1);
    expect(audit.candidateExtractionVersion).toBe(
      "semantic-documents-exact-relations-corpus-wide-v9",
    );
    expect(audit.normalizationVersion).toBe(
      "nfkc-lowercase-whitespace-numeric-equivalence-v4",
    );
    expect(audit.cells.every((cell) =>
      cell.candidateFragmentCount > 0 &&
      cell.candidateFragmentSetSha256.length === 64 &&
      cell.hiddenValueSetSha256.length === 64 &&
      cell.hiddenValueSurfaceSha256.length === 64
    )).toBe(true);

    const mutation = mutationTestC4SurfaceHiddenArtifactMatrix({
      artifacts: artifacts(),
      surfaces: surfaces(),
    });
    expect(mutation.status).toBe("accepted");
    expect(mutation.matrixCellCount).toBe(
      C4_LEAKAGE_SURFACE_IDS.length * C4_HIDDEN_ARTIFACT_IDS.length,
    );
    expect(mutation.mutationCellCount).toBe(
      C4_LEAKAGE_SURFACE_IDS.length * C4_HIDDEN_ARTIFACT_IDS.length * 3,
    );
    expect(new Set(mutation.cells.map((cell) => cell.candidateKind))).toEqual(
      new Set(["fragment", "hidden-value", "hidden-value-relation"]),
    );
    expect(mutation.cells.filter((cell) =>
      cell.applicability === "applicable"
    ).every((cell) =>
      cell.targetCellRejected === true &&
      cell.injectedCandidateSha256?.length === 64
    )).toBe(true);
    expect(mutation.cells.some((cell) =>
      cell.candidateKind === "hidden-value" &&
      cell.artifactId === "hidden-test-source" &&
      cell.applicability === "applicable"
    )).toBe(true);
    expect(mutation.cells.some((cell) =>
      cell.candidateKind === "hidden-value-relation" &&
      cell.artifactId === "hidden-test-source" &&
      cell.applicability === "applicable"
    )).toBe(true);
  });

  it("mutation-tests every matrix cell with an intentional hidden fragment", () => {
    const cleanSurfaces = surfaces();
    const hiddenArtifacts = artifacts();

    for (const surfaceId of C4_LEAKAGE_SURFACE_IDS) {
      for (const artifactId of C4_HIDDEN_ARTIFACT_IDS) {
        const artifact = hiddenArtifacts.find((candidate) =>
          candidate.id === artifactId
        )!;
        const leakedFragment = artifact.fragments[0]!;
        const mutated = cleanSurfaces.map((surface) =>
          surface.id === surfaceId
            ? { ...surface, content: `${surface.content}\n${leakedFragment}\n` }
            : surface
        );
        const audit = auditC4SurfaceHiddenArtifactMatrix({
          artifacts: hiddenArtifacts,
          surfaces: mutated,
        });
        const rejected = audit.cells.filter((cell) =>
          cell.status === "rejected"
        );
        expect(rejected.some((cell) =>
          cell.surfaceId === surfaceId && cell.artifactId === artifactId
        )).toBe(true);
        expect(audit.status).toBe("rejected");
      }
    }
  });

  it("records public-only artifact cells as mutation N/A", () => {
    const hiddenArtifacts = artifacts().map((artifact) =>
      artifact.id === "expected-changed-files"
        ? { ...artifact, fragments: [] }
        : artifact
    );
    const mutation = mutationTestC4SurfaceHiddenArtifactMatrix({
      artifacts: hiddenArtifacts,
      surfaces: surfaces(),
    });

    expect(mutation.cells.filter((cell) =>
      cell.artifactId === "expected-changed-files"
    ).every((cell) =>
      cell.applicability === "not-applicable-no-secret-candidate" &&
      cell.injectedCandidateSha256 === null &&
      cell.targetCellRejected === null
    )).toBe(true);
    expect(mutation.cells.filter((cell) =>
      cell.artifactId === "expected-changed-files"
    )).toHaveLength(C4_LEAKAGE_SURFACE_IDS.length * 3);
  });

  it("rejects incomplete matrices instead of silently deferring a surface", () => {
    expect(() => auditC4SurfaceHiddenArtifactMatrix({
      artifacts: artifacts(),
      surfaces: surfaces().slice(1),
    })).toThrow("C4 leakage matrix requires every surface exactly once");
    expect(() => auditC4SurfaceHiddenArtifactMatrix({
      artifacts: artifacts().slice(1),
      surfaces: surfaces(),
    })).toThrow("C4 leakage matrix requires every hidden artifact exactly once");
  });

  it("detects normalized case and whitespace mutations for every artifact class", () => {
    for (const [index, artifactId] of C4_HIDDEN_ARTIFACT_IDS.entries()) {
      const fragment = `Hidden ${artifactId} Boundary`;
      const hiddenArtifacts = artifacts().map((artifact) =>
        artifact.id === artifactId
          ? { ...artifact, fragments: [fragment] }
          : artifact
      );
      const surfaceId = C4_LEAKAGE_SURFACE_IDS[index]!;
      const mutated = surfaces().map((surface) =>
        surface.id === surfaceId
          ? {
              ...surface,
              content: `${surface.content}\n hidden   ${artifactId.toUpperCase()} boundary \n`,
            }
          : surface
      );
      const audit = auditC4SurfaceHiddenArtifactMatrix({
        artifacts: hiddenArtifacts,
        surfaces: mutated,
      });
      const cell = audit.cells.find((candidate) =>
        candidate.surfaceId === surfaceId &&
        candidate.artifactId === artifactId
      )!;
      expect(cell.exactOverlapCount).toBe(0);
      expect(cell.normalizedOverlapCount).toBe(1);
      expect(cell.status).toBe("rejected");
    }
  });

  it("detects typed hidden values without length thresholds", () => {
    const hiddenArtifacts = artifacts().map((artifact) =>
      artifact.id === "hidden-test-source"
        ? {
            ...artifact,
            hiddenValues: [2.5, 2500, false, "ok"],
          }
        : artifact
    );
    const mutated = surfaces().map((surface) =>
      surface.id === "stage-prompts"
        ? {
            ...surface,
            content: `${surface.content}\n2.5 -> 2_500; false; ok\n`,
          }
        : surface
    );

    const audit = auditC4SurfaceHiddenArtifactMatrix({
      artifacts: hiddenArtifacts,
      surfaces: mutated,
    });
    const cell = audit.cells.find((candidate) =>
      candidate.surfaceId === "stage-prompts" &&
      candidate.artifactId === "hidden-test-source"
    )!;

    expect(cell.status).toBe("rejected");
    expect(cell.matchedFragmentSha256).toHaveLength(4);
  });

  it("detects numerically equivalent decimal, grouped, and exponent forms", () => {
    const hiddenArtifacts = artifacts().map((artifact) =>
      artifact.id === "hidden-test-source"
        ? {
            ...artifact,
            hiddenValues: [3000, 62.5],
          }
        : artifact
    );

    for (const representation of ["3,000", "3e3", "62.50"]) {
      const mutated = surfaces().map((surface) =>
        surface.id === "stage-prompts"
          ? {
              ...surface,
              content: `${surface.content}\n${representation}\n`,
            }
          : surface
      );
      expect(auditC4SurfaceHiddenArtifactMatrix({
        artifacts: hiddenArtifacts,
        surfaces: mutated,
      }).status).toBe("rejected");
    }
  });

  it("detects a hidden input-output relation even when each scalar is public", () => {
    const hiddenArtifacts = artifacts().map((artifact) =>
      artifact.id === "hidden-test-source"
        ? {
            ...artifact,
            hiddenValueRelations: [[
              "INFO",
              "invalid-level",
              false,
            ]],
            hiddenValues: [],
          }
        : artifact
    );
    const mutated = surfaces().map((surface) =>
      surface.id === "stage-prompts"
        ? {
            ...surface,
            content: surface.content,
            hiddenValueContent:
              "For INFO, return invalid-level with ok false.",
          }
        : surface
    );

    expect(auditC4SurfaceHiddenArtifactMatrix({
      artifacts: hiddenArtifacts,
      surfaces: mutated,
    }).status).toBe("rejected");
  });

  it("audits relations across ordinary layout changes", () => {
    const hiddenArtifacts = artifacts().map((artifact) =>
      artifact.id === "hidden-test-source"
        ? {
            ...artifact,
            hiddenValueRelations: [["INFO", "invalid-level"]],
            hiddenValues: [],
          }
        : artifact
    );
    for (const content of [
      "input: INFO\n\nexpected: invalid-level",
      [
        "input: INFO",
        "metadata: one",
        "metadata: two",
        "metadata: three",
        "expected: invalid-level",
      ].join("\n"),
      `INFO ${"x".repeat(600)} invalid-level`,
    ]) {
      const mutated = surfaces().map((surface) =>
        surface.id === "stage-prompts"
          ? { ...surface, hiddenValueContent: content }
          : surface
      );
      expect(auditC4SurfaceHiddenArtifactMatrix({
        artifacts: hiddenArtifacts,
        surfaces: mutated,
      }).status).toBe("rejected");
    }
  });

  it("preserves exact trim relations and audits them document-wide", () => {
    const hiddenArtifacts = artifacts().map((artifact) =>
      artifact.id === "hidden-test-source"
        ? {
            ...artifact,
            hiddenValueRelations: [[" info ", "info"]],
            hiddenValues: [],
          }
        : artifact
    );
    const mutated = surfaces().map((surface) =>
      surface.id === "visible-repository-files"
        ? {
            ...surface,
            content: surface.content,
            hiddenValueContent: 'input: " info " => expected: "info"',
          }
        : surface
    );
    const audit = auditC4SurfaceHiddenArtifactMatrix({
      artifacts: hiddenArtifacts,
      surfaces: mutated,
    });

    expect(audit.status).toBe("rejected");
    expect(audit.cells.find((cell) =>
      cell.artifactId === "hidden-test-source" &&
      cell.surfaceId === "visible-repository-files"
    )).toMatchObject({
      hiddenValueRelationCount: 1,
      status: "rejected",
    });
  });

  it("audits a repository relation across sentence boundaries", () => {
    const hiddenArtifacts = artifacts().map((artifact) =>
      artifact.id === "hidden-test-source"
        ? {
            ...artifact,
            hiddenValueRelations: [["INFO", "invalid-level"]],
            hiddenValues: [],
          }
        : artifact
    );
    const mutated = surfaces().map((surface) =>
      surface.id === "visible-repository-files"
        ? {
            ...surface,
            hiddenValueContent: "Call with INFO. It returns invalid-level.",
          }
        : surface
    );

    expect(auditC4SurfaceHiddenArtifactMatrix({
      artifacts: hiddenArtifacts,
      surfaces: mutated,
    }).status).toBe("rejected");
  });

  it("audits repository paths and path-content relations without synthetic wrappers", () => {
    const hiddenArtifacts = artifacts().map((artifact) =>
      artifact.id === "hidden-test-source"
        ? {
            ...artifact,
            hiddenValueRelations: [[2500, "secret-output"]],
            hiddenValues: [2500],
          }
        : artifact
    );
    const mutated = surfaces().map((surface) =>
      surface.id === "visible-repository-files"
        ? {
            ...surface,
            content: JSON.stringify([{ content: "returns secret-output", path: "src/2500.ts" }]),
            fragmentContents: ["src/2500.ts", "returns secret-output"],
            hiddenValueContents: ["src/2500.ts", "returns secret-output"],
          }
        : surface
    );
    const audit = auditC4SurfaceHiddenArtifactMatrix({
      artifacts: hiddenArtifacts,
      surfaces: mutated,
    });

    expect(audit.status).toBe("rejected");
    expect(audit.cells.find((cell) =>
      cell.artifactId === "hidden-test-source" &&
      cell.surfaceId === "visible-repository-files"
    )).toMatchObject({
      hiddenValueRelationCount: 1,
      status: "rejected",
    });
  });

  it("does not treat an invented FILE wrapper as agent-visible repository text", () => {
    const hiddenArtifacts = artifacts().map((artifact) =>
      artifact.id === "expected-changed-files"
        ? {
            ...artifact,
            content: "FILE src/clean.ts",
            fragments: ["FILE src/clean.ts"],
          }
        : artifact
    );
    const clean = surfaces().map((surface) =>
      surface.id === "visible-repository-files"
        ? {
            ...surface,
            content: JSON.stringify([{ content: "clean", path: "src/clean.ts" }]),
            fragmentContents: ["src/clean.ts", "clean"],
            hiddenValueContents: ["src/clean.ts", "clean"],
          }
        : surface
    );

    expect(auditC4SurfaceHiddenArtifactMatrix({
      artifacts: hiddenArtifacts,
      surfaces: clean,
    }).status).toBe("accepted");
  });

  it("does not erase exact trim semantics through normalized endpoint matches", () => {
    expect(c4HiddenValueRelationAppearsInSurface(
      "info",
      [" info ", "info"],
    )).toBe(false);
    expect(c4HiddenValueRelationAppearsInSurface(
      "info then info",
      [" info ", "info"],
    )).toBe(false);
    expect(c4HiddenValueRelationAppearsInSurface(
      "direct and true",
      [" direct ", true],
    )).toBe(false);
  });

  it("detects relations independently of whitespace, line count, and length", () => {
    for (const surface of [
      "input: INFO\n\nexpected: invalid-level",
      [
        "input: INFO",
        "metadata: one",
        "metadata: two",
        "metadata: three",
        "expected: invalid-level",
      ].join("\n"),
      `INFO ${"x".repeat(600)} invalid-level`,
    ]) {
      expect(c4HiddenValueRelationAppearsInSurface(
        surface,
        ["INFO", "invalid-level"],
      )).toBe(true);
    }
  });

  it("detects a relation split across agent-visible file boundaries", () => {
    expect(c4HiddenValueRelationAppearsInSurfaces(
      ["input: INFO", "expected: invalid-level"],
      ["INFO", "invalid-level"],
    )).toBe(true);
    expect(c4HiddenValueRelationAppearsInSurfaces(
      ["input: INFO\nexpected: invalid-level"],
      ["INFO", "invalid-level"],
    )).toBe(true);
  });

  it("audits semantic hidden values without treating projection metadata as leakage", () => {
    const hiddenArtifacts = artifacts().map((artifact) =>
      artifact.id === "hidden-test-source"
        ? { ...artifact, hiddenValues: [1] }
        : artifact
    );
    const clean = surfaces().map((surface) =>
      surface.id === "goodmemory-export-after-seeding"
        ? {
            ...surface,
            content: JSON.stringify({
              durable: { episodes: [{ content: "public memory" }] },
              schemaVersion: 1,
            }),
            hiddenValueContent: "public memory",
          }
        : surface
    );

    expect(auditC4SurfaceHiddenArtifactMatrix({
      artifacts: hiddenArtifacts,
      surfaces: clean,
    }).status).toBe("accepted");

    const leaked = clean.map((surface) =>
      surface.id === "stage-prompts"
        ? {
            ...surface,
            content: `${surface.content}\nhidden expected value = 1\n`,
          }
        : surface
    );
    expect(auditC4SurfaceHiddenArtifactMatrix({
      artifacts: hiddenArtifacts,
      surfaces: leaked,
    }).status).toBe("rejected");
  });
});

function surfaces(): C4LeakageSurface[] {
  return C4_LEAKAGE_SURFACE_IDS.map((id) => ({
    content: `clean evaluator-owned content for ${id}`,
    id,
  }));
}

function artifacts(): C4HiddenArtifact[] {
  return C4_HIDDEN_ARTIFACT_IDS.map((id) => ({
    content: `complete hidden artifact ${id}`,
    fragments: [`C4_MUTATION_${id.toUpperCase().replaceAll("-", "_")}`],
    ...(id === "hidden-test-source"
      ? {
          hiddenValueRelations: [["secret-input", "secret-output"]],
          hiddenValues: [2500],
        }
      : {}),
    id,
  }));
}

describe("C4 leakage mutation candidates", () => {
  // Empty strings are legitimate hidden values (an empty input case) but can
  // never match a surface, so the mutation test must inject the first
  // candidate with matchable text instead of escaping on the empty one.
  it("skips empty hidden values and relations when choosing what to inject", () => {
    const artifactsWithEmpty = artifacts().map((artifact) =>
      artifact.id === "hidden-test-source"
        ? {
            ...artifact,
            hiddenValueRelations: [["", "secret-output"], ["secret-input", "secret-output"]],
            hiddenValues: ["", 2500],
          }
        : artifact
    );
    const mutation = mutationTestC4SurfaceHiddenArtifactMatrix({
      artifacts: artifactsWithEmpty,
      surfaces: surfaces(),
    });
    expect(mutation.status).toBe("accepted");
    const injected = mutation.cells.filter((cell) =>
      cell.artifactId === "hidden-test-source" && cell.applicability === "applicable"
    );
    expect(injected.length).toBeGreaterThan(0);
    expect(injected.every((cell) => cell.targetCellRejected === true)).toBe(true);
    const valueCell = injected.find((cell) => cell.candidateKind === "hidden-value");
    expect(valueCell?.injectedCandidateSha256).toBe(
      sha256(JSON.stringify({ candidate: 2500, candidateKind: "hidden-value" })),
    );
  });
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
