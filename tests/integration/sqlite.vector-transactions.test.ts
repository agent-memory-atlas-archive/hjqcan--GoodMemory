import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VectorRecord } from "../../src/storage/contracts";
import { createSQLiteVectorStore } from "../../src/storage/sqlite";

const vector = (id: string, content = id): VectorRecord => ({
  id,
  content,
  embedding: [1, 0],
  metadata: { userId: "transaction-owner" },
});

async function withDatabase(run: (path: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "gm-vector-transaction-"));
  try {
    await run(join(directory, "memory.sqlite"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function openCompetitor(path: string): Database {
  const database = new Database(path, { strict: true });
  database.exec("PRAGMA busy_timeout = 0");
  database.exec("CREATE TABLE IF NOT EXISTS competing_commits (id TEXT PRIMARY KEY)");
  return database;
}

describe("SQLite vector transaction admission", () => {
  it("owns writer admission before reading and replacing a vector", async () => {
    await withDatabase(async (path) => {
      const store = createSQLiteVectorStore(path);
      await store.upsert("facts", [vector("target", "old"), vector("neighbor")]);
      const competitor = openCompetitor(path);
      let attempts = 0;
      let competingCode: string | undefined;
      const replacement = vector("target", "new");
      // The value is read after row identity. Force another real connection's
      // commit at that boundary, without replacing or mocking either store.
      Object.defineProperty(replacement, "embedding", {
        get() {
          if (attempts++ === 0) {
            try {
              competitor.query("INSERT INTO competing_commits VALUES (?)").run("during-upsert");
            } catch (error) {
              competingCode = (error as { code?: string }).code;
            }
          }
          return [0, 1];
        },
      });
      try {
        await store.upsert("facts", [replacement]);
        expect(competingCode).toBe("SQLITE_BUSY");
        expect((await store.get("facts", "target"))?.content).toBe("new");
        expect(await store.get("facts", "neighbor")).toEqual(vector("neighbor"));
        competitor.query("INSERT INTO competing_commits VALUES (?)").run("after-upsert");
        expect(competitor.query("SELECT id FROM competing_commits").all()).toEqual([{ id: "after-upsert" }]);
      } finally {
        competitor.close();
      }
    });
  });

  it("owns writer admission before reading and deleting a vector", async () => {
    await withDatabase(async (path) => {
      const seed = createSQLiteVectorStore(path);
      await seed.upsert("facts", [vector("target"), vector("neighbor")]);
      const competitor = openCompetitor(path);
      let competingCode: string | undefined;
      let attempts = 0;
      const store = createSQLiteVectorStore(path, undefined, {
        vectorExtensionConfig: { backend: "sqlite-vss", mode: "prefer", paths: [], searchFunction: "vss_search" },
        loadVectorExtension() {
          // Extension initialization follows the delete's identity read.
          attempts += 1;
          try {
            competitor.query("INSERT INTO competing_commits VALUES (?)").run("during-delete");
          } catch (error) {
            competingCode = (error as { code?: string }).code;
          }
          return { loaded: false };
        },
      });
      try {
        await store.delete("facts", "target");
        expect(attempts).toBe(1);
        expect(competingCode).toBe("SQLITE_BUSY");
        expect(await store.get("facts", "target")).toBeNull();
        expect(await store.get("facts", "neighbor")).toEqual(vector("neighbor"));
        competitor.query("INSERT INTO competing_commits VALUES (?)").run("after-delete");
        expect(competitor.query("SELECT id FROM competing_commits").all()).toEqual([{ id: "after-delete" }]);
      } finally {
        competitor.close();
      }
    });
  });

  it("waits for the configured admission timeout and remains usable after the owner releases", async () => {
    await withDatabase(async (path) => {
      const store = createSQLiteVectorStore(path);
      await store.upsert("facts", [vector("target", "old")]);
      const competitor = openCompetitor(path);
      try {
        competitor.exec("BEGIN IMMEDIATE");
        const started = performance.now();
        let observed: unknown;
        try {
          await store.upsert("facts", [vector("target", "blocked")]);
        } catch (error) {
          observed = error;
        }
        expect((observed as { code?: string } | undefined)?.code).toBe("SQLITE_BUSY");
        expect(performance.now() - started).toBeGreaterThanOrEqual(500);
        expect((await store.get("facts", "target"))?.content).toBe("old");
        competitor.exec("ROLLBACK");
        await store.upsert("facts", [vector("target", "after-release")]);
        expect((await store.get("facts", "target"))?.content).toBe("after-release");
      } finally {
        if (competitor.inTransaction) competitor.exec("ROLLBACK");
        competitor.close();
      }
    });
  });

  it("keeps empty batches non-writing while preserving extension initialization and readonly rejection", async () => {
    await withDatabase(async (path) => {
      let extensionLoads = 0;
      const store = createSQLiteVectorStore(path, undefined, {
        vectorExtensionConfig: { backend: "sqlite-vss", mode: "prefer", paths: [], searchFunction: "vss_search" },
        loadVectorExtension() {
          extensionLoads += 1;
          return { loaded: false };
        },
      });
      const readOnly = createSQLiteVectorStore(path, { readOnly: true });
      const competitor = openCompetitor(path);
      try {
        competitor.exec("BEGIN IMMEDIATE");
        await expect(store.upsert("facts", [])).resolves.toBeUndefined();
        expect(extensionLoads).toBe(1);
        await expect(readOnly.upsert("facts", [])).rejects.toThrow("read-only");
        expect(competitor.query("SELECT * FROM vectors").all()).toEqual([]);
      } finally {
        if (competitor.inTransaction) competitor.exec("ROLLBACK");
        competitor.close();
      }
    });
  });

  it("rolls back the whole vector and index batch after a later record fails", async () => {
    await withDatabase(async (path) => {
      const store = createSQLiteVectorStore(path);
      await store.upsert("facts", [vector("target", "old"), vector("neighbor")]);
      const competitor = openCompetitor(path);
      const indexBefore = competitor.query("SELECT * FROM vector_index_state ORDER BY table_name").all();
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      try {
        await expect(store.upsert("facts", [
          { ...vector("target", "must-roll-back"), embedding: [1, 0, 0] },
          { ...vector("invalid"), metadata: circular },
        ])).rejects.toThrow();
        expect(await store.get("facts", "target")).toEqual(vector("target", "old"));
        expect(await store.get("facts", "neighbor")).toEqual(vector("neighbor"));
        expect(await store.get("facts", "invalid")).toBeNull();
        expect(competitor.query("SELECT * FROM vector_index_state ORDER BY table_name").all()).toEqual(indexBefore);
        competitor.query("INSERT INTO competing_commits VALUES (?)").run("after-rollback");
        await store.upsert("facts", [vector("valid-retry")]);
        expect(await store.get("facts", "valid-retry")).toEqual(vector("valid-retry"));
      } finally {
        competitor.close();
      }
    });
  });

  it("releases admission after a delete callback fails without losing its target", async () => {
    await withDatabase(async (path) => {
      const seed = createSQLiteVectorStore(path);
      await seed.upsert("facts", [vector("target"), vector("neighbor")]);
      const competitor = openCompetitor(path);
      let fail = true;
      const store = createSQLiteVectorStore(path, undefined, {
        vectorExtensionConfig: { backend: "sqlite-vss", mode: "prefer", paths: [], searchFunction: "vss_search" },
        loadVectorExtension() {
          if (fail) throw new Error("synthetic extension initialization failure");
          return { loaded: false };
        },
      });
      try {
        await expect(store.delete("facts", "target")).rejects.toThrow("synthetic extension initialization failure");
        expect(await store.get("facts", "target")).toEqual(vector("target"));
        competitor.query("INSERT INTO competing_commits VALUES (?)").run("after-delete-rollback");
        fail = false;
        await store.delete("facts", "target");
        expect(await store.get("facts", "target")).toBeNull();
        expect(await store.get("facts", "neighbor")).toEqual(vector("neighbor"));
      } finally {
        competitor.close();
      }
    });
  });
});
