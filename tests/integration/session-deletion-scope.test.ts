import { SQL } from "bun";
import { describe, expect, it } from "bun:test";
import type { MemoryScope } from "../../src/domain/scope";
import type { SessionStore } from "../../src/storage/contracts";
import { createInMemorySessionStore } from "../../src/storage/memory";
import { createPostgresSessionStore } from "../../src/storage/postgres";
import { createSQLiteSessionStore } from "../../src/storage/sqlite";

interface StoreFixture {
  store: SessionStore;
  cleanup?: () => Promise<void>;
}

interface DeletionCase {
  name: string;
  scope: MemoryScope;
  deleted: MemoryScope[];
  preserved: MemoryScope[];
}

const BASE_SCOPE: MemoryScope = {
  userId: "user-1",
  tenantId: "tenant-1",
  workspaceId: "workspace-1",
  agentId: "agent-1",
};
const TIMESTAMP = "2026-01-01T00:00:00.000Z";
const STATE_KINDS = ["buffer", "workingMemory", "journal"] as const;

function sessionStates(store: SessionStore, scope: MemoryScope) {
  const identity = { userId: scope.userId, sessionId: scope.sessionId ?? "" };
  return {
    buffer: {
      save: () => store.saveBuffer(scope, {
        ...identity,
        messages: [],
        summary: "preserve this buffer",
        summaryUpToIndex: 0,
        createdAt: TIMESTAMP,
        lastActiveAt: TIMESTAMP,
      }),
      get: () => store.getBuffer(scope),
      delete: () => store.deleteBuffersByScope(scope),
    },
    workingMemory: {
      save: () => store.saveWorkingMemory(scope, {
        ...identity,
        currentGoal: "preserve this working memory",
        openLoops: [],
        updatedAt: TIMESTAMP,
      }),
      get: () => store.getWorkingMemory(scope),
      delete: () => store.deleteWorkingMemoryByScope(scope),
    },
    journal: {
      save: () => store.saveJournal(scope, {
        ...identity,
        worklog: ["preserve this journal"],
        updatedAt: TIMESTAMP,
      }),
      get: () => store.getJournal(scope),
      delete: () => store.deleteJournalsByScope(scope),
    },
  };
}

const deletionCases: DeletionCase[] = [
  {
    name: "deletes only the exact session, preserving longer and case-variant IDs",
    scope: { ...BASE_SCOPE, sessionId: "s-1" },
    deleted: [{ ...BASE_SCOPE, sessionId: "s-1" }],
    preserved: [
      { ...BASE_SCOPE, sessionId: "s-10" },
      { ...BASE_SCOPE, sessionId: "s-1-child" },
      { ...BASE_SCOPE, sessionId: "S-1" },
      { ...BASE_SCOPE, userId: "other-user", sessionId: "s-1" },
      BASE_SCOPE,
    ],
  },
  {
    name: "does not delete a longer session when the requested session is absent",
    scope: { ...BASE_SCOPE, sessionId: "s-1" },
    deleted: [],
    preserved: [{ ...BASE_SCOPE, sessionId: "s-10" }],
  },
  ...["", "   "].map((sessionId): DeletionCase => ({
    name: `keeps explicitly ${sessionId === "" ? "empty" : "blank"} session deletion exact`,
    scope: { ...BASE_SCOPE, sessionId },
    deleted: [BASE_SCOPE],
    preserved: [{ ...BASE_SCOPE, sessionId: "s-1" }],
  })),
  {
    name: "deletes all sessions in the exact durable scope, including sessionless state",
    scope: BASE_SCOPE,
    deleted: [
      BASE_SCOPE,
      { ...BASE_SCOPE, sessionId: "s-1" },
      { ...BASE_SCOPE, sessionId: "s-10" },
    ],
    preserved: [
      { ...BASE_SCOPE, userId: "user-10", sessionId: "s-1" },
      { ...BASE_SCOPE, tenantId: "tenant-10", sessionId: "s-1" },
      { ...BASE_SCOPE, workspaceId: "workspace-10", sessionId: "s-1" },
      { ...BASE_SCOPE, agentId: "agent-10", sessionId: "s-1" },
      { userId: BASE_SCOPE.userId, sessionId: "s-1" },
    ],
  },
];

for (const field of ["userId", "tenantId", "workspaceId", "agentId"] as const) {
  for (const { name, value, neighbor } of [
    { name: "percent", value: "scope%id", neighbor: "scope-other-id" },
    { name: "underscore", value: "scope_id", neighbor: "scopeXid" },
    { name: "backslash", value: "scope\\id", neighbor: "scopeid" },
    { name: "case", value: "ScopeID", neighbor: "scopeid" },
    { name: "Unicode", value: "scope-\u{1F9E0}-\u00E9", neighbor: "scope-\u{1F9E0}-\u00C9" },
  ]) {
    const scope = { ...BASE_SCOPE, [field]: value };
    deletionCases.push({
      name: `matches ${field} literally and case-sensitively (${name})`,
      scope,
      deleted: [scope, { ...scope, sessionId: "s-1" }, { ...scope, sessionId: "s-10" }],
      preserved: [
        { ...BASE_SCOPE, [field]: neighbor, sessionId: "s-1" },
        { ...BASE_SCOPE, [field]: `${value}-suffix`, sessionId: "s-1" },
      ],
    });
  }
}

function runDeletionContract(
  adapter: string,
  createStore: () => StoreFixture | Promise<StoreFixture>,
  available = true,
) {
  const suite = available ? describe : describe.skip;
  suite(`${adapter} session deletion isolation`, () => {
    for (const kind of STATE_KINDS) {
      for (const testCase of deletionCases) {
        it(`${kind}: ${testCase.name}`, async () => {
          const fixture = await createStore();
          const entries = [
            ...testCase.deleted.map((scope) => ({ scope, deleted: true })),
            ...testCase.preserved.map((scope) => ({ scope, deleted: false })),
          ];
          try {
            const originals = [];
            for (const entry of entries) {
              const states = sessionStates(fixture.store, entry.scope);
              for (const state of Object.values(states)) {
                await state.save();
              }
              originals.push(await Promise.all(STATE_KINDS.map((name) => states[name].get())));
            }

            const deletion = sessionStates(fixture.store, testCase.scope)[kind];
            expect(await deletion.delete()).toBe(testCase.deleted.length);
            expect(await deletion.delete()).toBe(0);

            for (const [index, entry] of entries.entries()) {
              const states = sessionStates(fixture.store, entry.scope);
              for (const [stateIndex, name] of STATE_KINDS.entries()) {
                const expected = entry.deleted && name === kind
                  ? null
                  : originals[index]![stateIndex];
                expect(await states[name].get()).toEqual(expected);
              }
            }
          } finally {
            await fixture.cleanup?.();
          }
        });
      }
    }
  });
}

runDeletionContract("in-memory", () => ({ store: createInMemorySessionStore() }));
runDeletionContract("SQLite", () => ({ store: createSQLiteSessionStore(":memory:") }));

const POSTGRES_URL = process.env.GOODMEMORY_TEST_POSTGRES_URL;
runDeletionContract("PostgreSQL (requires GOODMEMORY_TEST_POSTGRES_URL)", () => {
  if (!POSTGRES_URL) {
    throw new Error("GOODMEMORY_TEST_POSTGRES_URL is required");
  }
  const schema = `gm_test_session_delete_${crypto.randomUUID().replaceAll("-", "")}`;
  return {
    store: createPostgresSessionStore({ url: POSTGRES_URL, schema }),
    async cleanup() {
      const sql = new SQL(POSTGRES_URL);
      try {
        await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await sql.close();
      }
    },
  };
}, Boolean(POSTGRES_URL));
