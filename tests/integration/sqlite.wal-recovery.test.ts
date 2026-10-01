import { describe, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSQLiteDocumentStore } from "../../src/storage/sqlite";

const WAL_STATEMENT = "PRAGMA journal_mode = WAL";

function sqliteFailure(code: string, errno: number): Error {
  return Object.assign(new Error("synthetic SQLite initialization conflict"), { code, errno });
}

// The retained multiprocess witness produces native SQLITE_BUSY_RECOVERY/261.
// Fault injection here makes the recovery/deadline branches deterministic;
// successful continuation still uses the real SQLite constructor and schema.
describe("SQLite WAL recovery admission", () => {
  it("continues real initialization after a transient recovery conflict", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gm-wal-recovery-"));
    const originalExec = Database.prototype.exec;
    let attempts = 0;
    const exec = spyOn(Database.prototype, "exec").mockImplementation(function (
      this: Database, ...args: Parameters<Database["exec"]>
    ) {
      if (args[0] === WAL_STATEMENT && ++attempts === 1) {
        throw sqliteFailure("SQLITE_BUSY_RECOVERY", 261);
      }
      return originalExec.apply(this, args);
    });
    try {
      const store = createSQLiteDocumentStore(join(directory, "memory.sqlite"));
      exec.mockRestore();
      expect(attempts).toBe(2);
      await store.set("control", "recovered", { id: "recovered", content: "kept" });
      expect(await store.get("control", "recovered")).toEqual({ id: "recovered", content: "kept" });
    } finally {
      exec.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["persistent recovery", "busy then recovery"])(
    "keeps one deadline and the original last error for %s",
    async (mode) => {
      const directory = await mkdtemp(join(tmpdir(), "gm-wal-recovery-budget-"));
      let elapsed = 0;
      let attempts = 0;
      const busy = sqliteFailure("SQLITE_BUSY", 5);
      const recovery = sqliteFailure("SQLITE_BUSY_RECOVERY", 261);
      const originalExec = Database.prototype.exec;
      const clock = spyOn(performance, "now").mockImplementation(() => elapsed);
      const wait = spyOn(Atomics, "wait").mockImplementation((_array, _index, _value, timeout) => {
        elapsed += timeout ?? 0;
        return "timed-out";
      });
      const close = spyOn(Database.prototype, "close");
      const exec = spyOn(Database.prototype, "exec").mockImplementation(function (
        this: Database, ...args: Parameters<Database["exec"]>
      ) {
        if (args[0] === WAL_STATEMENT) {
          attempts++;
          throw mode === "busy then recovery" && elapsed < 400 ? busy : recovery;
        }
        return originalExec.apply(this, args);
      });
      let failure: unknown;
      try {
        try { createSQLiteDocumentStore(join(directory, "memory.sqlite")); }
        catch (error) { failure = error; }
        expect(failure).toBe(recovery);
        expect(elapsed).toBe(1_000);
        expect(attempts).toBeGreaterThan(1);
        expect(close).toHaveBeenCalledTimes(1);
      } finally {
        exec.mockRestore();
        close.mockRestore();
        wait.mockRestore();
        clock.mockRestore();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ["SQLITE_BUSY_SNAPSHOT", 517],
    ["SQLITE_LOCKED", 6],
    ["SQLITE_IOERR", 10],
    ["SQLITE_CORRUPT", 11],
  ] as const)("preserves %s without retrying WAL activation", async (code, errno) => {
    const directory = await mkdtemp(join(tmpdir(), "gm-wal-nonretry-"));
    const failure = sqliteFailure(code, errno);
    const originalExec = Database.prototype.exec;
    let attempts = 0;
    const wait = spyOn(Atomics, "wait");
    const close = spyOn(Database.prototype, "close");
    const exec = spyOn(Database.prototype, "exec").mockImplementation(function (
      this: Database, ...args: Parameters<Database["exec"]>
    ) {
      if (args[0] === WAL_STATEMENT) { attempts++; throw failure; }
      return originalExec.apply(this, args);
    });
    try {
      expect(() => createSQLiteDocumentStore(join(directory, "memory.sqlite"))).toThrow(failure);
      expect(attempts).toBe(1);
      expect(wait).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      exec.mockRestore();
      close.mockRestore();
      wait.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
