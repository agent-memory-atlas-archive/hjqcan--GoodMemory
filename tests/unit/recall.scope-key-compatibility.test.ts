import { describe, expect, it } from "bun:test";
import { createFactMemory } from "../../src/domain/records";
import { legacyScopeToKey, scopeToKey } from "../../src/domain/scope";
import { createInMemoryDocumentStore } from "../../src/storage/memory";
import {
  PROJECTION_MANIFESTS_COLLECTION,
  RECALL_DOCUMENTS_COLLECTION,
  SCOPE_CATALOG_COLLECTION,
  type RecallProjectionManifest,
} from "../../src/recall/projections/contracts";
import { createRecallProjectionRuntime } from "../../src/recall/projections/runtime";

const now = () => "2026-09-30T00:00:00.000Z";
const scope = { userId: "one::two", tenantId: "three", workspaceId: "workspace" };
const otherScope = { userId: "one", tenantId: "two::three", workspaceId: "workspace" };
const buildId = "unchanged-projection-build";

async function seedLegacyProof(store: ReturnType<typeof createInMemoryDocumentStore>) {
  const scopeKey = legacyScopeToKey(scope);
  const id = `scope:${scopeKey}`;
  const manifest = {
    ...scope,
    id,
    scopeKey,
    schemaVersion: 1,
    projectionBuildId: buildId,
    sourceGeneration: "old-generation",
    validatedGeneration: "old-generation",
    updatedAt: now(),
  };
  await store.set(PROJECTION_MANIFESTS_COLLECTION, id, manifest);
  await store.set(SCOPE_CATALOG_COLLECTION, id, {
    ...scope,
    id,
    scopeKey,
    schemaVersion: 2,
    coverage: "complete",
    analyzerFingerprint: buildId,
  });
  const fact = createFactMemory({
    ...scope,
    id: "canonical-fact",
    category: "project",
    content: "Alice approved the Atlas migration in Paris.",
    subject: "Atlas migration",
    tags: ["Atlas"],
    source: { method: "explicit", extractedAt: now() },
    createdAt: now(),
    updatedAt: now(),
  });
  await store.set("facts", fact.id, fact);
  return { fact, manifest };
}

describe("projection scope-key compatibility", () => {
  it("rebuilds from exact canonical scopes instead of reusing an old-key proof", async () => {
    const store = createInMemoryDocumentStore();
    const { fact, manifest } = await seedLegacyProof(store);
    const runtime = createRecallProjectionRuntime({
      documentStore: store,
      now,
      persistentScopeProof: { buildId },
    });
    expect(await runtime.ensureScopeIndexed(scope)).toMatchObject({
      complete: true,
      indexedSources: 1,
      skipped: false,
    });
    expect(await runtime.queryDocuments(scope)).not.toHaveLength(0);
    expect(await runtime.ensureScopeIndexed(otherScope)).toMatchObject({
      complete: true,
      indexedSources: 0,
      skipped: false,
    });
    expect(await runtime.queryDocuments(otherScope)).toEqual([]);
    expect(await store.get(PROJECTION_MANIFESTS_COLLECTION, manifest.id)).toEqual(manifest);
    expect(await store.get("facts", fact.id)).toEqual(fact);
    const rebuilt = await store.get<RecallProjectionManifest>(
      PROJECTION_MANIFESTS_COLLECTION,
      `scope:${scopeToKey(scope)}`,
    );
    expect(rebuilt?.validatedGeneration).toBe(rebuilt?.sourceGeneration);
    expect(rebuilt?.sourceGeneration).not.toBe(manifest.sourceGeneration);
  });

  it("does not claim new projection completeness when canonical rebuild fails", async () => {
    const inner = createInMemoryDocumentStore();
    const { fact, manifest } = await seedLegacyProof(inner);
    const store = {
      ...inner,
      async writeBatchIfUnchanged(batch: Parameters<typeof inner.writeBatchIfUnchanged>[0]) {
        if (batch.set.some(({ collection }) => collection === RECALL_DOCUMENTS_COLLECTION)) {
          throw new Error("projection rebuild is unavailable");
        }
        return inner.writeBatchIfUnchanged(batch);
      },
    };
    const runtime = createRecallProjectionRuntime({
      documentStore: store,
      now,
      persistentScopeProof: { buildId },
    });
    expect(await runtime.ensureScopeIndexed(scope)).toMatchObject({ complete: false });
    const incomplete = await inner.get<RecallProjectionManifest>(
      PROJECTION_MANIFESTS_COLLECTION,
      `scope:${scopeToKey(scope)}`,
    );
    expect(incomplete?.validatedGeneration).not.toBe(incomplete?.sourceGeneration);
    expect(await inner.get(PROJECTION_MANIFESTS_COLLECTION, manifest.id)).toEqual(manifest);
    expect(await inner.get("facts", fact.id)).toEqual(fact);
  });
});
