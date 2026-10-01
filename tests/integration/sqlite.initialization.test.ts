import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSQLiteDocumentStore } from "../../src/storage/sqlite";

async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "gm-sqlite-init-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("SQLite cold initialization", () => {
  it("waits within the existing budget for a competing initializer to release", async () => {
    await withDirectory(async (directory) => {
      const path = join(directory, "memory.sqlite");
      const readyPath = join(directory, "ready");
      const releaseStartPath = join(directory, "release-start");
      const releasedPath = join(directory, "released");
      const child = Bun.spawn([
        process.execPath,
        join(import.meta.dir, "fixtures/sqlite-initializer-lock.ts"),
      ], {
        stdin: new TextEncoder().encode(JSON.stringify({
          database: path, readyPath, releaseStartPath, releasedPath, releaseDelayMs: 120,
        })),
        stdout: "pipe",
        stderr: "pipe",
      });
      try {
        const deadline = Date.now() + 10_000;
        while (!await access(readyPath).then(() => true, () => false)) {
          if (Date.now() > deadline) throw new Error("Initializer did not become ready");
          await Bun.sleep(5);
        }
        await writeFile(releaseStartPath, "release");
        const store = createSQLiteDocumentStore(path);
        await store.set("control", "after-init", { id: "after-init", value: "preserved" });
        expect(await store.get("control", "after-init")).toEqual({ id: "after-init", value: "preserved" });
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout as ReadableStream).text(),
          new Response(child.stderr as ReadableStream).text(),
          child.exited,
        ]);
        expect({ stdout, stderr, code }).toEqual({ stdout: "", stderr: "", code: 0 });
        expect(await readFile(releasedPath, "utf8")).toBe("released");
        const check = new Database(path, { readonly: true, strict: true });
        try {
          expect(check.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
          expect(check.query("SELECT * FROM initializer_control").all()).toEqual([{ id: "initializer" }]);
        } finally {
          check.close();
        }
      } finally {
        if (child.exitCode === null) child.kill();
        await child.exited;
      }
    });
  }, 15_000);

  it("preserves the busy failure under a persistent initializer and recovers after release", async () => {
    await withDirectory(async (directory) => {
      const path = join(directory, "memory.sqlite");
      const owner = new Database(path, { strict: true });
      try {
        owner.exec("CREATE TABLE initializer_control (id TEXT PRIMARY KEY)");
        owner.exec("BEGIN IMMEDIATE");
        owner.query("INSERT INTO initializer_control VALUES (?)").run("owner");
        const started = performance.now();
        let failure: unknown;
        try {
          createSQLiteDocumentStore(path);
        } catch (error) {
          failure = error;
        }
        expect((failure as { code?: string } | undefined)?.code).toBe("SQLITE_BUSY");
        const elapsed = performance.now() - started;
        expect(elapsed).toBeGreaterThanOrEqual(500);
        expect(elapsed).toBeLessThan(5_000);
        expect(owner.inTransaction).toBe(true);
        expect(owner.query("SELECT * FROM initializer_control").all()).toEqual([{ id: "owner" }]);
        owner.exec("COMMIT");
        const store = createSQLiteDocumentStore(path);
        await store.set("control", "retry", { id: "retry", value: "stored" });
        expect(await store.get("control", "retry")).toEqual({ id: "retry", value: "stored" });
      } finally {
        if (owner.inTransaction) owner.exec("ROLLBACK");
        owner.close();
      }
    });
  });

  it("keeps readonly initialization usable while another writer owns the database", async () => {
    await withDirectory(async (directory) => {
      const path = join(directory, "memory.sqlite");
      const seed = createSQLiteDocumentStore(path);
      await seed.set("control", "retained", { id: "retained", value: "old" });
      const owner = new Database(path, { strict: true });
      try {
        owner.exec("BEGIN IMMEDIATE");
        const store = createSQLiteDocumentStore(path, { readOnly: true });
        expect(await store.get("control", "retained")).toEqual({ id: "retained", value: "old" });
        await expect(store.set("control", "denied", { id: "denied" })).rejects.toMatchObject({ code: "SQLITE_READONLY" });
        expect(await store.get("control", "denied")).toBeNull();
        expect(owner.inTransaction).toBe(true);
      } finally {
        if (owner.inTransaction) owner.exec("ROLLBACK");
        owner.close();
      }
    });
  });

  it("preserves corrupt-file errors and the caller's file bytes", async () => {
    await withDirectory(async (directory) => {
      const path = join(directory, "corrupt.sqlite");
      const before = Buffer.alloc(4096, 65);
      await writeFile(path, before);
      let failure: unknown;
      try {
        createSQLiteDocumentStore(path);
      } catch (error) {
        failure = error;
      }
      expect((failure as { code?: string } | undefined)?.code).toBe("SQLITE_NOTADB");
      expect(await readFile(path)).toEqual(before);
    });
  });

  it("retains the in-memory path", async () => {
    const store = createSQLiteDocumentStore(":memory:");
    await store.set("control", "in-memory", { id: "in-memory" });
    expect(await store.get("control", "in-memory")).toEqual({ id: "in-memory" });
  });
});
