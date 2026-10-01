import { expect, it } from "bun:test";
import { createFactMemory } from "../../src/domain/records";
import { createLanguageService } from "../../src/language";
import { buildRecallRerankCandidates } from "../../src/recall/rerankAssembly";
import { buildRecallIndexDocuments } from "../../src/recall/projections/projector";

it("excludes reserved observation support from indexes while retaining literal text and retrieval cues", () => {
  const fact = createFactMemory({ id: "observation-fixture", userId: "owner", category: "project",
    content: "The handbook explains observationSupportV1.",
    source: { method: "inferred", extractedAt: "2026-01-01T00:00:00Z" },
    attributes: { owner: "Robin", retrievalCues: "handbook publication location",
      observationSupportV1: '{"version":1,"fingerprint":"internal-proof-canary"}',
    },
  });
  const documents = buildRecallIndexDocuments({ collection: "facts", document: fact,
    sourceMemoryId: fact.id, indexedAt: "2026-01-01T00:00:00Z", language: createLanguageService() });
  const text = documents.map((document) => document.text).join("\n");
  expect(text).not.toContain("internal-proof-canary");
  expect(documents.filter((document) => document.field === "attributes")
    .every((document) => !document.text.includes("internal-proof-canary"))).toBe(true);
  const selected = { facts: [fact], references: [], episodes: [], archives: [] };
  const candidates = buildRecallRerankCandidates({ candidates: [], claims: [], documents, pool: selected, selected });
  expect(candidates).toHaveLength(1);
  expect(candidates[0]?.retrievalText).not.toContain("internal-proof-canary");
  expect(candidates[0]?.retrievalText).toContain("handbook publication location");
  expect(text).toContain("The handbook explains observationSupportV1.");
  expect(text).toContain("handbook publication location");
  expect(text).toContain("Robin");
});

it("rebuilds a persisted v6 proof index before accepting a v7 scope manifest", async () => {
  const { createInMemoryDocumentStore } = await import("../../src/storage/memory");
  const { createRecallProjectionRuntime } = await import("../../src/recall/projections/runtime");
  const { buildRecallProjectionBuildId } = await import("../../src/recall/projections/manifest");
  const { PROJECTION_MANIFESTS_COLLECTION, RECALL_DOCUMENTS_COLLECTION } = await import("../../src/recall/projections/contracts");
  const { scopeToKey } = await import("../../src/domain/scope");
  const raw = createInMemoryDocumentStore();
  const scope = { userId: "index-upgrade-owner" };
  const language = createLanguageService();
  const fact = createFactMemory({ id: "indexed-observation", ...scope, category: "project",
    content: "The handbook explains observationSupportV1.",
    source: { method: "inferred", extractedAt: "2026-01-01T00:00:00Z" },
    attributes: { retrievalCues: "handbook publication location", observationSupportV1: "internal-proof-canary" },
  });
  await raw.set("facts", fact.id, fact);
  const template = buildRecallIndexDocuments({ collection: "facts", document: fact,
    sourceMemoryId: fact.id, indexedAt: "2026-01-01T00:00:00Z", language })[0]!;
  await raw.set(RECALL_DOCUMENTS_COLLECTION, "legacy-proof-index", { ...template,
    id: "legacy-proof-index", text: "internal-proof-canary", searchText: "internal proof canary",
  });
  const scopeKey = scopeToKey(scope);
  await raw.set(PROJECTION_MANIFESTS_COLLECTION, `scope:${scopeKey}`, {
    id: `scope:${scopeKey}`, schemaVersion: 1, ...scope, scopeKey,
    sourceGeneration: "legacy-generation", validatedGeneration: "legacy-generation",
    projectionBuildId: "gm-projection-v6:legacy", updatedAt: "2026-01-01T00:00:00Z",
  });
  const runtime = createRecallProjectionRuntime({ documentStore: raw, language,
    persistentScopeProof: { buildId: buildRecallProjectionBuildId(language)! } });
  expect((await runtime.ensureScopeIndexed(scope)).complete).toBe(true);
  const documents = await runtime.queryDocuments(scope);
  expect(documents.length).toBeGreaterThan(0);
  expect(documents.every((document) => !document.text.includes("internal-proof-canary"))).toBe(true);
  expect(await raw.get(RECALL_DOCUMENTS_COLLECTION, "legacy-proof-index")).toBeNull();
  const manifest = await raw.get<{ projectionBuildId: string; sourceGeneration: string; validatedGeneration: string }>(
    PROJECTION_MANIFESTS_COLLECTION, `scope:${scopeKey}`);
  expect(manifest?.projectionBuildId).toStartWith("gm-projection-v7:");
  expect(manifest?.validatedGeneration).toBe(manifest?.sourceGeneration);
  expect(await raw.get("facts", fact.id)).toEqual(fact);
});
