import { expect, it } from "bun:test";
import { SQL } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGoodMemory, createInMemorySessionStore, createSQLiteDocumentStore, createPostgresDocumentStore } from "../../src";

for (const adapter of ["sqlite", "postgres"] as const) {
  const test = adapter === "postgres" && !process.env.GOODMEMORY_TEST_POSTGRES_URL ? it.skip : it;
  test(`keeps source chronology across independent ${adapter} public facades`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "gm-preference-chronology-"));
    const schema = `gm_test_pref_time_${crypto.randomUUID().replaceAll("-", "")}`;
    const scope = { userId: "source-chronology", workspaceId: "synthetic" };
    const create = () => createGoodMemory({ adapters: {
      documentStore: adapter === "sqlite" ? createSQLiteDocumentStore(join(directory, "memory.db"))
        : createPostgresDocumentStore({ url: process.env.GOODMEMORY_TEST_POSTGRES_URL!, schema }),
      sessionStore: createInMemorySessionStore(),
    } });
    let turn = 0;
    const remember = (content: string, observedAt: string) => {
      const id = `turn-${++turn}`;
      return create().remember({ scope: { ...scope, sessionId: id }, messages: [{ id, role: "user", content, observedAt }] });
    };
    const recall = async () => (await create().recall({ scope: { ...scope, sessionId: `fresh-${turn}` }, query: "What is my preference for breakfast?" })).preferences.map((record) => record.value);
    try {
      await remember("I prefer coffee for breakfast.", "2026-01-01T00:00:00.000Z");
      await remember("I prefer coffee for breakfast.", "2026-08-01T00:00:00.000Z");
      const before = await create().exportMemory({ scope });
      const stale = await remember("I no longer prefer coffee for breakfast.", "2026-06-01T00:00:00.000Z");
      expect(stale.events).toContainEqual(expect.objectContaining({ outcome: "rejected", reason: "stale_preference_source" }));
      const after = await create().exportMemory({ scope });
      expect(after.durable.preferences).toEqual(before.durable.preferences);
      expect(after.durable.evidence).toEqual(before.durable.evidence);
      expect(after.durable.sourceMessages).toHaveLength(3);
      expect(await recall()).toEqual(["coffee for breakfast"]);
      await remember("I no longer prefer coffee for breakfast.", "2026-09-01T00:00:00.000Z");
      expect(await recall()).toEqual(["I no longer prefer coffee for breakfast"]);
      await remember("I prefer coffee for breakfast.", "2026-07-01T00:00:00.000Z");
      expect(await recall()).toEqual(["I no longer prefer coffee for breakfast"]);
      await remember("I now prefer coffee for breakfast.", "2026-07-01T00:00:00.000Z");
      expect(await recall()).toEqual(["I no longer prefer coffee for breakfast"]);
      await remember("I now prefer coffee for breakfast.", "2026-10-01T00:00:00.000Z");
      expect(await recall()).toEqual(["coffee for breakfast"]);
    } finally {
      if (adapter === "postgres") {
        const sql = new SQL(process.env.GOODMEMORY_TEST_POSTGRES_URL!);
        try { await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await sql.close(); }
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
}
