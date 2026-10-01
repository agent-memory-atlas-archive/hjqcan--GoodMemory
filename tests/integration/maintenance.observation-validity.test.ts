import { expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as localMemoryModule from "../../src";
const { createGoodMemory, createInMemoryDocumentStore, createInMemorySessionStore,
  createInMemoryVectorStore, createSQLiteDocumentStore, createPostgresDocumentStore } = process.env.GOODMEMORY_TEST_OBSERVATION_BASELINE_MODULE
  ? await import(process.env.GOODMEMORY_TEST_OBSERVATION_BASELINE_MODULE) as typeof localMemoryModule
  : localMemoryModule;
import { createFactMemory, type FactMemory } from "../../src/domain/records";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

for (const backend of ["memory", "sqlite", "postgres"] as const) {
  for (const order of ["during-generation", "after-generation"] as const) {
    const test = backend === "postgres" && !process.env.GOODMEMORY_TEST_POSTGRES_URL ? it.skip : it;
    test(`${backend}: withholds an observation after a required source is forgotten ${order}`, async () => {
      const directory = await mkdtemp(join(tmpdir(), "gm-observation-validity-"));
      const schema = `gm_test_observation_${randomUUID().replaceAll("-", "")}`;
      const documentStore = backend === "memory" ? createInMemoryDocumentStore()
        : backend === "sqlite" ? createSQLiteDocumentStore(join(directory, "memory.sqlite"))
        : createPostgresDocumentStore({ url: process.env.GOODMEMORY_TEST_POSTGRES_URL!, schema });
      const scope = { userId: "observation-owner", workspaceId: "synthetic" };
      const entered = deferred();
      const released = deferred();
      const sessionStore = createInMemorySessionStore();
      const vectorStore = createInMemoryVectorStore();
      const createMemory = () => createGoodMemory({
        storage: { provider: "memory" }, retrieval: { preset: "recommended" },
        adapters: {
          documentStore, sessionStore, vectorStore,
          observationSynthesizer: {
            async synthesize({ contents }) { entered.resolve(); await released.promise; return contents.join(" "); },
          },
        },
      });
      const memory = createMemory();
      let pendingCompletion: Promise<unknown> = Promise.resolve();
      try {
        for (const [id, content] of [
          ["source-a", "The Kestrel handbook is in the copper archive."],
          ["source-b", "The Kestrel review meeting is on Monday."],
          ["source-c", "The Kestrel maintainer is Robin."],
          ["source-d", "The Kestrel schedule includes a quarterly review."],
        ]) {
          await documentStore.set("facts", id!, createFactMemory({
            id, ...scope, category: "project", content: content!, subject: "Kestrel",
            source: { method: "explicit", extractedAt: "2026-01-01T00:00:00.000Z" },
          }));
        }
        const pending = memory.runMaintenance({ scope, jobs: ["observationSynthesis"] });
        pendingCompletion = pending;
        await Promise.race([entered.promise, pending.then(() => { throw new Error("Synthesis did not reach the deferred provider."); })]);
        if (order === "after-generation") {
          released.resolve();
          const result = await pending;
          expect(result.maintenance?.jobs[0]?.applied).toBe(1);
          const before = await createMemory().recall({ scope, query: "Where is the Kestrel handbook?" });
          expect(before.facts.some((fact) => fact.attributes?.observationOf === "Kestrel")).toBe(true);
        }
        expect((await memory.forget({ scope, memoryId: "source-a" })).forgotten).toBe(true);
        expect(await documentStore.get("facts", "source-a")).toBeNull();
        released.resolve();
        const result = await pending;
        if (order === "during-generation") expect(result.maintenance?.jobs[0]?.applied).toBe(0);
        const fresh = createMemory();
        const recalled = await fresh.recall({ scope, query: "Where is the Kestrel handbook?" });
        expect(recalled.facts.some((fact) => fact.content.includes("copper archive"))).toBe(false);
        expect(await documentStore.get("facts", "source-b")).not.toBeNull();
        await fresh.runMaintenance({ scope, jobs: ["observationSynthesis"] });
        const afterRerun = await createMemory().recall({ scope, query: "Where is the Kestrel handbook?" });
        expect(afterRerun.facts.some((fact) => fact.content.includes("copper archive"))).toBe(false);
        if (order === "after-generation") {
          // Logical current-context filtering does not claim physical erasure.
          const retained = await documentStore.query<FactMemory>("facts", {});
          expect(retained.some((fact) => fact.attributes?.observationOf === "Kestrel")).toBe(true);
        }
      } finally {
        released.resolve();
        await pendingCompletion.catch(() => {});
        if (backend === "postgres") {
          const { SQL } = await import("bun");
          const sql = new SQL(process.env.GOODMEMORY_TEST_POSTGRES_URL!, { max: 1 });
          try { await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
          finally { await sql.close(); }
        }
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
}

async function buildValidityHarness(synthesize?: (contents: readonly string[]) => Promise<string>) {
  const store = createInMemoryDocumentStore();
  const scope = { userId: "observation-controls", workspaceId: "synthetic" };
  let calls = 0;
  const memory = createGoodMemory({ storage: { provider: "memory" }, retrieval: { preset: "recommended" },
    adapters: { documentStore: store, sessionStore: createInMemorySessionStore(), vectorStore: createInMemoryVectorStore(),
      observationSynthesizer: { async synthesize({ contents }) {
        calls++; return synthesize ? synthesize(contents) : contents.join(" ");
      } },
    },
  });
  for (const [id, content] of [["a", "The Kestrel handbook is in the copper archive."], ["b", "The Kestrel review is on Monday."], ["c", "The Kestrel maintainer is Robin."], ["d", "The Kestrel schedule includes a quarterly review."]]) {
    await store.set("facts", id!, createFactMemory({ id, ...scope, category: "project", subject: "Kestrel", content: content!,
      source: { method: "explicit", extractedAt: "2026-01-01T00:00:00Z" },
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }));
  }
  const run = () => memory.runMaintenance({ scope, jobs: ["observationSynthesis"] });
  const observation = async () => (await store.query<FactMemory>("facts", {})).find((fact) => fact.attributes?.observationOf === "Kestrel")!;
  const recall = () => memory.recall({ scope, query: "Where is the Kestrel handbook?" });
  return { store, scope, memory, run, observation, recall, calls: () => calls };
}

for (const change of ["content", "inactive", "superseded", "scope"] as const) {
  it(`refuses pending generation after a same-ID source ${change} change, including identical updatedAt`, async () => {
    const entered = deferred(); const released = deferred();
    const h = await buildValidityHarness(async (contents) => { entered.resolve(); await released.promise; return contents.join(" "); });
    const pending = h.run(); await Promise.race([entered.promise, pending.then(() => { throw new Error("Synthesis did not reach the deferred provider."); })]);
    const fact = (await h.store.get<FactMemory>("facts", "a"))!;
    const next = change === "content" ? { ...fact, content: "The Kestrel handbook moved to the silver archive." }
      : change === "scope" ? { ...fact, workspaceId: "foreign" }
      : { ...fact, lifecycle: change, isActive: false };
    await h.store.set("facts", "a", next);
    released.resolve();
    expect((await pending).maintenance?.jobs[0]?.applied).toBe(0);
    expect(await h.observation()).toBeUndefined();
    expect(await h.store.get("facts", "a")).toEqual(next);
  });

  it(`withholds an existing observation after source ${change} without erasing its audit record`, async () => {
    const h = await buildValidityHarness(); await h.run();
    expect((await h.recall()).facts.some((fact) => fact.attributes?.observationOf === "Kestrel")).toBe(true);
    const before = await h.observation();
    const fact = (await h.store.get<FactMemory>("facts", "a"))!;
    await h.store.set("facts", "a", change === "content" ? { ...fact, content: "The Kestrel handbook moved to the silver archive." }
      : change === "scope" ? { ...fact, workspaceId: "foreign" }
      : { ...fact, lifecycle: change, isActive: false });
    const result = await h.recall();
    expect(result.facts.some((record) => record.id === before.id)).toBe(false);
    expect(result.metadata.policyApplied).toContain("observation_support_unverified");
    expect(await h.observation()).toEqual(before);
  });
}

it("regenerates on changed input content but not unrelated cue/verification bookkeeping", async () => {
  const h = await buildValidityHarness(); await h.run();
  const fact = (await h.store.get<FactMemory>("facts", "a"))!;
  await h.store.set("facts", "a", { ...fact, attributes: { retrievalCues: "archive location" }, verificationPressureCount: 8,
    updatedAt: "2026-01-02T00:00:00Z" });
  expect((await h.run()).maintenance?.jobs[0]?.applied).toBe(0);
  expect((await h.recall()).facts.some((record) => record.attributes?.observationOf === "Kestrel")).toBe(true);
  await h.store.set("facts", "a", { ...fact, content: "The Kestrel handbook moved to the silver archive." });
  expect((await h.run()).maintenance?.jobs[0]?.applied).toBe(1);
  expect((await h.observation()).content).toContain("silver archive");
  expect(h.calls()).toBe(2);
});

it("withholds legacy support until explicit maintenance regeneration", async () => {
  const h = await buildValidityHarness(); await h.run();
  const observation = await h.observation();
  const { observationSupportV1: _proof, ...attributes } = observation.attributes!;
  await h.store.set("facts", observation.id, { ...observation, attributes });
  expect((await h.recall()).facts.some((record) => record.id === observation.id)).toBe(false);
  expect((await h.run()).maintenance?.jobs[0]?.applied).toBe(1);
  expect((await h.recall()).facts.some((record) => record.id === observation.id)).toBe(true);
});

it("does not expose unsupported summaries to recall policy or the public reranker", async () => {
  const h = await buildValidityHarness(); await h.run();
  const source = (await h.store.get<FactMemory>("facts", "b"))!;
  await h.store.set("facts", "neighbor", { ...source, id: "neighbor", content: "The Kestrel handbook has 24 pages." });
  const seenByPolicy: string[] = []; const seenByReranker: string[] = [];
  const memory = createGoodMemory({ storage: { provider: "memory" }, retrieval: { preset: "recommended" },
    policy: { shouldRecall(record) { if (record.memoryType === "fact") seenByPolicy.push(record.content); return true; } },
    adapters: { documentStore: h.store, sessionStore: createInMemorySessionStore(), vectorStore: createInMemoryVectorStore(),
      reranker: { async rerank({ documents }) { seenByReranker.push(...documents.map(({ text }) => text));
        return documents.map(({ id }) => ({ id, score: 1 })); } },
    },
  });
  await memory.recall({ scope: h.scope, query: "Tell me about the Kestrel handbook and review." });
  expect(seenByReranker.some((content) => content.includes("copper archive"))).toBe(true);
  expect(seenByPolicy.some((content) => content.includes("copper archive"))).toBe(true);
  expect((await h.memory.forget({ scope: h.scope, memoryId: "a" })).forgotten).toBe(true);
  seenByPolicy.length = 0; seenByReranker.length = 0;
  const result = await memory.recall({ scope: h.scope, query: "Tell me about the Kestrel handbook and review." });
  expect(seenByReranker.length).toBeGreaterThan(0);
  expect([...seenByPolicy, ...seenByReranker].some((content) => content.includes("copper archive"))).toBe(false);
  expect(result.facts.some((fact) => fact.content.includes("copper archive"))).toBe(false);
});

for (const corruption of ["malformed", "duplicate", "self-cycle", "nested", "expired"] as const) {
  it(`withholds ${corruption} support without traversing untrusted dependency graphs`, async () => {
    const h = await buildValidityHarness(); await h.run();
    const observation = await h.observation();
    const proof = JSON.parse(observation.attributes!.observationSupportV1 as string);
    if (corruption === "nested" || corruption === "expired") {
      const fact = (await h.store.get<FactMemory>("facts", "a"))!;
      await h.store.set("facts", "a", corruption === "nested"
        ? { ...fact, attributes: { observationOf: "Kestrel", observationMemberIds: observation.id } }
        : { ...fact, expiresAt: "2026-01-01T00:00:01Z" });
    } else {
      if (corruption === "duplicate") proof.inputs[1] = proof.inputs[0];
      if (corruption === "self-cycle") proof.inputs[0].id = observation.id;
      await h.store.set("facts", observation.id, { ...observation, attributes: { ...observation.attributes,
        observationSupportV1: corruption === "malformed" ? "{invalid" : JSON.stringify(proof),
      } });
    }
    const result = await h.recall();
    expect(result.facts.some(({ id }) => id === observation.id)).toBe(false);
    expect(result.metadata.candidateTraces.some((trace) => trace.memoryId === observation.id &&
      trace.whySuppressed === "observation_support_unverified")).toBe(true);
  });
}

it("preserves a concurrently written target instead of replacing it with a late synthesis", async () => {
  const { scopeToKey } = await import("../../src/domain/scope");
  const entered = deferred(); const released = deferred();
  const h = await buildValidityHarness(async (contents) => { entered.resolve(); await released.promise; return contents.join(" "); });
  const pending = h.run(); await Promise.race([entered.promise, pending.then(() => { throw new Error("Synthesis did not reach the deferred provider."); })]);
  const id = `observation_v2:${scopeToKey(h.scope)}:Kestrel`;
  const target = createFactMemory({ id, ...h.scope, category: "project", content: "Concurrent trusted replacement.",
    source: { method: "explicit", extractedAt: "2026-01-01T00:00:00Z" } });
  await h.store.set("facts", id, target); released.resolve();
  expect((await pending).maintenance?.jobs[0]?.applied).toBe(0);
  expect(await h.store.get("facts", id)).toEqual(target);
});

it("skips synthesis before provider use when atomic multi-source writes are unavailable", async () => {
  const { createMemoryRepositories } = await import("../../src/storage/repositories");
  const { createMaintenanceRunner } = await import("../../src/maintenance/runner");
  const h = await buildValidityHarness();
  const { writeBatchIfUnchanged: _cas, projectionBatchSemantics: _marker, ...plainStore } = h.store;
  const repositories = createMemoryRepositories({ documentStore: plainStore, sessionStore: createInMemorySessionStore() });
  let calls = 0;
  const runner = createMaintenanceRunner({ repositories, observationSynthesis: { minFactsPerSubject: 2,
    async synthesize() { calls++; return "Must not be generated."; } } });
  expect(repositories.facts.commitDerivedIfUnchanged).toBeUndefined();
  expect((await runner.run(h.scope, ["observationSynthesis"])).jobs[0]?.applied).toBe(0);
  expect(calls).toBe(0);
});

it("withholds unsupported summaries before maintenance cue and embedding providers", async () => {
  for (const forgotten of [false, true]) {
    const h = await buildValidityHarness(); await h.run();
    const observation = await h.observation();
    if (forgotten) await h.memory.forget({ scope: h.scope, memoryId: "a" });
    const cues: string[] = []; const embeddings: string[] = [];
    const memory = createGoodMemory({ storage: { provider: "memory" },
      adapters: { documentStore: h.store, sessionStore: createInMemorySessionStore(), vectorStore: createInMemoryVectorStore(),
        retrievalCueGenerator: { async generate({ content }) { cues.push(content); return ["synthetic search cue"]; } },
        embeddingAdapter: { async embed(texts) { embeddings.push(...texts); return texts.map(() => [1, 0]); } },
      },
    });
    await memory.runMaintenance({ scope: h.scope, jobs: ["retrievalCues", "embeddingRepair"] });
    expect(cues.length).toBeGreaterThan(0);
    expect(embeddings.length).toBeGreaterThan(0);
    expect(cues.includes(observation.content)).toBe(!forgotten);
    expect(embeddings.includes(observation.content)).toBe(!forgotten);
  }
});

it("rechecks observation support immediately before each awaited recall-policy callback", async () => {
  const { applyRecallPolicyToRecords } = await import("../../src/recall/policy");
  const { filterSupportedObservations } = await import("../../src/domain/observation");
  const { checkFactSnapshots } = await import("../../src/storage/factSnapshots");
  const h = await buildValidityHarness(); await h.run();
  const observation = await h.observation();
  const a = (await h.store.get<FactMemory>("facts", "a"))!;
  const seen: string[] = [];
  const result = await applyRecallPolicyToRecords([a, observation], "fact", {
    scope: h.scope, query: "Kestrel handbook", retrievalProfile: "general_chat", locale: "en",
    localeSource: "explicit", policyApplied: new Set(),
    policy: { async shouldRecall(record) {
      if (record.memoryType === "fact") {
        seen.push(record.id);
        if (record.id === "a") await h.store.delete("facts", "a");
      }
      return true;
    } },
  }, async (fact) => (await filterSupportedObservations([fact],
    (id) => h.store.get<FactMemory>("facts", id), new Date().toISOString(),
    (facts) => checkFactSnapshots(h.store, facts))).facts.length === 1);
  expect(seen).toEqual(["a"]);
  expect(result.map(({ id }) => id)).toEqual(["a"]);
});

it("does not use a historical query clock to authorize expired support at a policy boundary", async () => {
  const h = await buildValidityHarness(); await h.run();
  const observation = await h.observation();
  const a = (await h.store.get<FactMemory>("facts", "a"))!;
  await h.store.set("facts", "a", { ...a, expiresAt: "2026-09-01T00:00:00Z" });
  let exposed = false;
  const memory = createGoodMemory({ storage: { provider: "memory" }, retrieval: { preset: "recommended" },
    testing: { now: () => new Date("2026-10-01T00:00:00Z") },
    adapters: { documentStore: h.store, sessionStore: createInMemorySessionStore(), vectorStore: createInMemoryVectorStore() },
    policy: { shouldRecall(record) { if (record.memoryType === "fact" && record.id === observation.id) exposed = true; return true; } },
  });
  await memory.recall({ scope: h.scope, query: "Where is the Kestrel handbook?", referenceTime: "2026-08-01T00:00:00Z" });
  expect(exposed).toBe(false);
});

for (const marker of ["absent", "null", "number", "future"] as const) {
  it(`withholds reserved derivation metadata with ${marker} eligibility`, async () => {
    const h = await buildValidityHarness(); await h.run();
    const observation = await h.observation();
    const attributes = { ...observation.attributes };
    if (marker === "absent") delete attributes.observationOf;
    if (marker === "null") attributes.observationOf = null;
    if (marker === "number") attributes.observationOf = 1;
    await h.store.set("facts", observation.id, { ...observation, attributes,
      ...(marker === "future" ? { validFrom: "2099-01-01T00:00:00Z" } : {}),
    });
    expect((await h.recall()).facts.some(({ id }) => id === observation.id)).toBe(false);
  });
}

it("rejects individually matching reads that never form one jointly current support snapshot", async () => {
  const { filterSupportedObservations } = await import("../../src/domain/observation");
  const { checkFactSnapshots } = await import("../../src/storage/factSnapshots");
  const h = await buildValidityHarness(); await h.run();
  const observation = await h.observation();
  const originalA = (await h.store.get<FactMemory>("facts", "a"))!;
  const originalB = (await h.store.get<FactMemory>("facts", "b"))!;
  await h.store.set("facts", "b", { ...originalB, content: "B is currently different." });
  let swapped = false; let atomicChecks = 0;
  const result = await filterSupportedObservations([observation], async (id) => {
    const value = await h.store.get<FactMemory>("facts", id);
    if (id === "a" && !swapped) {
      swapped = true;
      await h.store.set("facts", "a", { ...originalA, content: "A is now different." });
      await h.store.set("facts", "b", originalB);
    }
    return value;
  }, new Date().toISOString(), async (facts) => {
    atomicChecks++;
    return checkFactSnapshots(h.store, facts);
  });
  expect(swapped).toBe(true);
  expect(atomicChecks).toBe(1);
  expect(result.facts).toEqual([]);
  expect([...result.rejectedIds]).toEqual([observation.id]);
});

it("does not let a recall-policy callback erase dependency markers from later candidates", async () => {
  const h = await buildValidityHarness(); await h.run();
  const observation = await h.observation();
  const seen: string[] = [];
  let edited = false;
  const memory = createGoodMemory({ storage: { provider: "memory" }, retrieval: { preset: "recommended" },
    adapters: { documentStore: h.store, sessionStore: createInMemorySessionStore(), vectorStore: createInMemoryVectorStore(),
      reranker: { async rerank({ documents }) { seen.push(...documents.map(({ id }) => id));
        return documents.map(({ id }) => ({ id, score: 1 })); } },
    },
    policy: { async shouldRecall(record) {
      if (record.memoryType === "fact" && record.id === observation.id) {
        edited = true;
        for (const key of Object.keys(record.attributes ?? {})) delete record.attributes![key];
        await h.store.delete("facts", "a");
      }
      return true;
    } },
  });
  const result = await memory.recall({ scope: h.scope, query: "Where is the Kestrel handbook?" });
  expect(edited).toBe(true);
  expect((await h.observation()).attributes).toEqual(observation.attributes);
  expect(seen).not.toContain(observation.id);
  expect(result.facts.some(({ id }) => id === observation.id)).toBe(false);
});

it("rechecks support expiry after waiting for the atomic snapshot comparison", async () => {
  const { filterSupportedObservations } = await import("../../src/domain/observation");
  const { checkFactSnapshots } = await import("../../src/storage/factSnapshots");
  const h = await buildValidityHarness(); await h.run();
  const observation = await h.observation();
  const a = (await h.store.get<FactMemory>("facts", "a"))!;
  await h.store.set("facts", "a", { ...a, expiresAt: "2026-10-02T00:00:00Z" });
  let clock = "2026-10-01T00:00:00Z";
  const result = await filterSupportedObservations([observation],
    (id) => h.store.get<FactMemory>("facts", id), () => clock, async (facts) => {
      const valid = await checkFactSnapshots(h.store, facts);
      clock = "2026-10-03T00:00:00Z";
      return valid;
    });
  expect(result.facts).toEqual([]);
});

it("jointly validates all observation dependencies in one outbound batch", async () => {
  const { filterSupportedObservations } = await import("../../src/domain/observation");
  const { checkFactSnapshots } = await import("../../src/storage/factSnapshots");
  const h = await buildValidityHarness(); await h.run();
  for (const id of ["a", "b", "c", "d"]) {
    const fact = (await h.store.get<FactMemory>("facts", id))!;
    await h.store.set("facts", `second-${id}`, { ...fact, id: `second-${id}`, subject: "Willow" });
  }
  await h.run();
  const observations = (await h.store.query<FactMemory>("facts", {}))
    .filter((fact) => typeof fact.attributes?.observationOf === "string")
    .sort((a, b) => a.subject === "Kestrel" ? -1 : b.subject === "Kestrel" ? 1 : 0);
  expect(observations).toHaveLength(2);
  let changed = false; let checks = 0;
  const result = await filterSupportedObservations(observations, async (id) => {
    const record = await h.store.get<FactMemory>("facts", id);
    if (id === observations[1]!.id && !changed) { changed = true; await h.store.delete("facts", "a"); }
    return record;
  }, () => new Date().toISOString(), async (facts) => { checks++; return checkFactSnapshots(h.store, facts); });
  expect(changed).toBe(true);
  expect(checks).toBe(1);
  expect(result.facts).toEqual([]);
});

it("bounds dependency reads before collection rather than only limiting the final comparison", async () => {
  const { buildObservationSupport, filterSupportedObservations } = await import("../../src/domain/observation");
  const h = await buildValidityHarness(); await h.run();
  const template = (await h.store.get<FactMemory>("facts", "a"))!;
  const observation = await h.observation();
  const records = new Map<string, FactMemory>();
  const observations: FactMemory[] = [];
  for (let group = 0; group < 5; group++) {
    const sources = Array.from({ length: 1024 }, (_, index) => ({ ...template, id: `group-${group}-${index}` }));
    for (const source of sources) records.set(source.id, source);
    const next = { ...observation, id: `observation-${group}`, attributes: { ...observation.attributes,
      observationSupportV1: buildObservationSupport("Kestrel", sources),
    } };
    records.set(next.id, next); observations.push(next);
  }
  let reads = 0; let checks = 0;
  const result = await filterSupportedObservations([...observations, template], async (id) => {
    reads++; return records.get(id) ?? null;
  }, () => new Date().toISOString(), async () => { checks++; return true; });
  expect(reads).toBeLessThanOrEqual(4096);
  expect(checks).toBe(0);
  expect(result.facts).toEqual([template]);
});

it("does not overwrite a non-derived fact occupying the generated observation ID", async () => {
  const { scopeToKey } = await import("../../src/domain/scope");
  const h = await buildValidityHarness();
  const id = `observation_v2:${scopeToKey(h.scope)}:Kestrel`;
  const target = createFactMemory({ id, ...h.scope, category: "project", content: "Explicit independently owned fact.",
    source: { method: "explicit", extractedAt: "2026-01-01T00:00:00Z" } });
  await h.store.set("facts", id, target);
  await expect(h.run()).rejects.toThrow("non-derived");
  expect(h.calls()).toBe(0);
  expect(await h.store.get("facts", id)).toEqual(target);
});

it("revalidates a later synthesis group before its provider call after an earlier group waits", async () => {
  const h = await buildValidityHarness();
  for (const id of ["a", "b", "c", "d"]) {
    const source = (await h.store.get<FactMemory>("facts", id))!;
    await h.store.set("facts", `later-${id}`, { ...source, id: `later-${id}`, subject: "Willow" });
  }
  const entered = deferred(); const released = deferred();
  const calls: string[] = [];
  const memory = createGoodMemory({ storage: { provider: "memory" },
    adapters: { documentStore: h.store, sessionStore: createInMemorySessionStore(), vectorStore: createInMemoryVectorStore(),
      observationSynthesizer: { async synthesize({ subject, contents }) {
        calls.push(subject);
        if (subject === "Kestrel") { entered.resolve(); await released.promise; }
        return contents.join(" ");
      } },
    },
  });
  const pending = memory.runMaintenance({ scope: h.scope, jobs: ["observationSynthesis"] });
  await Promise.race([entered.promise, pending.then(() => { throw new Error("Provider prerequisite not reached."); })]);
  expect((await h.memory.forget({ scope: h.scope, memoryId: "later-a" })).forgotten).toBe(true);
  released.resolve();
  expect((await pending).maintenance?.jobs[0]?.applied).toBe(1);
  expect(calls).toEqual(["Kestrel"]);
});
