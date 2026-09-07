import { describe, expect, it } from "bun:test";

import { createGoodMemory } from "../../src";
import { createExperienceRecord, EXPERIENCES_COLLECTION } from "../../src/domain/evolutionRecords";
import { createFactMemory, createFeedbackMemory } from "../../src/domain/records";
import { createInMemoryDocumentStore, createInMemorySessionStore, createInMemoryVectorStore } from "../../src/storage/memory";

describe("v0.8 public records from older storage", () => {
  it("omits retired exposure fields from recall/export without rewriting stored records", async () => {
    const scope = { userId: "legacy-user" };
    const source = { method: "explicit" as const, extractedAt: "2026-09-01T00:00:00Z" };
    const store = createInMemoryDocumentStore();
    const fact = { ...createFactMemory({ id: "legacy-fact", ...scope, content: "My editor is Neovim.", category: "project", source, attributes: { accessCount: "authored attribute" } }), accessCount: 23, lastAccessedAt: source.extractedAt };
    const feedback = { ...createFeedbackMemory({ id: "legacy-feedback", ...scope, rule: "Prefer small focused changes.", kind: "prefer", source }), lastUsedAt: source.extractedAt };
    const experience = { ...createExperienceRecord({ id: "legacy-experience", ...scope, traceId: "trace-1", kind: "recall", summary: "Recalled editor." }), metrics: { touchedFactCount: 1, reinforcedFeedbackCount: 1, hitCount: 1 } };
    await store.set("facts", fact.id, fact);
    await store.set("feedback", feedback.id, feedback);
    await store.set(EXPERIENCES_COLLECTION, experience.id, experience);
    const memory = createGoodMemory({ storage: { provider: "memory" }, adapters: { documentStore: store, sessionStore: createInMemorySessionStore(), vectorStore: createInMemoryVectorStore(), terminalDeletionSemantics: "shared-coordinated-backends-v1" } });
    const recalled = await memory.recall({ scope, query: "Neovim editor focused changes" });
    expect(recalled.facts.map(record => record.id)).toContain(fact.id);
    for (const record of recalled.facts) {
      expect(record).not.toHaveProperty("accessCount");
      expect(record).not.toHaveProperty("lastAccessedAt");
    }
    for (const record of recalled.feedback) expect(record).not.toHaveProperty("lastUsedAt");
    const exported = await memory.exportMemory({ scope });
    expect(exported.durable.facts[0]).not.toHaveProperty("accessCount");
    expect(exported.durable.facts[0]).not.toHaveProperty("lastAccessedAt");
    expect(exported.durable.facts[0]?.attributes?.accessCount).toBe("authored attribute");
    expect(exported.durable.feedback[0]).not.toHaveProperty("lastUsedAt");
    expect(exported.durable.experiences[0]?.metrics).toEqual({ hitCount: 1 });
    const reimported = await memory.importMemory({ scope, source: { kind: "durable", durable: exported.durable } });
    expect(reimported.counts).toMatchObject({ conflicts: 0, unchanged: 3, imported: 0 });
    expect(await store.get("facts", fact.id)).toEqual(fact);
    expect(await store.get("feedback", feedback.id)).toEqual(feedback);
    expect(await store.get(EXPERIENCES_COLLECTION, experience.id)).toEqual(experience);
  });
});
