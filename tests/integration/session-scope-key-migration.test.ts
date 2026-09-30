import { SQL } from "bun";
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SessionBuffer, SessionJournal, WorkingMemorySnapshot } from "../../src/domain/records";
import { legacyScopeToKey, normalizeScope, scopeToKey, type MemoryScope } from "../../src/domain/scope";
import type { SessionStateKind, SessionStore } from "../../src/storage/contracts";
import { createSQLiteSessionStore } from "../../src/storage/sqlite";
import { createInMemorySessionStore } from "../../src/storage/memory";
import { createPostgresSessionStore } from "../../src/storage/postgres";
import { createSQLiteSessionStore as createPublicSQLiteSessionStore } from "../../src/storage/sqlitePublic";
import { createPostgresSessionStore as createPublicPostgresSessionStore } from "../../src/storage/postgresPublic";
import { createAutoStorageAdapters } from "../../src/storage/auto";
import { legacyResolutionKey } from "../../src/storage/sessionScopeKeys";

const scope: MemoryScope = { userId: "alice", tenantId: "team", workspaceId: "work", agentId: "agent", sessionId: "session" };
const left: MemoryScope = { ...scope, userId: "alice::team", tenantId: "private" };
const right: MemoryScope = { ...scope, userId: "alice", tenantId: "team::private" };
const timestamp = "2026-01-01T00:00:00Z";
const values = {
  buffer: { userId: "alice", sessionId: "session", messages: [], summary: "private buffer", summaryUpToIndex: 0, createdAt: timestamp, lastActiveAt: timestamp } satisfies SessionBuffer,
  working_memory: { userId: "alice", sessionId: "session", currentGoal: "private goal", openLoops: [], updatedAt: timestamp } satisfies WorkingMemorySnapshot,
  journal: { userId: "alice", sessionId: "session", worklog: ["private journal"], updatedAt: timestamp } satisfies SessionJournal,
};
const kinds = ["buffer", "working_memory", "journal"] as const;
type State = SessionBuffer | WorkingMemorySnapshot | SessionJournal;
const tableNames = { buffer: "session_buffers", working_memory: "session_working_memory", journal: "session_journals" } as const;

function stateApi(store: SessionStore, kind: SessionStateKind) {
  return {
    get(target: MemoryScope) {
      return kind === "buffer" ? store.getBuffer(target) : kind === "working_memory"
        ? store.getWorkingMemory(target) : store.getJournal(target);
    },
    save(target: MemoryScope, value: State) {
      return kind === "buffer" ? store.saveBuffer(target, value as SessionBuffer) : kind === "working_memory"
        ? store.saveWorkingMemory(target, value as WorkingMemorySnapshot) : store.saveJournal(target, value as SessionJournal);
    },
    delete(target: MemoryScope) {
      return kind === "buffer" ? store.deleteBuffersByScope(target) : kind === "working_memory"
        ? store.deleteWorkingMemoryByScope(target) : store.deleteJournalsByScope(target);
    },
    recover(target: MemoryScope, expectedValue: State, legacyKey = legacyScopeToKey(target)) {
      return store.recoverLegacyState!({ kind, scope: target, expectedValue, legacyKey } as Parameters<NonNullable<SessionStore["recoverLegacyState"]>>[0]);
    },
  };
}

interface Fixture {
  store: SessionStore;
  reopen(readOnly?: boolean): SessionStore;
  publicStore(): SessionStore;
  seed(kind: SessionStateKind, key: string, value: unknown): Promise<void>;
  rows(kind: SessionStateKind): Promise<Array<{ key: string; value: unknown }>>;
  failMarkers(kind: SessionStateKind, fail: boolean): Promise<void>;
  cleanup(): Promise<void>;
}

function sqliteFixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "gm-key-migration-"));
  const path = join(root, "state.sqlite");
  const store = createSQLiteSessionStore(path);
  const database = new Database(path);
  return {
    store,
    reopen: (readOnly = false) => createSQLiteSessionStore(path, { readOnly }),
    publicStore: () => createPublicSQLiteSessionStore(path),
    async seed(kind, key, value) {
      database.run(`INSERT INTO ${tableNames[kind]} (scope_key,json) VALUES (?,?) ON CONFLICT(scope_key) DO UPDATE SET json=excluded.json`, [key, JSON.stringify(value)]);
    },
    async rows(kind) {
      return database.query<{ scope_key: string; json: string }, []>(`SELECT scope_key,json FROM ${tableNames[kind]} ORDER BY scope_key`).all()
        .map((row) => ({ key: row.scope_key, value: JSON.parse(row.json) }));
    },
    async failMarkers(kind, fail) {
      if (!fail) { database.run("DROP TRIGGER IF EXISTS reject_marker"); return; }
      database.run(`CREATE TRIGGER reject_marker BEFORE INSERT ON ${tableNames[kind]}
        WHEN NEW.scope_key LIKE 'gm2r:%' BEGIN SELECT RAISE(ABORT, 'injected marker failure'); END`);
    },
    async cleanup() { database.close(); rmSync(root, { recursive: true, force: true }); },
  };
}
const postgresUrl = process.env.GOODMEMORY_TEST_POSTGRES_URL;
async function postgresFixture(): Promise<Fixture> {
  if (!postgresUrl) throw new Error("GOODMEMORY_TEST_POSTGRES_URL is required");
  const schema = `gm_test_key_migration_${crypto.randomUUID().replaceAll("-", "")}`;
  const config = { url: postgresUrl, schema };
  const store = createPostgresSessionStore(config);
  await store.getBuffer(scope);
  const sql = new SQL(postgresUrl);
  const table = `"${schema}".gm_session_state`;
  return {
    store,
    reopen: (readOnly = false) => createPostgresSessionStore(config, { readOnly }),
    publicStore: () => createPublicPostgresSessionStore(config),
    async seed(kind, key, value) {
      await sql.unsafe(`INSERT INTO ${table} (scope_key,state_kind,payload,updated_at) VALUES ($1,$2,$3::text::jsonb,NOW())
        ON CONFLICT(scope_key,state_kind) DO UPDATE SET payload=excluded.payload`, [key, kind, JSON.stringify(value)]);
    },
    async rows(kind) {
      const rows = await sql.unsafe<Array<{ scope_key: string; json: string }>>(`SELECT scope_key,payload::text AS json FROM ${table} WHERE state_kind=$1 ORDER BY scope_key`, [kind]);
      return rows.map((row) => ({ key: row.scope_key, value: JSON.parse(row.json) }));
    },
    async failMarkers(_kind, fail) {
      if (!fail) { await sql.unsafe(`DROP TRIGGER IF EXISTS reject_marker ON ${table}`); return; }
      await sql.unsafe(`CREATE FUNCTION "${schema}".reject_marker() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.scope_key LIKE 'gm2r:%' THEN RAISE EXCEPTION 'injected marker failure'; END IF; RETURN NEW; END $$`);
      await sql.unsafe(`CREATE TRIGGER reject_marker BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION "${schema}".reject_marker()`);
    },
    async cleanup() { try { await sql.unsafe(`DROP SCHEMA "${schema}" CASCADE`); } finally { await sql.close(); } },
  };
}

for (const [name, create] of [
  ["in-memory", () => ({ store: createInMemorySessionStore(), cleanup: async () => {} })],
  ["SQLite", sqliteFixture],
] as const) {
  describe(`${name} v2 scope identity`, () => {
    for (const kind of kinds) {
      for (const pair of [[left, right], [{ ...scope, userId: "alice:" }, { ...scope, tenantId: ":team" }]] as const) {
        it(`${kind}: isolates colliding legacy encodings ${pair[0].userId}`, async () => {
          const fixture = create();
          try {
            const api = stateApi(fixture.store, kind);
            const changed = { ...values[kind], userId: "second-owner" };
            expect(legacyScopeToKey(pair[0])).toBe(legacyScopeToKey(pair[1]));
            await api.save(pair[0], values[kind]);
            await api.save(pair[1], changed);
            expect(await api.get(pair[0])).toEqual(values[kind]);
            expect(await api.get(pair[1])).toEqual(changed);
            expect(await api.delete(pair[0])).toBe(1);
            expect(await api.get(pair[1])).toEqual(changed);
          } finally { await fixture.cleanup(); }
        });
      }
    }
    it("provides additive recovery inspection with no legacy records", async () => {
      const fixture = create();
      try {
        expect(await fixture.store.listLegacyScopes!()).toEqual([]);
        expect(await stateApi(fixture.store, "buffer").recover(left, values.buffer)).toBe(false);
      } finally { await fixture.cleanup(); }
    });
  });
}

function migrationContract(name: string, create: () => Fixture | Promise<Fixture>, available = true) {
  (available ? describe : describe.skip)(`${name} legacy session migration`, () => {
    for (const kind of kinds) {
      const original = values[kind];
      it(`${kind}: blocks ambiguous read/write/delete, without modifying original or neighbors`, async () => {
        const fixture = await create();
        try {
          const api = stateApi(fixture.store, kind);
          await fixture.seed(kind, legacyScopeToKey(left), original);
          await api.save(scope, original);
          const before = await fixture.rows(kind);
          for (const candidate of [left, right]) {
            await expect(api.get(candidate)).rejects.toHaveProperty("code", "GOODMEMORY_LEGACY_SCOPE_AMBIGUOUS");
            await expect(api.save(candidate, { ...original, userId: "wrong-owner" })).rejects.toHaveProperty("code", "GOODMEMORY_LEGACY_SCOPE_AMBIGUOUS");
            await expect(api.delete(candidate)).rejects.toHaveProperty("code", "GOODMEMORY_LEGACY_SCOPE_AMBIGUOUS");
          }
          expect(await fixture.rows(kind)).toEqual(before);
          const metadata = await fixture.store.listLegacyScopes!();
          expect(metadata).toEqual([{ kind, legacyKey: legacyScopeToKey(left), scope: null, resolvedTo: null }]);
          expect(JSON.stringify(metadata)).not.toContain("private buffer");
          expect(JSON.stringify(metadata)).not.toContain("private goal");
          expect(JSON.stringify(metadata)).not.toContain("private journal");
        } finally { await fixture.cleanup(); }
      });
      it(`${kind}: reads uniquely owned legacy state without writing, then migrates on save`, async () => {
        const fixture = await create();
        try {
          const api = stateApi(fixture.store, kind);
          await fixture.seed(kind, legacyScopeToKey(scope), original);
          const before = await fixture.rows(kind);
          expect(await api.get(scope)).toEqual(original);
          expect(await stateApi(fixture.reopen(true), kind).get(scope)).toEqual(original);
          expect(await fixture.rows(kind)).toEqual(before);
          const next = { ...original, userId: "updated-payload" };
          await api.save(scope, next);
          expect(await api.get(scope)).toEqual(next);
          expect((await fixture.rows(kind)).find((row) => row.key === legacyScopeToKey(scope))?.value).toEqual(original);
          expect(await fixture.store.listLegacyScopes!()).toEqual([{ kind, legacyKey: legacyScopeToKey(scope), scope: normalizeScope(scope), resolvedTo: normalizeScope(scope) }]);
          expect(await api.delete(scope)).toBe(1);
          expect(await stateApi(fixture.reopen(), kind).get(scope)).toBeNull();
          const remaining = await fixture.rows(kind);
          expect(remaining).toHaveLength(1);
          expect(remaining[0]!.key).toBe(legacyResolutionKey(legacyScopeToKey(scope)));
          expect(JSON.stringify(remaining)).not.toContain("private");
        } finally { await fixture.cleanup(); }
      });
      it(`${kind}: recovers exactly one owner across restart and never overwrites or resurrects`, async () => {
        const fixture = await create();
        try {
          await fixture.seed(kind, legacyScopeToKey(left), original);
          const api = stateApi(fixture.store, kind);
          expect(await api.recover(left, { ...original, userId: "stale" })).toBe(false);
          expect(await api.recover(scope, original, legacyScopeToKey(left))).toBe(false);
          expect(await api.recover(left, original)).toBe(true);
          expect(await api.recover(left, original)).toBe(true);
          const restarted = stateApi(fixture.reopen(), kind);
          expect(await restarted.recover(right, original)).toBe(false);
          expect(await restarted.get(left)).toEqual(original);
          expect(await restarted.get(right)).toBeNull();
          expect((await fixture.rows(kind)).find((row) => row.key === legacyScopeToKey(left))?.value).toEqual(original);
          const next = { ...original, userId: "changed-target" };
          await restarted.save(left, next);
          expect(await restarted.recover(left, original)).toBe(false);
          expect(await restarted.get(left)).toEqual(next);
          expect(await restarted.delete(left)).toBe(1);
          expect(await restarted.recover(left, original)).toBe(false);
          expect(await restarted.recover(right, original)).toBe(false);
          expect(await restarted.get(left)).toBeNull();
          // Even re-importing the old backup cannot resurrect or reassign it.
          await fixture.seed(kind, legacyScopeToKey(left), original);
          expect(await restarted.get(left)).toBeNull();
          expect(await restarted.recover(right, original)).toBe(false);
          expect(await restarted.recover(left, original)).toBe(false);
        } finally { await fixture.cleanup(); }
      });
      it(`${kind}: rejects a target conflict and changed original without consuming ownership`, async () => {
        const fixture = await create();
        try {
          const api = stateApi(fixture.store, kind);
          const changed = { ...original, userId: "changed" };
          await api.save(left, changed);
          await fixture.seed(kind, legacyScopeToKey(left), original);
          const before = await fixture.rows(kind);
          expect(await api.recover(left, original)).toBe(false);
          expect(await fixture.rows(kind)).toEqual(before);
          await fixture.seed(kind, scopeToKey(left), original);
          expect(await api.recover(left, original)).toBe(true);
          await fixture.seed(kind, legacyScopeToKey(left), changed);
          expect(await api.recover(left, original)).toBe(false);
          expect(await api.get(left)).toEqual(original);
          await api.save(left, changed);
          expect(await api.recover(left, changed)).toBe(false);
        } finally { await fixture.cleanup(); }
      });
      it(`${kind}: fails bulk deletion before partial mutation, then deletes only confirmed owner`, async () => {
        const fixture = await create();
        try {
          const api = stateApi(fixture.store, kind);
          const owner = { ...scope, sessionId: "session::child" };
          const other = { ...scope, agentId: "agent::session", sessionId: "child" };
          await api.save(scope, original);
          await fixture.seed(kind, legacyScopeToKey({ ...scope, sessionId: "older" }), original);
          await fixture.seed(kind, legacyScopeToKey(owner), original);
          const before = await fixture.rows(kind);
          await expect(api.delete({ ...scope, sessionId: undefined })).rejects.toHaveProperty("code", "GOODMEMORY_LEGACY_SCOPE_AMBIGUOUS");
          expect(await fixture.rows(kind)).toEqual(before);
          expect(await api.recover(other, original)).toBe(true);
          expect(await api.delete({ ...scope, sessionId: undefined })).toBe(2);
          expect(await api.get(other)).toEqual(original);
          expect((await fixture.rows(kind)).some((row) => row.key === legacyScopeToKey(owner))).toBe(true);
          expect(await api.delete(other)).toBe(1);
          expect((await fixture.rows(kind)).every((row) => row.key.startsWith("gm2r:"))).toBe(true);
        } finally { await fixture.cleanup(); }
      });
      it(`${kind}: keeps metadata inspection and legacy reads non-mutating in read-only mode`, async () => {
        const fixture = await create();
        try {
          await fixture.seed(kind, legacyScopeToKey(left), original);
          await fixture.seed(kind, legacyScopeToKey(scope), original);
          const before = await fixture.rows(kind);
          const readOnly = fixture.reopen(true);
          const api = stateApi(readOnly, kind);
          expect((await readOnly.listLegacyScopes!()).length).toBe(2);
          expect(await api.get(scope)).toEqual(original);
          await expect(api.get(left)).rejects.toHaveProperty("code", "GOODMEMORY_LEGACY_SCOPE_AMBIGUOUS");
          await expect(api.recover(left, original)).rejects.toThrow(/read.only/i);
          await expect(api.save(scope, original)).rejects.toThrow(/read.only/i);
          await expect(api.delete(scope)).rejects.toThrow(/read.only/i);
          expect(await fixture.rows(kind)).toEqual(before);
        } finally { await fixture.cleanup(); }
      });
      it(`${kind}: rolls back target and marker together on an injected storage failure`, async () => {
        const fixture = await create();
        try {
          const api = stateApi(fixture.store, kind);
          await fixture.seed(kind, legacyScopeToKey(left), original);
          const before = await fixture.rows(kind);
          await fixture.failMarkers(kind, true);
          await expect(api.recover(left, original)).rejects.toThrow("injected marker failure");
          expect(await fixture.rows(kind)).toEqual(before);
          await fixture.failMarkers(kind, false);
          expect(await api.recover(left, original)).toBe(true);
        } finally { await fixture.cleanup(); }
      });
      it(`${kind}: rolls back automatic migration and deletion if its marker write fails`, async () => {
        const fixture = await create();
        try {
          const api = stateApi(fixture.store, kind);
          await fixture.seed(kind, legacyScopeToKey(scope), original);
          const before = await fixture.rows(kind);
          await fixture.failMarkers(kind, true);
          await expect(api.save(scope, { ...original, userId: "next" })).rejects.toThrow("injected marker failure");
          expect(await fixture.rows(kind)).toEqual(before);
          await expect(api.delete(scope)).rejects.toThrow("injected marker failure");
          expect(await fixture.rows(kind)).toEqual(before);
          await fixture.failMarkers(kind, false);
          expect(await api.delete(scope)).toBe(1);
          expect(await api.get(scope)).toBeNull();
        } finally { await fixture.cleanup(); }
      });
      it(`${kind}: preserves a changed original and target when deleting a prior trusted claim`, async () => {
        const fixture = await create();
        try {
          const api = stateApi(fixture.store, kind);
          await fixture.seed(kind, legacyScopeToKey(left), original);
          expect(await api.recover(left, original)).toBe(true);
          await fixture.seed(kind, legacyScopeToKey(left), { ...original, userId: "changed-after-recovery" });
          const before = await fixture.rows(kind);
          await expect(api.delete(left)).rejects.toHaveProperty("code", "GOODMEMORY_LEGACY_SCOPE_AMBIGUOUS");
          await expect(api.delete({ ...left, sessionId: undefined })).rejects.toHaveProperty("code", "GOODMEMORY_LEGACY_SCOPE_AMBIGUOUS");
          expect(await fixture.rows(kind)).toEqual(before);
        } finally { await fixture.cleanup(); }
      });
      it(`${kind}: allows only one winner among concurrent recovery claims`, async () => {
        const fixture = await create();
        try {
          await fixture.seed(kind, legacyScopeToKey(left), original);
          const results = await Promise.all([
            stateApi(fixture.store, kind).recover(left, original),
            stateApi(fixture.reopen(), kind).recover(right, original),
          ]);
          expect(results.filter(Boolean)).toHaveLength(1);
          const winner = results[0] ? left : right;
          const loser = results[0] ? right : left;
          expect(await stateApi(fixture.store, kind).get(winner)).toEqual(original);
          expect(await stateApi(fixture.store, kind).get(loser)).toBeNull();
        } finally { await fixture.cleanup(); }
      });
    }
    it("resolves each state kind independently and accepts JSON-equivalent expected payloads", async () => {
      const fixture = await create();
      try {
        await fixture.seed("buffer", legacyScopeToKey(left), values.buffer);
        await fixture.seed("journal", legacyScopeToKey(left), values.journal);
        const buffer = stateApi(fixture.store, "buffer");
        const journal = stateApi(fixture.store, "journal");
        expect(await buffer.recover(left, { ...values.buffer, compactedMessages: undefined })).toBe(true);
        const reordered = Object.fromEntries(Object.entries(values.buffer).reverse()) as unknown as SessionBuffer;
        expect(await buffer.recover(left, reordered)).toBe(true);
        expect(await journal.recover(right, values.journal)).toBe(true);
        expect(await buffer.get(right)).toBeNull();
        expect(await journal.get(left)).toBeNull();
        expect(await buffer.get(left)).toEqual(values.buffer);
        expect(await journal.get(right)).toEqual(values.journal);
      } finally { await fixture.cleanup(); }
    });
    it("rejects malformed ownership markers without hiding or mutating unresolved originals", async () => {
      const fixture = await create();
      try {
        const legacyKey = legacyScopeToKey(left);
        await fixture.seed("buffer", legacyKey, values.buffer);
        const malformed = [null, { version: 2, ownerKey: scopeToKey(left) },
          { version: 2, ownerKey: scopeToKey(scope), sourceDigest: "a".repeat(64) }];
        for (const marker of malformed) {
          await fixture.seed("buffer", legacyResolutionKey(legacyKey), marker);
          const before = await fixture.rows("buffer");
          const api = stateApi(fixture.store, "buffer");
          await expect(api.get(left)).rejects.toHaveProperty("code", "GOODMEMORY_LEGACY_SCOPE_AMBIGUOUS");
          await expect(api.save(left, values.buffer)).rejects.toHaveProperty("code", "GOODMEMORY_LEGACY_SCOPE_AMBIGUOUS");
          await expect(api.delete(left)).rejects.toHaveProperty("code", "GOODMEMORY_LEGACY_SCOPE_AMBIGUOUS");
          await expect(api.recover(left, values.buffer)).rejects.toHaveProperty("code", "GOODMEMORY_LEGACY_SCOPE_AMBIGUOUS");
          await expect(fixture.store.listLegacyScopes!()).rejects.toHaveProperty("code", "GOODMEMORY_LEGACY_SCOPE_AMBIGUOUS");
          expect(await fixture.rows("buffer")).toEqual(before);
        }
      } finally { await fixture.cleanup(); }
    });
    it("buffer CAS blocks ambiguity and migrates safe rows without stale-write loss", async () => {
      const fixture = await create();
      try {
        const { store } = fixture;
        const original = values.buffer;
        await fixture.seed("buffer", legacyScopeToKey(left), original);
        await expect(store.saveBufferIfUnchanged(left, null, original)).rejects.toHaveProperty("code", "GOODMEMORY_LEGACY_SCOPE_AMBIGUOUS");
        await expect(store.saveBufferIfUnchanged(right, original, original)).rejects.toHaveProperty("code", "GOODMEMORY_LEGACY_SCOPE_AMBIGUOUS");
        await expect(store.deleteBufferIfUnchanged(left, original)).rejects.toHaveProperty("code", "GOODMEMORY_LEGACY_SCOPE_AMBIGUOUS");
        await fixture.seed("buffer", legacyScopeToKey(scope), original);
        expect(await store.saveBufferIfUnchanged(scope, null, original)).toBe(false);
        const next = { ...original, summary: "new" };
        expect(await store.saveBufferIfUnchanged(scope, next, original)).toBe(false);
        expect(await store.saveBufferIfUnchanged(scope, { ...original, compactedMessages: undefined }, next)).toBe(true);
        expect(await store.deleteBufferIfUnchanged(scope, original)).toBe(false);
        expect(await store.deleteBufferIfUnchanged(scope, next)).toBe(true);
        expect(await fixture.reopen().getBuffer(scope)).toBeNull();
        expect((await fixture.rows("buffer")).some((row) => row.key === legacyScopeToKey(scope))).toBe(false);
      } finally { await fixture.cleanup(); }
    });
    it("recognizes namespace-looking legacy user IDs instead of treating them as markers", async () => {
      const fixture = await create();
      try {
        for (const userId of ["gm2:owner", "gm2r:owner"]) {
          const candidate = { ...scope, userId };
          await fixture.seed("buffer", legacyScopeToKey(candidate), values.buffer);
          expect(await fixture.store.getBuffer(candidate)).toEqual(values.buffer);
          expect(await fixture.store.deleteBuffersByScope(candidate)).toBe(1);
          expect(await fixture.store.getBuffer(candidate)).toBeNull();
        }
        expect(await fixture.store.listLegacyScopes!()).toEqual([]);
      } finally { await fixture.cleanup(); }
    });
  });
}

migrationContract("SQLite", sqliteFixture);
migrationContract("PostgreSQL", postgresFixture, Boolean(postgresUrl));

describe("recovery API forwarding", () => {
  it("forwards public SQLite and auto SQLite operations", async () => {
    const root = mkdtempSync(join(tmpdir(), "gm-key-wrapper-"));
    const path = join(root, "store.sqlite");
    try {
      createSQLiteSessionStore(path);
      const database = new Database(path);
      database.run("INSERT INTO session_buffers(scope_key,json) VALUES (?,?)", [legacyScopeToKey(left), JSON.stringify(values.buffer)]);
      database.close();
      const publicStore = createPublicSQLiteSessionStore(path);
      expect((await publicStore.listLegacyScopes!()).length).toBe(1);
      const auto = createAutoStorageAdapters({ sqliteUrl: path }).sessionStore;
      expect(await stateApi(auto, "buffer").recover(left, values.buffer)).toBe(true);
      expect(await publicStore.getBuffer(left)).toEqual(values.buffer);
      expect((await auto.listLegacyScopes!())[0]!.resolvedTo).toEqual(normalizeScope(left));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("forwards auto memory recovery capabilities", async () => {
    const store = createAutoStorageAdapters({ fallbackProvider: "memory" }).sessionStore;
    expect(await store.listLegacyScopes!()).toEqual([]);
    expect(await stateApi(store, "buffer").recover(scope, values.buffer)).toBe(false);
  });
  (postgresUrl ? it : it.skip)("forwards public PostgreSQL operations", async () => {
    const fixture = await postgresFixture();
    try {
      await fixture.seed("buffer", legacyScopeToKey(left), values.buffer);
      const store = fixture.publicStore();
      expect((await store.listLegacyScopes!()).length).toBe(1);
      expect(await stateApi(store, "buffer").recover(left, values.buffer)).toBe(true);
      expect(await store.getBuffer(left)).toEqual(values.buffer);
    } finally { await fixture.cleanup(); }
  });
});

(postgresUrl ? describe : describe.skip)("PostgreSQL session lock concurrency", () => {
  it("does not block another scope while one scope is stalled inside its write", async () => {
    const schema = `gm_test_key_parallel_${crypto.randomUUID().replaceAll("-", "")}`;
    const config = { url: postgresUrl!, schema };
    const store = createPostgresSessionStore(config);
    const sql = new SQL(postgresUrl!);
    const lockName = `session-test-pause-${schema}`;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let acquired!: () => void;
    const ready = new Promise<void>((resolve) => { acquired = resolve; });
    let held: Promise<unknown> | undefined;
    let first: Promise<void> | undefined;
    let second: Promise<void> | undefined;
    try {
      await store.getBuffer(scope);
      await sql.unsafe(`CREATE FUNCTION "${schema}".pause_scope() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.scope_key = '${scopeToKey(scope)}' THEN PERFORM pg_advisory_xact_lock(hashtextextended('${lockName}',0)); END IF; RETURN NEW; END $$`);
      await sql.unsafe(`CREATE TRIGGER pause_scope BEFORE INSERT ON "${schema}".gm_session_state FOR EACH ROW EXECUTE FUNCTION "${schema}".pause_scope()`);
      held = sql.begin(async (tx) => {
        await tx.unsafe("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [lockName]);
        acquired();
        await gate;
      });
      await ready;
      first = store.saveBuffer(scope, values.buffer);
      let waiting = false;
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline && !waiting) {
        const rows = await sql.unsafe<Array<{ waiting: boolean }>>(
          "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event = 'advisory' AND query LIKE $1) AS waiting",
          [`%INSERT INTO "${schema}"%`],
        );
        waiting = rows[0]?.waiting === true;
        if (!waiting) await Bun.sleep(10);
      }
      expect(waiting).toBe(true);
      second = store.saveBuffer({ ...scope, userId: "independent-user" }, values.buffer);
      expect(await Promise.race([second.then(() => true), Bun.sleep(1_000).then(() => false)])).toBe(true);
    } finally {
      release();
      await Promise.allSettled([held, first, second].filter((value) => value !== undefined));
      try { await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await sql.close(); }
    }
  });
});
