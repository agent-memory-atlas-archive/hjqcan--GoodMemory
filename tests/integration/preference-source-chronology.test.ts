import { buildSourceMessageRecord } from "../../src/remember/builders";
import { describe, expect, it } from "bun:test";
import { createGoodMemory, createInMemoryDocumentStore, createInMemorySessionStore } from "../../src";
import type { MemoryCandidate } from "../../src/remember/candidates";
import type { PreferenceMemory } from "../../src/domain/records";
import type { EvidenceRecord } from "../../src/evidence/contracts";
import { EVIDENCE_COLLECTION, SOURCE_MESSAGES_COLLECTION } from "../../src/evidence/contracts";

const early = "2026-01-01T00:00:00.000Z";
const middle = "2026-06-01T00:00:00.000Z";
const late = "2026-08-01T00:00:00.000Z";
const positive = "I prefer coffee for breakfast.";
const withdrawal = "I no longer prefer coffee for breakfast.";
const restore = "I now prefer coffee for breakfast.";
function fixture() {
  const store = createInMemoryDocumentStore();
  const scope = { userId: crypto.randomUUID(), workspaceId: "synthetic-chronology" };
  let turn = 0;
  let clock = 0;
  const create = (policy?: Parameters<typeof createGoodMemory>[0]["policy"]) => createGoodMemory({
    adapters: { documentStore: store, sessionStore: createInMemorySessionStore() }, policy,
    testing: { now: () => new Date(Date.parse("2026-10-01T00:00:00Z") + clock++ * 1000) },
  });
  return { store, scope, create,
    async remember(content: string, observedAt?: string) {
      const id = `turn-${++turn}`;
      return create().remember({ scope: { ...scope, sessionId: id }, messages: [{ id, role: "user", content, observedAt }] });
    },
    async active() { return (await store.query<PreferenceMemory>("preferences")).filter((record) => record.lifecycle === "active"); },
    async recalled() { return (await create().recall({ scope: { ...scope, sessionId: `fresh-${turn}` }, query: "What is my preference for breakfast?", strategy: "rules-only" })).preferences.map((record) => record.value); },
  };
}

describe("source-bound preference chronology", () => {
  it.each([
    [positive, withdrawal, "coffee for breakfast"],
    [withdrawal, restore, "I no longer prefer coffee for breakfast"],
  ])("does not replace a newer %s with a late older correction", async (seed, correction, expected) => {
    const f = fixture();
    await f.remember(seed!, late);
    const before = await f.active();
    const result = await f.remember(correction!, early);
    expect(await f.active()).toEqual(before);
    expect(result.events).toContainEqual(expect.objectContaining({ outcome: "rejected", reason: "stale_preference_source" }));
    expect(await f.recalled()).toEqual([expected]);
    expect(await f.store.query(SOURCE_MESSAGES_COLLECTION)).toHaveLength(2);
  });

  it("does not let an old withdrawal undo a later explicit restoration", async () => {
    const f = fixture();
    await f.remember(positive, early);
    await f.remember(withdrawal, middle);
    await f.remember(restore, late);
    const before = await f.active();
    await f.remember(withdrawal, "2026-02-01T00:00:00.000Z");
    expect(await f.active()).toEqual(before);
    expect(await f.recalled()).toEqual(["coffee for breakfast"]);
  });

  it("keeps strictly newer withdrawal and restoration working at each stage", async () => {
    const f = fixture();
    await f.remember(positive, early);
    await f.remember(withdrawal, middle);
    expect(await f.recalled()).toEqual(["I no longer prefer coffee for breakfast"]);
    await f.remember(restore, late);
    expect(await f.recalled()).toEqual(["coffee for breakfast"]);
  });

  it.each([[middle, middle], [middle, undefined], [undefined, middle]])("rejects unordered conflicting source times %s / %s", async (seedTime, nextTime) => {
    const f = fixture();
    await f.remember(positive, seedTime);
    const before = await f.active();
    const result = await f.remember(withdrawal, nextTime);
    expect(await f.active()).toEqual(before);
    expect(result.events).toContainEqual(expect.objectContaining({ outcome: "rejected", reason: "unordered_preference_source" }));
    expect(await f.recalled()).toEqual(["coffee for breakfast"]);
  });

  it("preserves legacy ingestion ordering when both actual sources omit time", async () => {
    const f = fixture();
    await f.remember(positive);
    await f.remember(withdrawal);
    expect(await f.recalled()).toEqual(["I no longer prefer coffee for breakfast"]);
  });

  it("uses the latest linked reaffirmation, not the canonical record write clock", async () => {
    const f = fixture();
    await f.remember(positive, early);
    const original = (await f.active())[0]!;
    await f.remember(positive, late);
    expect((await f.active())[0]!.id).toBe(original.id);
    await f.remember(withdrawal, middle);
    expect(await f.active()).toEqual([original]);
    expect(await f.recalled()).toEqual(["coffee for breakfast"]);
  });

  it("allows equal and older same-value evidence without creating a duplicate", async () => {
    const f = fixture();
    await f.remember(positive, middle);
    await f.remember(positive, middle);
    await f.remember(positive, early);
    expect(await f.active()).toHaveLength(1);
    expect(await f.store.query(EVIDENCE_COLLECTION)).toHaveLength(3);
  });

  it("does not reinterpret missing supporting sources as undated input", async () => {
    const f = fixture();
    await f.remember(positive);
    const before = await f.active();
    const evidence = (await f.store.query<EvidenceRecord>(EVIDENCE_COLLECTION))[0]!;
    await f.store.delete(SOURCE_MESSAGES_COLLECTION, evidence.sourceRecordIds![0]!);
    const result = await f.remember(withdrawal);
    expect(await f.active()).toEqual(before);
    expect(result.events).toContainEqual(expect.objectContaining({ outcome: "rejected", reason: "unordered_preference_source" }));
  });

  it("checks context ambiguity before time and leaves unrelated preferences admissible", async () => {
    const f = fixture();
    await f.remember(positive, early);
    await f.remember("I prefer coffee for meetings.", late);
    await f.remember("I no longer prefer coffee.", middle);
    const active = await f.active();
    expect(active.map((record) => record.value)).toContain("coffee for breakfast");
    expect(active.map((record) => record.value)).toContain("coffee for meetings");
    await f.remember("I prefer quiet rooms for hotels.", early);
    expect((await f.active()).map((record) => record.value)).toContain("quiet rooms for hotels");
  });

  it("keeps the exact other context and workspace unchanged", async () => {
    const f = fixture();
    await f.remember(positive, early);
    await f.remember("I prefer coffee for meetings.", late);
    await f.create().remember({ scope: { ...f.scope, workspaceId: "other" }, messages: [{ id: "other", role: "user", content: positive, observedAt: late }] });
    const others = (await f.active()).filter((record) => record.value !== "coffee for breakfast" || record.workspaceId === "other");
    await f.remember(withdrawal, middle);
    const after = await f.active();
    for (const other of others) expect(after.find((record) => record.id === other.id)).toEqual(other);
    expect(after.some((record) => record.value === "coffee for breakfast" && record.workspaceId === f.scope.workspaceId)).toBe(false);
  });
  it("does not borrow a recent re-mention's date for an older restore command", async () => {
    const f = fixture();
    await f.remember(withdrawal, middle);
    const memory = createGoodMemory({ adapters: { documentStore: f.store, sessionStore: createInMemorySessionStore() }, testing: {
      extractor: { async extract() { return { ignoredMessageCount: 0, candidates: [{
        id: "multi-source-restore", kindHint: "preference", explicitness: "explicit", content: "coffee for breakfast",
        sourceRole: "user", sourceMessageIndex: 0, sourceMessageIndexes: [0, 1],
        metadata: { preferenceCategory: "response_style", preferenceValue: "coffee for breakfast", attributes: { observedAt: late } },
      }] }; } },
    } });
    const result = await memory.remember({ scope: f.scope, messages: [
      { id: "old-restore", role: "user", content: restore, observedAt: early },
      { id: "ordinary-remention", role: "user", content: positive, observedAt: late },
    ] });
    expect(result.events).toContainEqual(expect.objectContaining({ outcome: "rejected", reason: "stale_preference_source" }));
    expect(await f.recalled()).toEqual(["I no longer prefer coffee for breakfast"]);
  });

  it("does not borrow an unrelated auxiliary message's earlier date", async () => {
    const f = fixture();
    await f.remember(positive, middle);
    const memory = createGoodMemory({ adapters: { documentStore: f.store, sessionStore: createInMemorySessionStore() }, testing: {
      extractor: { async extract() { return { ignoredMessageCount: 0, candidates: [{
        id: "multi-source-withdrawal", kindHint: "preference", explicitness: "explicit", content: "I no longer prefer coffee for breakfast",
        sourceRole: "user", sourceMessageIndex: 0, sourceMessageIndexes: [0, 1],
        metadata: { preferenceCategory: "response_style", preferenceValue: "I no longer prefer coffee for breakfast" },
      }] }; } },
    } });
    await memory.remember({ scope: f.scope, messages: [
      { id: "current-withdrawal", role: "user", content: withdrawal, observedAt: late },
      { id: "earlier-other-topic", role: "user", content: "The library opens on Sundays.", observedAt: early },
    ] });
    expect(await f.recalled()).toEqual(["I no longer prefer coffee for breakfast"]);
  });

  it("orders sources inside one remember transaction before source persistence", async () => {
    const f = fixture();
    await f.create().remember({ scope: f.scope, messages: [
      { id: "new-positive", role: "user", content: positive, observedAt: late },
      { id: "old-withdrawal", role: "user", content: withdrawal, observedAt: early },
    ] });
    expect(await f.recalled()).toEqual(["coffee for breakfast"]);
    expect(await f.store.query(SOURCE_MESSAGES_COLLECTION)).toHaveLength(2);
  });

  it("binds chronology to the final consistently redacted source", async () => {
    const f = fixture();
    const redact = (candidate: MemoryCandidate) => ({ ...candidate, content: candidate.content.replaceAll("OriginalDrink", "coffee"),
      metadata: candidate.metadata ? { ...candidate.metadata,
        ...(typeof candidate.metadata.preferenceValue === "string" ? { preferenceValue: candidate.metadata.preferenceValue.replaceAll("OriginalDrink", "coffee") } : {}),
      } : undefined,
    });
    const remember = (content: string, observedAt: string, id: string) => f.create({ redact }).remember({ scope: f.scope, messages: [{ id, role: "user", content, observedAt }] });
    await remember("I prefer OriginalDrink for breakfast.", late, "latest");
    await remember("I no longer prefer OriginalDrink for breakfast.", early, "old");
    expect(await f.recalled()).toEqual(["coffee for breakfast"]);
    expect(JSON.stringify(await f.store.query(SOURCE_MESSAGES_COLLECTION))).not.toContain("OriginalDrink");
  });

  it("does not act on a newer quoted third-party withdrawal", async () => {
    const f = fixture();
    await f.remember(positive, early);
    const before = await f.active();
    await f.remember('My friend said: "I no longer prefer coffee for breakfast."', late);
    expect(await f.active()).toEqual(before);
    expect(await f.recalled()).toEqual(["coffee for breakfast"]);
  });

  it("compares instants instead of timestamp spelling", async () => {
    const f = fixture();
    await f.remember(positive, "2026-08-01T08:00:00+08:00");
    const result = await f.remember(withdrawal, late);
    expect(result.events).toContainEqual(expect.objectContaining({ outcome: "rejected", reason: "unordered_preference_source" }));
    expect(await f.recalled()).toEqual(["coffee for breakfast"]);
  });

  it("recomputes against a concurrent reaffirmation after a category CAS retry", async () => {
    const store = createInMemoryDocumentStore();
    const scope = { userId: "chronology-cas", workspaceId: "synthetic" };
    const independent = createGoodMemory({ adapters: { documentStore: store, sessionStore: createInMemorySessionStore() } });
    await independent.remember({ scope, messages: [{ id: "original", role: "user", content: positive, observedAt: early }] });
    let intervened = false;
    let rejectedCAS = 0;
    const documentStore = { ...store, async writeBatchIfUnchanged(batch: Parameters<typeof store.writeBatchIfUnchanged>[0]) {
      if (!intervened && batch.set.some((entry) => entry.collection === "preferences" && (entry.document as PreferenceMemory).lifecycle === "superseded")) {
        intervened = true;
        await independent.remember({ scope, messages: [{ id: "reaffirmation", role: "user", content: positive, observedAt: late }] });
      }
      const result = await store.writeBatchIfUnchanged(batch);
      if (!result) rejectedCAS += 1;
      return result;
    } };
    const memory = createGoodMemory({ adapters: { documentStore, sessionStore: createInMemorySessionStore() } });
    const result = await memory.remember({ scope, messages: [{ id: "correction", role: "user", content: withdrawal, observedAt: middle }] });
    expect(intervened).toBe(true);
    expect(rejectedCAS).toBeGreaterThan(0);
    expect(result.events).toContainEqual(expect.objectContaining({ outcome: "rejected", reason: "stale_preference_source" }));
    expect((await independent.recall({ scope, query: "What is my preference for breakfast?", strategy: "rules-only" })).preferences.map((record) => record.value)).toEqual(["coffee for breakfast"]);
  });

  it.each(["2026-01-01", "01/02/2026"])("does not order an imported ambiguous source date %s", async (observedAt) => {
    const f = fixture();
    await f.remember(positive, middle);
    const before = await f.active();
    const [source] = await f.store.query<import("../../src/evidence/contracts").SourceMessageRecord>(SOURCE_MESSAGES_COLLECTION);
    await f.store.set(SOURCE_MESSAGES_COLLECTION, source!.id, { ...source!, observedAt });
    const result = await f.remember(withdrawal, late);
    expect(await f.active()).toEqual(before);
    expect(result.events).toContainEqual(expect.objectContaining({ outcome: "rejected", reason: "unordered_preference_source" }));
  });

  it("grounds a full-statement stored preference against its exact original source", async () => {
    const f = fixture();
    await f.remember(positive, early);
    const [record] = await f.active();
    await f.store.set("preferences", record!.id, { ...record!, value: positive });
    const result = await f.remember(withdrawal, late);
    expect(result.events).toContainEqual(expect.objectContaining({ outcome: "superseded" }));
    expect(await f.recalled()).toEqual(["I no longer prefer coffee for breakfast"]);
  });

  it.each([
    ["Archived note. I prefer coffee for breakfast.", withdrawal],
    ["I prefer coffee for meetings.", "I no longer prefer coffee for meetings."],
    ["I prefer tea for breakfast.", "I no longer prefer tea for breakfast."],
    ["I no longer prefer coffee for breakfast.", restore],
  ])("does not infer prior support for a different or compound full value: %s", async (value, correction) => {
    const f = fixture();
    await f.remember(positive, early);
    const [record] = await f.active();
    await f.store.set("preferences", record!.id, { ...record!, value });
    const before = await f.active();
    const result = await f.remember(correction!, late);
    expect(await f.active()).toEqual(before);
    expect(result.events).toContainEqual(expect.objectContaining({ outcome: "rejected", reason: "unordered_preference_source" }));
  });

  it.each(['My friend said: "I prefer coffee for breakfast."', 'Suppose I prefer coffee for breakfast.'])("does not grant prior assertion authority to %s", async (content) => {
    const f = fixture();
    await f.remember(positive, early);
    const [record] = await f.active();
    await f.store.set("preferences", record!.id, { ...record!, value: positive });
    const source = buildSourceMessageRecord(f.scope, { id: "other-context", role: "user", content, observedAt: early }, 0, late);
    await f.store.set(SOURCE_MESSAGES_COLLECTION, source.id, source);
    const [evidence] = await f.store.query<EvidenceRecord>(EVIDENCE_COLLECTION);
    await f.store.set(EVIDENCE_COLLECTION, evidence!.id, { ...evidence!, sourceRecordIds: [source.id] });
    const before = await f.active();
    const result = await f.remember(withdrawal, late);
    expect(await f.active()).toEqual(before);
    expect(result.events).toContainEqual(expect.objectContaining({ outcome: "rejected", reason: "unordered_preference_source" }));
  });

  it("does not invent source chronology for an unbound explicit revision audit", async () => {
    const f = fixture();
    await f.remember(positive);
    const [record] = await f.active();
    await f.create().reviseMemory({ scope: f.scope, target: { memoryId: record!.id },
      revision: { content: "I prefer coffee for breakfast." }, reason: "user_correction", idempotencyKey: "revision-without-source" });
    const before = await f.active();
    const result = await f.remember(withdrawal);
    expect(await f.active()).toEqual(before);
    expect(result.events).toContainEqual(expect.objectContaining({ outcome: "rejected", reason: "unordered_preference_source" }));
  });

  it.each([early, middle, undefined])("rejects an opposing ordinary assertion dated %s after a known withdrawal", async (observedAt) => {
    const f = fixture();
    await f.remember(withdrawal, middle);
    const before = await f.active();
    const result = await f.remember(positive, observedAt);
    expect(await f.active()).toEqual(before);
    expect(result.events).toContainEqual(expect.objectContaining({ outcome: "rejected", reason: observedAt === early ? "stale_preference_source" : "unordered_preference_source" }));
    expect(await f.recalled()).toEqual(["I no longer prefer coffee for breakfast"]);
  });

  it("rejects mixed-time opposition when only the ordinary positive has a date", async () => {
    const f = fixture();
    await f.remember(withdrawal);
    const before = await f.active();
    expect((await f.remember(positive, late)).events).toContainEqual(expect.objectContaining({ reason: "unordered_preference_source" }));
    expect(await f.active()).toEqual(before);
  });

  it.each([late, undefined])("keeps later or mutually undated ordinary positives admissible without new retirement power", async (positiveTime) => {
    const f = fixture();
    await f.remember(withdrawal, positiveTime ? middle : undefined);
    const negative = (await f.active())[0]!;
    const result = await f.remember(positive, positiveTime);
    expect(result.events).toContainEqual(expect.objectContaining({ outcome: "written" }));
    const active = await f.active();
    expect(active.find((record) => record.id === negative.id)).toEqual(negative);
    expect(active.some((record) => record.value === "coffee for breakfast")).toBe(true);
  });

  it("does not resurrect an older positive during the same input or an exact replay", async () => {
    const f = fixture();
    const old = { scope: { ...f.scope, sessionId: "original" }, messages: [{ id: "original", role: "user", content: positive, observedAt: early }] };
    await f.create().remember(old);
    await f.remember(withdrawal, late);
    const before = await f.store.query("preferences");
    await f.create().remember(old);
    expect(await f.store.query("preferences")).toEqual(before);
    const second = fixture();
    await second.create().remember({ scope: second.scope, messages: [
      { id: "withdrawn", role: "user", content: withdrawal, observedAt: late },
      { id: "older-positive", role: "user", content: positive, observedAt: early },
    ] });
    expect(await second.recalled()).toEqual(["I no longer prefer coffee for breakfast"]);
  });

  it("does not make absent context a wildcard for opposition admission", async () => {
    const f = fixture();
    await f.remember(withdrawal, late);
    const negative = (await f.active())[0]!;
    await f.remember("I prefer coffee.", early);
    await f.remember("I prefer coffee for meetings.", early);
    await f.create().remember({ scope: { ...f.scope, workspaceId: "other" }, messages: [{ id: "other", role: "user", content: positive, observedAt: early }] });
    const active = await f.active();
    expect(active).toHaveLength(4);
    expect(active.find((record) => record.id === negative.id)).toEqual(negative);
  });

});
