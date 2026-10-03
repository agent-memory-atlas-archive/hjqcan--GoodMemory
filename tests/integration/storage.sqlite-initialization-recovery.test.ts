import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSQLiteDocumentStore,
  createSQLiteSessionStore,
  createSQLiteVectorStore,
} from "../../src/storage/sqlitePublic";

describe("public SQLite initialization recovery", () => {
  it.each(["document", "session", "vector"] as const)(
    "recovers the same %s wrapper after its database path becomes usable",
    async (kind) => {
      const root = await mkdtemp(join(tmpdir(), "goodmemory-lazy-recovery-"));
      const path = join(root, "memory.sqlite");
      const scope = { userId: "recovery-user", sessionId: "session-1" };
      const record = { id: "record-1", content: "synthetic recovery fixture" };
      const buffer = {
        ...scope,
        messages: [],
        summary: record.content,
        summaryUpToIndex: 0,
        createdAt: "2026-10-03T00:00:00Z",
        lastActiveAt: "2026-10-03T00:00:00Z",
      };
      const vector = { ...record, embedding: [1, 0], metadata: {} };
      const createOperations = (): { read(): Promise<unknown>; write(): Promise<void> } => {
        if (kind === "document") {
          const store = createSQLiteDocumentStore(path);
          return {
            read: () => store.get("facts", record.id),
            write: () => store.set("facts", record.id, record),
          };
        }
        if (kind === "session") {
          const store = createSQLiteSessionStore(path);
          return {
            read: () => store.getBuffer(scope),
            write: () => store.saveBuffer(scope, buffer),
          };
        }
        const store = createSQLiteVectorStore(path);
        return {
          read: () => store.get("facts", record.id),
          write: () => store.upsert("facts", [vector]),
        };
      };

      try {
        await mkdir(path);
        const operations = createOperations();
        await expect(operations.read()).rejects.toThrow();
        await expect(operations.read()).rejects.toThrow();
        await rmdir(path);
        await operations.write();
        const expected = kind === "document" ? record : kind === "session" ? buffer : vector;
        expect(await operations.read()).toEqual(expected);
        expect(await createOperations().read()).toEqual(expected);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
