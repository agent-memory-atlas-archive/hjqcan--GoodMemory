import { describe, expect, it } from "bun:test";
import { createGoodMemory, createInMemoryDocumentStore, createInMemorySessionStore } from "../../src";
import type { PreferenceMemory } from "../../src/domain/records";
import { EVIDENCE_COLLECTION, SOURCE_MESSAGES_COLLECTION, type EvidenceRecord, type SourceMessageRecord } from "../../src/evidence/contracts";
import type { ConditionalDocumentWriteBatch, DocumentStore } from "../../src/storage/contracts";
import { createRememberEngine } from "../../src/remember/engine";
import { createMemoryRepositories } from "../../src/storage/repositories";

const scope = { userId: "preference-evidence", workspaceId: "work", sessionId: "conversation" };

function fixture(wrap: (store: ReturnType<typeof createInMemoryDocumentStore>) => DocumentStore = (store) => store) {
  const store = createInMemoryDocumentStore();
  const memory = createGoodMemory({
    storage: { provider: "memory" },
    adapters: { documentStore: wrap(store), sessionStore: createInMemorySessionStore() },
  });
  return {
    store, memory,
    remember: (content: string, id = "statement", observedAt = "2026-09-01T12:00:00.000Z") => memory.remember({
      scope, messages: [{ id, role: "user", content, observedAt }],
    }),
    preferences: () => store.query<PreferenceMemory>("preferences", scope),
    evidence: () => store.query<EvidenceRecord>(EVIDENCE_COLLECTION, scope),
    sources: () => store.query<SourceMessageRecord>(SOURCE_MESSAGES_COLLECTION, scope),
  };
}

describe("preference immutable source evidence", () => {
  it("links accepted preferences to the actual source record and time", async () => {
    const f = fixture();
    await f.remember("I prefer aisle seats for flights.");
    const [preference] = await f.preferences();
    const [source] = await f.sources();
    expect(preference).toBeDefined();
    expect(source).toMatchObject({ role: "user", observedAt: "2026-09-01T12:00:00.000Z", content: "I prefer aisle seats for flights." });
    expect(await f.evidence()).toEqual([expect.objectContaining({
      ...scope, linkedMemoryIds: [preference!.id], sourceRecordIds: [source!.id], sourceMessageIds: ["statement"], excerpt: source!.content,
    })]);
  });

  it("retains later duplicate confirmations while making exact source replay idempotent", async () => {
    const f = fixture();
    await f.remember("I prefer aisle seats for flights.", "original");
    await f.remember("I prefer aisle seats for flights.", "confirmation", "2026-09-02T12:00:00.000Z");
    expect(await f.preferences()).toHaveLength(1);
    expect(await f.evidence()).toHaveLength(2);
    const before = await f.evidence();
    await f.remember("I prefer aisle seats for flights.", "confirmation", "2026-09-02T12:00:00.000Z");
    expect(await f.evidence()).toEqual(before);
    expect(await f.sources()).toHaveLength(2);
    expect((await f.evidence()).flatMap((entry) => entry.sourceRecordIds ?? []).sort()).toEqual((await f.sources()).map((entry) => entry.id).sort());
  });

  it("forgets the preference's exclusive evidence and source while preserving its neighbor", async () => {
    const f = fixture();
    await f.remember("I prefer aisle seats for flights.", "flight");
    await f.remember("I prefer quiet rooms for hotels.", "hotel");
    const target = (await f.preferences()).find((entry) => entry.value === "aisle seats for flights")!;
    expect((await f.memory.forget({ scope, memoryId: target.id })).forgotten).toBe(true);
    expect((await f.preferences()).map((entry) => entry.value)).toEqual(["quiet rooms for hotels"]);
    expect((await f.sources()).map((entry) => entry.sourceMessageId)).toEqual(["hotel"]);
    expect(await f.evidence()).toHaveLength(1);
  });

  it("retains a source shared by two preferences until both are forgotten", async () => {
    const f = fixture();
    await f.remember("I prefer aisle seats for flights. I prefer quiet rooms for hotels.");
    const preferences = await f.preferences();
    expect(preferences).toHaveLength(2);
    await f.memory.forget({ scope, memoryId: preferences[0]!.id });
    expect(await f.sources()).toHaveLength(1);
    expect(await f.evidence()).toHaveLength(1);
    await f.memory.forget({ scope, memoryId: preferences[1]!.id });
    expect(await f.sources()).toHaveLength(0);
    expect(await f.evidence()).toHaveLength(0);
  });

  it("commits new preference and evidence in one conditional batch", async () => {
    const batches: ConditionalDocumentWriteBatch[] = [];
    const f = fixture((store) => ({ ...store, async writeBatchIfUnchanged(batch) {
      batches.push(structuredClone(batch));
      return store.writeBatchIfUnchanged(batch);
    } }));
    await f.remember("I prefer aisle seats for flights.");
    const batch = batches.find((entry) => entry.set.some((operation) => operation.collection === "preferences"));
    expect(batch).toBeDefined();
    expect(batch!.set.some((operation) => operation.collection === EVIDENCE_COLLECTION)).toBe(true);
  });

  it("rolls back preference and evidence if immutable source persistence fails", async () => {
    const f = fixture((store) => ({ ...store, async writeBatchIfUnchanged(batch) {
      if (batch.set.some((operation) => operation.collection === SOURCE_MESSAGES_COLLECTION)) throw new Error("injected source persistence failure");
      return store.writeBatchIfUnchanged(batch);
    } }));
    await expect(f.remember("I prefer aisle seats for flights.")).rejects.toThrow("injected source persistence failure");
    expect(await f.preferences()).toHaveLength(0);
    expect(await f.evidence()).toHaveLength(0);
    expect(await f.sources()).toHaveLength(0);
  });

  it("coalesces concurrent confirmation from independent engines after a stale-read barrier", async () => {
    const f = fixture();
    await f.remember("I prefer aisle seats for flights.", "original");
    let arrived = 0;
    let conflicts = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const store = { ...f.store, async writeBatchIfUnchanged(batch: ConditionalDocumentWriteBatch) {
      const confirmation = batch.set.some((operation) => operation.collection === EVIDENCE_COLLECTION);
      if (confirmation && arrived < 3) {
        arrived += 1;
        if (arrived === 3) release();
        await barrier;
      }
      const committed = await f.store.writeBatchIfUnchanged(batch);
      if (confirmation && !committed) conflicts += 1;
      return committed;
    } };
    const engines = Array.from({ length: 3 }, () => createRememberEngine({
      documentStore: store,
      repositories: createMemoryRepositories({ documentStore: store, sessionStore: createInMemorySessionStore() }),
    }));
    await Promise.all(engines.map((engine) => engine.remember({ scope, messages: [{
      id: "confirmation", role: "user", content: "I prefer aisle seats for flights.", observedAt: "2026-09-02T12:00:00.000Z",
    }] })));
    expect(arrived).toBe(3);
    expect(conflicts).toBe(2);
    expect(await f.preferences()).toHaveLength(1);
    expect(await f.sources()).toHaveLength(2);
    expect(await f.evidence()).toHaveLength(2);
  });

  it("keeps cross-session confirmations and forgets their support from durable scope", async () => {
    const f = fixture();
    await f.remember("I prefer aisle seats for flights.", "original");
    await f.memory.remember({ scope: { ...scope, sessionId: "later" }, messages: [{
      id: "confirmation", role: "user", content: "I prefer aisle seats for flights.", observedAt: "2026-09-02T12:00:00.000Z",
    }] });
    const durableScope = { userId: scope.userId, workspaceId: scope.workspaceId };
    expect(await f.store.query("preferences", durableScope)).toHaveLength(1);
    expect(await f.store.query(EVIDENCE_COLLECTION, durableScope)).toHaveLength(2);
    const [preference] = await f.preferences();
    await f.memory.forget({ scope: durableScope, memoryId: preference!.id });
    expect(await f.store.query(EVIDENCE_COLLECTION, durableScope)).toHaveLength(0);
    expect(await f.store.query(SOURCE_MESSAGES_COLLECTION, durableScope)).toHaveLength(0);
  });

  it("does not invent provenance for a legacy preference or its earlier source", async () => {
    const f = fixture();
    await f.remember("I prefer aisle seats for flights.", "legacy-original");
    for (const evidence of await f.evidence()) await f.store.delete(EVIDENCE_COLLECTION, evidence.id);
    const legacy = await f.preferences();
    await f.memory.recall({ scope, query: "What is my preference for flights?" });
    expect(await f.evidence()).toHaveLength(0);
    expect(await f.preferences()).toEqual(legacy);
    await f.remember("I prefer aisle seats for flights.", "new-confirmation", "2026-09-02T12:00:00.000Z");
    expect(await f.evidence()).toHaveLength(1);
    expect((await f.evidence())[0]!.sourceMessageIds).toEqual(["new-confirmation"]);
  });

  it("binds evidence to the final redacted source without retaining the raw secret", async () => {
    const f = fixture();
    const memory = createGoodMemory({
      adapters: { documentStore: f.store, sessionStore: createInMemorySessionStore() },
      policy: { redact: (candidate) => ({
        ...candidate,
        content: candidate.content.replaceAll("SecretTool", "RedactedTool"),
        metadata: { ...candidate.metadata, ...(typeof candidate.metadata?.preferenceValue === "string"
          ? { preferenceValue: candidate.metadata.preferenceValue.replaceAll("SecretTool", "RedactedTool") } : {}) },
      }) },
    });
    const result = await memory.remember({ scope, messages: [{ id: "private", role: "user", content: "I prefer SecretTool for backend services." }] });
    const [evidence] = await f.evidence();
    const [source] = await f.sources();
    expect(evidence!.sourceRecordIds).toEqual([source!.id]);
    expect(evidence!.excerpt).toBe(source!.content);
    expect(evidence!.excerpt).toContain("RedactedTool");
    expect(JSON.stringify([await f.preferences(), evidence, source])).not.toContain("SecretTool");
    expect(result.events.find((event) => event.memoryType === "preference")!.evidenceIds).toEqual([evidence!.id]);
  });

  it("rolls back a failed duplicate confirmation without losing its original support", async () => {
    let fail = false;
    const f = fixture((store) => ({ ...store, async writeBatchIfUnchanged(batch) {
      if (fail && batch.set.some((operation) => operation.collection === SOURCE_MESSAGES_COLLECTION)) throw new Error("confirmation failure");
      return store.writeBatchIfUnchanged(batch);
    } }));
    await f.remember("I prefer aisle seats for flights.", "original");
    const before = { preferences: await f.preferences(), evidence: await f.evidence(), sources: await f.sources() };
    fail = true;
    await expect(f.remember("I prefer aisle seats for flights.", "later", "2026-09-02T12:00:00.000Z")).rejects.toThrow("confirmation failure");
    expect(await f.preferences()).toEqual(before.preferences);
    expect(await f.evidence()).toEqual(before.evidence);
    expect(await f.sources()).toEqual(before.sources);
  });

  it("deduplicates identical immutable records cited through multiple message indexes", async () => {
    const f = fixture();
    const memory = createGoodMemory({
      adapters: { documentStore: f.store, sessionStore: createInMemorySessionStore() },
      testing: { extractor: { async extract() { return { ignoredMessageCount: 0, candidates: [{
        id: "same-source", kindHint: "preference", explicitness: "explicit", content: "aisle seats for flights",
        sourceRole: "user", sourceMessageIndex: 0, sourceMessageIndexes: [0, 1],
        metadata: { preferenceCategory: "response_style", preferenceValue: "aisle seats for flights" },
      }] }; } } },
    });
    const message = { id: "same-message", role: "user", content: "I prefer aisle seats for flights.", observedAt: "2026-09-01T12:00:00.000Z" };
    await memory.remember({ scope, messages: [message, message] });
    const before = await f.evidence();
    expect(before).toHaveLength(1);
    expect(before[0]!.sourceRecordIds).toHaveLength(1);
    await memory.remember({ scope, messages: [message, message] });
    expect(await f.evidence()).toEqual(before);
  });

  it("does not fabricate evidence when policy cannot preserve a safe source", async () => {
    const f = fixture();
    const memory = createGoodMemory({
      adapters: { documentStore: f.store, sessionStore: createInMemorySessionStore() },
      policy: { redact: (candidate) => candidate.kindHint === "preference" ? {
        ...candidate, content: "redacted option", metadata: { ...candidate.metadata, preferenceValue: "redacted option" },
      } : candidate },
      testing: { extractor: { async extract() { return { ignoredMessageCount: 0, candidates: [{
        id: "paraphrase", kindHint: "preference", explicitness: "explicit", content: "paraphrased private option",
        sourceRole: "user", sourceMessageIndex: 0,
        metadata: { preferenceCategory: "response_style", preferenceValue: "paraphrased private option" },
      }] }; } } },
    });
    for (const sessionId of ["first", "second"]) {
      await memory.remember({ scope: { ...scope, sessionId }, messages: [{ role: "user", content: "I like the option discussed earlier." }] });
    }
    expect(await f.store.query("preferences")).toHaveLength(1);
    expect(await f.store.query(EVIDENCE_COLLECTION)).toHaveLength(0);
    expect(await f.store.query(SOURCE_MESSAGES_COLLECTION)).toHaveLength(0);
  });

  it("distinguishes changed content with a reused external message id", async () => {
    const f = fixture();
    await f.remember("I prefer aisle seats for flights.", "reused");
    await f.remember("For flights, I prefer aisle seats.", "reused");
    expect(await f.preferences()).toHaveLength(1);
    expect(await f.sources()).toHaveLength(2);
    expect(await f.evidence()).toHaveLength(2);
    expect(new Set((await f.evidence()).flatMap((entry) => entry.sourceRecordIds ?? [])).size).toBe(2);
  });

  it("keeps preference and evidence absent after an uncommitted CAS conflict", async () => {
    let conflicts = 0;
    const f = fixture((store) => ({ ...store, async writeBatchIfUnchanged(batch) {
      if (batch.set.some((operation) => operation.collection === EVIDENCE_COLLECTION) && conflicts++ === 0) {
        expect(await store.query("preferences")).toHaveLength(0);
        expect(await store.query(EVIDENCE_COLLECTION)).toHaveLength(0);
        return false;
      }
      return store.writeBatchIfUnchanged(batch);
    } }));
    await f.remember("I prefer aisle seats for flights.");
    expect(conflicts).toBeGreaterThanOrEqual(2);
    const [preference] = await f.preferences();
    expect(await f.evidence()).toEqual([expect.objectContaining({ linkedMemoryIds: [preference!.id] })]);
  });

  it("fails closed on an existing evidence identity mismatch without changing the preference", async () => {
    const f = fixture();
    await f.remember("I prefer aisle seats for flights.");
    const before = await f.preferences();
    const [evidence] = await f.evidence();
    await f.store.set(EVIDENCE_COLLECTION, evidence!.id, { ...evidence!, linkedMemoryIds: ["another-memory"] });
    await expect(f.remember("I prefer aisle seats for flights.")).rejects.toThrow("Preference evidence identity conflict");
    expect(await f.preferences()).toEqual(before);
    expect((await f.evidence())[0]!.linkedMemoryIds).toEqual(["another-memory"]);
  });
});
