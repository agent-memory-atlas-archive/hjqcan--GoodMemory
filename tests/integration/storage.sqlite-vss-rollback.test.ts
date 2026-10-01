import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VectorRecord } from "../../src/storage/contracts";
import { createSQLiteVectorStore } from "../../src/storage/sqlite";
import {
  DEFAULT_SQLITE_VECTOR_SEARCH_FUNCTION,
  detectBundledSQLiteVssRuntime,
  type SQLiteVectorExtensionConfig,
} from "../../src/storage/sqliteRuntime";

const libraryPath = process.env.GOODMEMORY_TEST_SQLITE_VSS_LIBRARY_PATH;
const runtime = detectBundledSQLiteVssRuntime(
  libraryPath ? { libraryCandidatePaths: [libraryPath] } : {},
);
const withVss = runtime ? describe : describe.skip;
const accelerated = {
  backend: "sqlite-vss", mode: "require", paths: runtime?.paths ?? [],
  searchFunction: DEFAULT_SQLITE_VECTOR_SEARCH_FUNCTION,
} satisfies SQLiteVectorExtensionConfig;
const fallback = {
  backend: "none", mode: "off", paths: [],
  searchFunction: DEFAULT_SQLITE_VECTOR_SEARCH_FUNCTION,
} satisfies SQLiteVectorExtensionConfig;
const vector = (id: string, embedding: number[], content = id): VectorRecord => ({
  id, embedding, content, metadata: { userId: "synthetic-vss-cache-owner" },
});
const storeAt = (path: string, readOnly = false) => createSQLiteVectorStore(
  path, { readOnly }, { vectorExtensionConfig: accelerated },
);

withVss("sqlite-vss transaction cache recovery", () => {
  it("recovers a rolled-back new dimension on the same upsert facade", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gm-vss-upsert-cache-"));
    const path = join(directory, "memory.sqlite");
    let raw: Database | undefined;
    try {
      const store = storeAt(path);
      const target = vector("target", [1, 0, 0], "old");
      const neighbor = vector("neighbor", [0, 1, 0]);
      await store.upsert("facts", [target, neighbor]);
      raw = new Database(path, { strict: true });
      for (const extension of runtime!.paths) raw.loadExtension(extension);
      expect(raw.query("SELECT name FROM sqlite_master WHERE name='vss_vectors_facts_dim_3'").get()).not.toBeNull();
      const failure = new Error("synthetic batch serialization failure");
      const invalid = {
        ...vector("invalid", [1, 0, 0]),
        metadata: { toJSON: () => { throw failure; } },
      };
      let thrown: unknown;
      try {
        await store.upsert("facts", [vector("target", [1, 0, 0, 0], "uncommitted"), invalid]);
      } catch (error) { thrown = error; }
      expect(thrown).toBe(failure);
      expect(await store.get("facts", "target")).toEqual(target);
      expect(await store.get("facts", "neighbor")).toEqual(neighbor);
      expect(await store.get("facts", "invalid")).toBeNull();
      expect(raw.query("SELECT name FROM sqlite_master WHERE name='vss_vectors_facts_dim_4'").get()).toBeNull();

      const next = vector("target", [1, 0, 0, 0], "same-facade retry");
      let retryFailure: unknown;
      try { await store.upsert("facts", [next]); }
      catch (error) { retryFailure = error; }
      const afterSameFacadeRetry = await store.get("facts", "target");
      const indexBeforeSearch = raw.query("SELECT name FROM sqlite_master WHERE name='vss_vectors_facts_dim_4'").get()
        ? raw.query<{ rowid: number }, []>("SELECT rowid FROM vss_vectors_facts_dim_4").all()
        : null;
      const targetRow = raw.query<{ rowid: number }, []>("SELECT rowid FROM vectors WHERE collection='facts' AND id='target'").get();
      const neighborRow = raw.query<{ rowid: number }, []>("SELECT rowid FROM vectors WHERE collection='facts' AND id='neighbor'").get();
      const oldDimensionBeforeFresh = raw.query<{ rowid: number }, []>("SELECT rowid FROM vss_vectors_facts_dim_3 ORDER BY rowid").all();
      let sameFacadeSearch: string[] | undefined;
      let searchFailure: unknown;
      try { sameFacadeSearch = (await store.search("facts", [1, 0, 0, 0], { topK: 2 })).map(({ id }) => id); }
      catch (error) { searchFailure = error; }
      // A fresh facade is a control even when the same-facade assertion is red.
      const fresh = storeAt(path);
      await fresh.upsert("facts", [next]);
      expect((await fresh.search("facts", [1, 0, 0, 0], { topK: 2 })).map(({ id }) => id)).toEqual(["target"]);
      expect(await fresh.get("facts", "neighbor")).toEqual(neighbor);
      expect(retryFailure).toBeUndefined();
      expect(afterSameFacadeRetry).toEqual(next);
      expect(indexBeforeSearch).toEqual([{ rowid: targetRow!.rowid }]);
      expect(oldDimensionBeforeFresh).toEqual([{ rowid: neighborRow!.rowid }]);
      expect(searchFailure).toBeUndefined();
      expect(sameFacadeSearch).toEqual(["target"]);
      const readOnly = storeAt(path, true);
      expect((await readOnly.search("facts", [0, 1, 0], { topK: 1 })).map(({ id }) => id)).toEqual(["neighbor"]);
    } finally {
      raw?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("recovers a rolled-back new dimension on the same delete facade", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gm-vss-delete-cache-"));
    const path = join(directory, "memory.sqlite");
    let raw: Database | undefined;
    try {
      const target = vector("target", [1, 0, 0, 0]);
      const neighbor = vector("neighbor", [0, 1, 0]);
      const seed = createSQLiteVectorStore(path, undefined, { vectorExtensionConfig: fallback });
      await seed.upsert("facts", [target, neighbor]);
      const store = storeAt(path);
      expect((await store.search("facts", [0, 1, 0], { topK: 1 })).map(({ id }) => id)).toEqual(["neighbor"]);
      raw = new Database(path, { strict: true });
      for (const extension of runtime!.paths) raw.loadExtension(extension);
      raw.exec("CREATE TRIGGER block_target_delete BEFORE DELETE ON vectors WHEN OLD.id='target' BEGIN SELECT RAISE(ABORT,'synthetic delete failure'); END");
      let thrown: unknown;
      try { await store.delete("facts", "target"); }
      catch (error) { thrown = error; }
      expect(String(thrown)).toContain("synthetic delete failure");
      expect(await store.get("facts", "target")).toEqual(target);
      expect(await store.get("facts", "neighbor")).toEqual(neighbor);
      expect(raw.query("SELECT name FROM sqlite_master WHERE name='vss_vectors_facts_dim_4'").get()).toBeNull();
      raw.exec("DROP TRIGGER block_target_delete");

      let retryFailure: unknown;
      try { await store.delete("facts", "target"); }
      catch (error) { retryFailure = error; }
      const afterSameFacadeRetry = await store.get("facts", "target");
      const indexBeforeFreshDelete = raw.query("SELECT name FROM sqlite_master WHERE name='vss_vectors_facts_dim_4'").get()
        ? raw.query("SELECT rowid FROM vss_vectors_facts_dim_4").all()
        : null;
      raw.exec("BEGIN IMMEDIATE");
      try {
        // Cache invalidation must not break an existing neighboring dimension
        // while an unrelated connection owns writer admission.
        expect((await store.search("facts", [0, 1, 0], { topK: 1 })).map(({ id }) => id)).toEqual(["neighbor"]);
      } finally { raw.exec("ROLLBACK"); }
      const fresh = storeAt(path);
      await fresh.delete("facts", "target");
      expect(await fresh.get("facts", "target")).toBeNull();
      expect(await fresh.get("facts", "neighbor")).toEqual(neighbor);
      expect(retryFailure).toBeUndefined();
      expect(afterSameFacadeRetry).toBeNull();
      expect(indexBeforeFreshDelete).toEqual([]);
      expect(await store.search("facts", [1, 0, 0, 0], { topK: 2 })).toEqual([]);
      await store.upsert("facts", []);
      expect(await store.get("facts", "neighbor")).toEqual(neighbor);
    } finally {
      if (raw?.inTransaction) raw.exec("ROLLBACK");
      raw?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
