import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGoodMemory } from "../../src";
import { createFactMemory, type FactMemory } from "../../src/domain/records";
import { normalizeScope, scopeToKey, type MemoryScope } from "../../src/domain/scope";
import { findAdminScope, listAdminScopes } from "../../src/inspector/adminMemory";
import {
  buildReviewCandidateId,
  listReviewCandidates,
  persistReviewCandidates,
  readReviewQueue,
  reserveReviewCandidateApproval,
  writeReviewQueue,
  type InspectorReviewCandidate,
  type NewReviewCandidate,
} from "../../src/install/hostReviewQueue";
import {
  PROJECTION_SEARCH_SCHEMA_VERSION,
  RECALL_PROJECTION_PIPELINE_VERSION,
  SCOPE_CATALOG_COLLECTION,
} from "../../src/recall/projections/contracts";
import { createInMemoryDocumentStore, createInMemorySessionStore } from "../../src/storage/memory";
import { createSQLiteDocumentStore } from "../../src/storage/sqlite";
import type { StorageDocument } from "../../src/storage/contracts";

const NOW = "2026-09-30T00:00:00.000Z";
const now = () => new Date(NOW);
const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))); });

function legacyKey(scope: MemoryScope): string {
  const value = normalizeScope(scope);
  return [value.userId, value.tenantId, value.workspaceId, value.agentId, value.sessionId].map((part) => part ?? "").join("::");
}
function newKey(scope: MemoryScope): string {
  const value = normalizeScope(scope);
  return `gm2:${[value.userId, value.tenantId, value.workspaceId, value.agentId, value.sessionId].map((part) => Buffer.from(JSON.stringify(part ?? null)).toString("base64url")).join(":")}`;
}
function candidate(scope: MemoryScope): NewReviewCandidate {
  return { host: "claude", scope, candidateKey: "known-candidate", kind: "fact", content: "The project uses TypeScript.", reason: "explicit fact", source: "user", confidence: 0.9 };
}
function legacyCandidate(scope: MemoryScope, status: InspectorReviewCandidate["status"]): InspectorReviewCandidate {
  const input = candidate(scope);
  return { ...input, id: `rc_${createHash("sha256").update(`${legacyKey(scope)}\n${input.candidateKey}`).digest("hex").slice(0, 20)}`, scopeKey: legacyKey(scope), status, createdAt: NOW, updatedAt: NOW, ...(status === "approved" ? { memoryIds: ["already-approved"] } : {}) };
}

async function homeRoot(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "gm-key-review-"));
  homes.push(home);
  return home;
}

describe("persisted scope identity migration", () => {
  it.each(["approved", "rejected", "approving", "released", "pending"] as const)("preserves legacy %s review candidate identity and retry state", async (status) => {
    const home = await homeRoot();
    const scope = { userId: "user", workspaceId: "project::special", sessionId: "s1" };
    const stored = legacyCandidate(scope, status);
    await writeReviewQueue(home, { version: 1, candidates: [stored] });
    const result = await persistReviewCandidates({ homeRoot: home, now, candidates: [candidate(scope)] });
    expect(result.persisted).toBe(0);
    const queue = await readReviewQueue(home);
    expect(queue.candidates).toHaveLength(1);
    expect(queue.candidates[0]).toMatchObject({ id: stored.id, status, scopeKey: newKey(scope) });
    expect(queue.candidates[0]?.memoryIds).toEqual(stored.memoryIds);
    expect(await listReviewCandidates({ homeRoot: home, scopeKey: newKey(scope) })).toHaveLength(1);
  });

  it("does not borrow a legacy candidate from a colliding full scope", async () => {
    const home = await homeRoot();
    const left = { userId: "user::tenant", tenantId: "team" };
    const right = { userId: "user", tenantId: "tenant::team" };
    expect(legacyKey(left)).toBe(legacyKey(right));
    const stored = legacyCandidate(left, "rejected");
    await writeReviewQueue(home, { version: 1, candidates: [stored] });
    expect((await persistReviewCandidates({ homeRoot: home, now, candidates: [candidate(right)] })).persisted).toBe(1);
    const queue = await readReviewQueue(home);
    expect(queue.candidates).toHaveLength(2);
    expect(queue.candidates.find((entry) => entry.id === stored.id)?.status).toBe("rejected");
    expect(queue.candidates.find((entry) => entry.id === buildReviewCandidateId({ scope: right, candidateKey: "known-candidate" }))?.scope.userId).toBe("user");
  });

  it("reserves a legacy pending candidate only for its canonical full scope", async () => {
    const home = await homeRoot();
    const scope = { userId: "user", workspaceId: "project::special", sessionId: "s1" };
    const stored = legacyCandidate(scope, "pending");
    await writeReviewQueue(home, { version: 1, candidates: [stored] });
    expect((await reserveReviewCandidateApproval({ homeRoot: home, id: stored.id, now, scopeKey: newKey({ ...scope, sessionId: "s2" }) })).status).toBe("scope_mismatch");
    expect((await reserveReviewCandidateApproval({ homeRoot: home, id: stored.id, now, scopeKey: newKey(scope) })).status).toBe("reserved");
  });

  it("rebuilds a stale inspector catalog sentinel without legacy duplicates", async () => {
    const store = createInMemoryDocumentStore();
    const scopes = [{ userId: "user::tenant", tenantId: "team" }, { userId: "user", tenantId: "tenant::team" }];
    for (const [index, scope] of scopes.entries()) await store.set("facts", `fact-${index}`, { ...scope, id: `fact-${index}`, content: "A scoped fact", createdAt: NOW });
    const oldId = `scope:${legacyKey(scopes[0]!)}`;
    await store.set(SCOPE_CATALOG_COLLECTION, oldId, { ...scopes[0], id: oldId, scopeKey: legacyKey(scopes[0]!), coverage: "complete", analyzerFingerprint: "legacy", schemaVersion: 2, projectionVersion: RECALL_PROJECTION_PIPELINE_VERSION, searchSchemaVersion: PROJECTION_SEARCH_SCHEMA_VERSION, firstSeenAt: NOW, lastSeenAt: NOW });
    await store.set(SCOPE_CATALOG_COLLECTION, "migration:durable-v1", { id: "migration:durable-v1", schemaVersion: 1, completedAt: NOW });
    const first = await listAdminScopes({ documentStore: store, limit: 1, now });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeDefined();
    const second = await listAdminScopes({ documentStore: store, limit: 1, cursor: first.nextCursor, now });
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeUndefined();
    const all = [...first.items, ...second.items];
    expect(new Set(all.map((item) => item.scopeKey))).toEqual(new Set(scopes.map(newKey)));
    expect(all.every((item) => item.totalRecords === 1 && item.coverage === "partial")).toBe(true);
    expect((await listAdminScopes({ documentStore: store, limit: 10, now })).items).toHaveLength(2);
    for (const scope of scopes) expect((await findAdminScope({ documentStore: store, scopeKey: newKey(scope), now }))?.scopeKey).toBe(newKey(scope));
  });

  it("isolates observation IDs for missing dimensions and colon-bearing scopes", async () => {
    const store = createInMemoryDocumentStore();
    const scopes: MemoryScope[] = [{ userId: "u", tenantId: "team" }, { userId: "u", workspaceId: "team" }, { userId: "u:team" }, { userId: "u" }];
    const memory = createGoodMemory({ storage: { provider: "memory" }, adapters: { documentStore: store, sessionStore: createInMemorySessionStore(), observationSynthesizer: { async synthesize(input) { return input.contents.join("; "); } } } });
    for (const [index, scope] of scopes.entries()) for (let member = 0; member < 4; member++) {
      const fact = createFactMemory({ ...scope, id: `member-${index}-${member}`, subject: "project", category: "work", content: `Scope ${index} detail ${member}`, confidence: 0.9, importance: 0.6, source: { method: "explicit", extractedAt: NOW } });
      await store.set("facts", fact.id, fact);
    }
    for (const scope of scopes) await memory.runMaintenance({ scope, jobs: ["observationSynthesis"] });
    const observations = (await store.query<FactMemory>("facts")).filter((fact) => fact.attributes?.observationOf === "project");
    expect(observations).toHaveLength(4);
    expect(new Set(observations.map((fact) => fact.id)).size).toBe(4);
    for (const [index, scope] of scopes.entries()) {
      const observation = observations.find((fact) => scopeToKey(fact) === scopeToKey(scope));
      expect(observation?.attributes?.observationMemberIds).toBe([0, 1, 2, 3].map((member) => `member-${index}-${member}`).join("\n"));
    }
  });

  it("regenerates unsupported legacy observations from live members without retiring another scope", async () => {
    const store = createInMemoryDocumentStore();
    const scope = { userId: "observer", workspaceId: "project" };
    const memory = createGoodMemory({ storage: { provider: "memory" }, adapters: { documentStore: store, sessionStore: createInMemorySessionStore(), observationSynthesizer: { async synthesize() { return "Updated observation."; } } } });
    for (let index = 0; index < 4; index++) {
      const fact = createFactMemory({ ...scope, id: `member-${index}`, subject: "project", category: "work", content: `Detail ${index}`, confidence: 0.9, importance: 0.6, source: { method: "explicit", extractedAt: NOW } });
      await store.set("facts", fact.id, fact);
    }
    const old = createFactMemory({ ...scope, id: "observation:observer:project:project", subject: "project", category: "work", content: "Original observation.", confidence: 0.7, importance: 0.7, source: { method: "inferred", extractedAt: NOW }, attributes: { observationOf: "project", observationMemberIds: "member-0\nmember-1\nmember-2\nmember-3" } });
    const foreign = { ...old, id: "foreign-observation", workspaceId: "another-project" };
    await store.set("facts", old.id, old);
    await store.set("facts", foreign.id, foreign);
    expect(await store.get("facts", old.id)).toEqual(old);
    const first = await memory.runMaintenance({ scope, jobs: ["observationSynthesis"] });
    expect(first.maintenance?.jobs[0]?.applied).toBe(1);
    const retired = await store.get<FactMemory>("facts", old.id);
    expect(retired).toMatchObject({ content: old.content, lifecycle: "inactive", isActive: false });
    expect(await store.get("facts", foreign.id)).toEqual(foreign);
    const firstActive = (await store.query<FactMemory>("facts")).filter((fact) => scopeToKey(fact) === scopeToKey(scope) && fact.attributes?.observationOf === "project" && fact.lifecycle === "active");
    expect(firstActive).toHaveLength(1);
    expect(firstActive[0]?.attributes?.observationSupportV1).toEqual(expect.any(String));
    expect((await memory.runMaintenance({ scope, jobs: ["observationSynthesis"] })).maintenance?.jobs[0]?.applied).toBe(0);
    const extra = createFactMemory({ ...scope, id: "member-4", subject: "project", category: "work", content: "New detail", confidence: 0.9, importance: 0.6, source: { method: "explicit", extractedAt: NOW } });
    await store.set("facts", extra.id, extra);
    expect((await memory.runMaintenance({ scope, jobs: ["observationSynthesis"] })).maintenance?.jobs[0]?.applied).toBe(1);
    expect(await store.get("facts", old.id)).toEqual(retired);
    expect(await store.get("facts", foreign.id)).toEqual(foreign);
    const active = (await store.query<FactMemory>("facts")).filter((fact) => scopeToKey(fact) === scopeToKey(scope) && fact.attributes?.observationOf === "project" && fact.lifecycle === "active");
    expect(active).toHaveLength(1);
    expect(active[0]?.id.startsWith("observation_v2:")).toBe(true);
    expect(active[0]?.id).toBe(firstActive[0]?.id);
    expect(active[0]?.attributes?.observationMemberIds).toContain("member-4");
  });

  it("does not overwrite a foreign observation at the derived target ID", async () => {
    const store = createInMemoryDocumentStore();
    const scope = { userId: "observer" };
    const memory = createGoodMemory({ storage: { provider: "memory" }, adapters: { documentStore: store, sessionStore: createInMemorySessionStore(), observationSynthesizer: { async synthesize() { return "New observation."; } } } });
    for (let index = 0; index < 4; index++) {
      const fact = createFactMemory({ ...scope, id: `member-${index}`, subject: "project", category: "work", content: `Detail ${index}`, confidence: 0.9, importance: 0.6, source: { method: "explicit", extractedAt: NOW } });
      await store.set("facts", fact.id, fact);
    }
    const foreign = createFactMemory({ userId: "someone-else", id: `observation_v2:${newKey(scope)}:project`, subject: "project", category: "work", content: "Foreign observation.", confidence: 0.7, importance: 0.7, source: { method: "inferred", extractedAt: NOW }, attributes: { observationOf: "project", observationMemberIds: "other-fact" } });
    await store.set("facts", foreign.id, foreign);
    await expect(memory.runMaintenance({ scope, jobs: ["observationSynthesis"] })).rejects.toThrow("scope");
    expect(await store.get("facts", foreign.id)).toEqual(foreign);
  });


  it("preserves legacy catalog-only full scopes as partial without trusting old completion", async () => {
    const store = createInMemoryDocumentStore();
    const scope = { userId: "catalog-only", workspaceId: "project::a" };
    const id = `scope:${legacyKey(scope)}`;
    await store.set(SCOPE_CATALOG_COLLECTION, id, { ...scope, id, scopeKey: legacyKey(scope), coverage: "complete", analyzerFingerprint: "legacy", schemaVersion: 2, projectionVersion: RECALL_PROJECTION_PIPELINE_VERSION, searchSchemaVersion: PROJECTION_SEARCH_SCHEMA_VERSION, firstSeenAt: NOW, lastSeenAt: NOW });
    const listed = await listAdminScopes({ documentStore: store, limit: 10, now });
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({ scopeKey: newKey(scope), totalRecords: 0, coverage: "partial" });
    expect(await store.get(SCOPE_CATALOG_COLLECTION, id)).toMatchObject({ scopeKey: legacyKey(scope) });
  });

  it("does not mark a failed canonical scan migrated and retries after recovery", async () => {
    const store = createInMemoryDocumentStore();
    const scope = { userId: "missing-during-failure" };
    await store.set("notes", "one-note", { ...scope, id: "one-note", title: "A note" });
    let fail = true;
    const flaky = { ...store, async query<T extends StorageDocument>(collection: string, filter?: Parameters<typeof store.query>[1]) {
      if (fail && collection === "notes") throw new Error("canonical scan unavailable");
      return store.query<T>(collection, filter);
    } };
    await expect(listAdminScopes({ documentStore: flaky, limit: 10, now })).rejects.toThrow("canonical scan unavailable");
    expect(await store.get(SCOPE_CATALOG_COLLECTION, "migration:durable-scope-key-v2")).toBeNull();
    fail = false;
    expect((await listAdminScopes({ documentStore: flaky, limit: 10, now })).items.map((item) => item.scopeKey)).toEqual([newKey(scope)]);
  });


  it.each(["memory", "sqlite", "unpaged"] as const)("paginates v2 catalog keys without skips (%s)", async (backend) => {
    const store = backend === "sqlite"
      ? createSQLiteDocumentStore(join(await homeRoot(), "catalog.sqlite"))
      : createInMemoryDocumentStore();
    const documentStore = backend === "unpaged" ? { ...store, queryPage: undefined } : store;
    for (const userId of ["a", "g"]) await documentStore.set("facts", userId, { userId, id: userId, content: "A fact" });
    const first = await listAdminScopes({ documentStore, limit: 1, now });
    expect(first.nextCursor).toBeDefined();
    const second = await listAdminScopes({ documentStore, limit: 1, cursor: first.nextCursor, now });
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeUndefined();
    expect(new Set([...first.items, ...second.items].map((item) => item.scope.userId))).toEqual(new Set(["a", "g"]));
  });


  it.each(["memory", "sqlite"] as const)("skips more than one storage page of legacy catalogs without hiding v2 scopes (%s)", async (backend) => {
    const store = backend === "sqlite"
      ? createSQLiteDocumentStore(join(await homeRoot(), "large-catalog.sqlite"))
      : createInMemoryDocumentStore();
    const projection = (scope: MemoryScope, key: string) => ({ ...scope, id: `scope:${key}`, scopeKey: key, coverage: "partial", analyzerFingerprint: null, schemaVersion: 2, projectionVersion: RECALL_PROJECTION_PIPELINE_VERSION, searchSchemaVersion: PROJECTION_SEARCH_SCHEMA_VERSION, firstSeenAt: NOW, lastSeenAt: NOW });
    for (let index = 0; index < 205; index++) {
      const scope = { userId: `00-old-${index.toString().padStart(3, "0")}` };
      const old = projection(scope, legacyKey(scope));
      await store.set(SCOPE_CATALOG_COLLECTION, old.id, old);
    }
    for (const userId of ["a", "g", "scope::colon", "用户"]) {
      const scope = { userId };
      for (const key of [legacyKey(scope), newKey(scope)]) {
        const catalog = projection(scope, key);
        await store.set(SCOPE_CATALOG_COLLECTION, catalog.id, catalog);
      }
    }
    await store.set(SCOPE_CATALOG_COLLECTION, "migration:durable-scope-key-v2", { id: "migration:durable-scope-key-v2", completedAt: NOW });
    const users: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const result = await listAdminScopes({ documentStore: store, limit: 1, cursor, now });
      users.push(...result.items.map((item) => item.scope.userId));
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    expect(cursor).toBeUndefined();
    expect(users).toHaveLength(4);
    expect(new Set(users)).toEqual(new Set(["a", "g", "scope::colon", "用户"]));
  });

});
