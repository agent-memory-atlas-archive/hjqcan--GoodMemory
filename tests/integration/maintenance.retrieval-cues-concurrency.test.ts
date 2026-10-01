import { describe, expect, it } from "bun:test";
import { SQL } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createGoodMemory, createInMemoryDocumentStore, createInMemorySessionStore,
  createInMemoryVectorStore, createSQLiteDocumentStore, createPostgresDocumentStore,
} from "../../src";
import { createFactMemory, type FactMemory } from "../../src/domain/records";
import { createMemoryRepositories } from "../../src/storage/repositories";
import { createMaintenanceRunner } from "../../src/maintenance/runner";
import { RECALL_DOCUMENTS_COLLECTION } from "../../src/recall/projections/contracts";

const observedAt = "2026-01-01T00:00:00.000Z";
const content = "The fixture handbook is in the copper vault.";
const cue = "Where is the synthetic deployment reference?";
const scope = { userId: "cue-race-user", workspaceId: "target" };
const makeFact = (extra: Partial<FactMemory> = {}) => createFactMemory({
  id: "cue-fact", ...scope, category: "project", content,
  source: { method: "explicit", extractedAt: observedAt },
  createdAt: observedAt, updatedAt: observedAt, ...extra,
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

for (const adapter of ["memory", "sqlite", "postgres"] as const) {
  const test = adapter === "postgres" && !process.env.GOODMEMORY_TEST_POSTGRES_URL ? it.skip : it;
  describe(`retrieval cue snapshot admission (${adapter})`, () => {
    for (const change of ["forget", "content", "inactive", "superseded", "new-cues"] as const) {
      test(`does not overwrite ${change} while generation is pending`, async () => {
        const directory = await mkdtemp(join(tmpdir(), "gm-cue-cas-"));
        const schema = `gm_test_cue_${crypto.randomUUID().replaceAll("-", "")}`;
        const memoryStore = createInMemoryDocumentStore();
        const createStore = () => adapter === "memory" ? memoryStore : adapter === "sqlite"
          ? createSQLiteDocumentStore(join(directory, "memory.db"))
          : createPostgresDocumentStore({ url: process.env.GOODMEMORY_TEST_POSTGRES_URL!, schema });
        const originalStore = createStore();
        const concurrentStore = createStore();
        const sessionStore = createInMemorySessionStore();
        const vectorStore = createInMemoryVectorStore();
        const entered = deferred();
        const release = deferred();
        const create = (withGenerator = false) => createGoodMemory({
          adapters: { documentStore: withGenerator ? originalStore : concurrentStore, sessionStore, vectorStore,
            ...(withGenerator ? { retrievalCueGenerator: { async generate() {
              entered.resolve(); await release.promise; return [cue];
            } } } : {}),
          },
          retrieval: { preset: "recommended" },
        });
        let pending: ReturnType<ReturnType<typeof create>["runMaintenance"]> | undefined;
        try {
          const original = makeFact();
          const neighbor = makeFact({ id: "other-scope", workspaceId: "neighbor", content: "The neighbor notebook is in the blue cabinet." });
          await originalStore.set("facts", original.id, original);
          await originalStore.set("facts", neighbor.id, neighbor);
          const maintenance = create(true);
          await maintenance.recall({ scope, query: "Where is the fixture handbook?" });
          pending = maintenance.runMaintenance({ scope, jobs: ["retrievalCues"] });
          await entered.promise;
          let expected: FactMemory | null;
          if (change === "forget") {
            expect((await create().forget({ scope, memoryId: original.id })).forgotten).toBe(true);
            expected = null;
          } else {
            expected = makeFact(change === "content" ? { content: "The revised handbook is in the silver safe." }
              : change === "inactive" ? { lifecycle: "inactive", isActive: false }
              : change === "superseded" ? { lifecycle: "superseded", isActive: false, supersededBy: "successor" }
              : { attributes: { retrievalCues: "A newer cue from another maintenance run." } });
            // Keep the timestamp unchanged: the full source snapshot is the version.
            await concurrentStore.set("facts", expected.id, expected);
          }
          expect(await originalStore.get("facts", original.id)).toEqual(expected);
          release.resolve();
          const report = await pending;
          expect(await concurrentStore.get("facts", original.id)).toEqual(expected);
          expect(report.maintenance?.jobs.find((job) => job.name === "retrievalCues")?.applied).toBe(0);
          expect(await concurrentStore.get("facts", neighbor.id)).toEqual(neighbor);
          const fresh = create();
          const recalled = await fresh.recall({ scope: { ...scope, sessionId: "fresh" }, query: "Where is the fixture handbook?" });
          if (change === "forget" || change === "inactive" || change === "superseded") {
            expect(recalled.facts.some((fact) => fact.id === original.id)).toBe(false);
          } else if (change === "content") {
            expect(recalled.facts.some((fact) => fact.content === content)).toBe(false);
          }
          if (change === "forget") {
            expect(await originalStore.query(RECALL_DOCUMENTS_COLLECTION, { sourceMemoryId: original.id })).toEqual([]);
            const context = await fresh.buildContext({ recall: recalled, output: "system_prompt_fragment" });
            expect(JSON.stringify(context)).not.toContain("copper vault");
          }
        } finally {
          release.resolve();
          await pending?.catch(() => undefined);
          if (adapter === "postgres") {
            const sql = new SQL(process.env.GOODMEMORY_TEST_POSTGRES_URL!, { max: 1 });
            try { await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await sql.close(); }
          }
          await rm(directory, { recursive: true, force: true });
        }
      });
    }
  });
}

describe("retrieval cue conditional capability", () => {
  it("cannot move a conditional fact update into another identity or scope", async () => {
    const store = createInMemoryDocumentStore();
    const repositories = createMemoryRepositories({ documentStore: store, sessionStore: createInMemorySessionStore() });
    const original = makeFact();
    await repositories.facts.add(original);
    for (const change of [{ id: "other-id" }, { userId: "other-user" }, { tenantId: "other-tenant" },
      { workspaceId: "other-workspace" }, { agentId: "other-agent" }]) {
      await expect(repositories.facts.updateIfUnchanged!(original, makeFact(change)))
        .rejects.toThrow("preserve identity and durable scope");
    }
    expect(await store.query("facts")).toEqual([original]);
  });

  it("skips generation entirely when the repository has no atomic conditional update", async () => {
    const store = createInMemoryDocumentStore();
    const { writeBatchIfUnchanged: _cas, projectionBatchSemantics: _semantics, ...plainStore } = store;
    const repositories = createMemoryRepositories({ documentStore: plainStore, sessionStore: createInMemorySessionStore() });
    const original = makeFact();
    await repositories.facts.add(original);
    let generated = 0;
    const runner = createMaintenanceRunner({ repositories, retrievalCues: { async generate() { generated++; return [cue]; } } });
    const report = await runner.run(scope, ["retrievalCues"]);
    expect(generated).toBe(0);
    expect(report.jobs[0]?.applied).toBe(0);
    expect(await repositories.facts.get(original.id)).toEqual(original);
  });

  it("allows a real atomic store without projection capabilities", async () => {
    const store = createInMemoryDocumentStore();
    const { projectionBatchSemantics: _semantics, ...atomicStore } = store;
    const repositories = createMemoryRepositories({ documentStore: atomicStore, sessionStore: createInMemorySessionStore() });
    await repositories.facts.add(makeFact());
    const runner = createMaintenanceRunner({ repositories, retrievalCues: { async generate() { return [cue]; } } });
    const report = await runner.run(scope, ["retrievalCues"]);
    expect(report.jobs[0]?.applied).toBe(1);
    expect((await repositories.facts.get("cue-fact"))?.attributes?.retrievalCues).toBe(cue);
  });
});
