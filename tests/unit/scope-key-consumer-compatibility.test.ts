import { createHash } from "node:crypto";
import { describe, expect, it } from "bun:test";
import type { MemoryScope } from "../../src/domain/scope";
import { scopeToKey } from "../../src/domain/scope";
import { createExtractionCursorStore, EXTRACTION_CURSORS_COLLECTION, type ExtractionCursor } from "../../src/remember/extractionCursor";
import { createArtifactSpilloverService, ARTIFACT_SPILL_COLLECTION, ARTIFACT_SPILL_PAYLOAD_COLLECTION } from "../../src/runtime/spillover";
import { createInMemoryDocumentStore } from "../../src/storage/memory";
import { createScopeDeletionAwareDocumentStore, createScopeDeletionCoordinator, SCOPE_DELETION_LOCKS_COLLECTION, SCOPE_MUTATION_BARRIERS_COLLECTION } from "../../src/storage/scopeDeletion";

const fullScope = { userId: "user", tenantId: "tenant", workspaceId: "workspace", agentId: "agent", sessionId: "session" };
const collisionA = { ...fullScope, userId: "one::two", tenantId: "three" };
const collisionB = { ...fullScope, userId: "one", tenantId: "two::three" };
const legacyKey = (scope: MemoryScope) => [scope.userId, scope.tenantId ?? "", scope.workspaceId ?? "", scope.agentId ?? "", scope.sessionId ?? ""].join("::");
const cursorId = (scopeKey: string, sourceId: string) => createHash("sha256").update(scopeKey).update("\0").update(sourceId).digest("hex");
const now = () => "2026-09-30T00:00:00.000Z";

function legacyCursor(scope: MemoryScope): ExtractionCursor {
  const scopeKey = legacyKey(scope);
  return { id: cursorId(scopeKey, "source"), scopeKey, sourceId: "source", schemaVersion: 1, committedThrough: 10, lastAttempt: { attempts: 1, outcome: "committed", through: 10, updatedAt: now() } };
}

async function seedLegacySpill(store: ReturnType<typeof createInMemoryDocumentStore>, scope: MemoryScope) {
  const content = "legacy private content";
  const contentHash = createHash("sha256").update(content).digest("hex");
  const payloadId = `${legacyKey(scope)}::${contentHash}`;
  const record = { id: `${legacyKey(scope)}::source`, scope, kind: "tool_result" as const, sourceId: "source", contentHash, preview: content, replacementText: "[[spill:legacy]]", originalBytes: content.length, createdAt: now(), storageUri: `memory://artifact-spill-payloads/${encodeURIComponent(payloadId)}` };
  await store.set(ARTIFACT_SPILL_COLLECTION, record.id, record);
  await store.set(ARTIFACT_SPILL_PAYLOAD_COLLECTION, payloadId, { id: payloadId, scope, contentHash, content, originalBytes: content.length, createdAt: now() });
  return record;
}

async function seedLegacyJournal(store: ReturnType<typeof createInMemoryDocumentStore>, scope: MemoryScope, withScope = true) {
  const id = legacyKey(scope);
  const lock = { ...(withScope ? scope : {}), id, epoch: 2, generation: "legacy-generation", operationId: "legacy-op", operationKey: `scope-deletion:v1:${id}`, ownerId: "stopped-runtime", phase: "delete_all" as const, state: "failed" as const };
  const barrier = { ...lock, id: legacyKey({ userId: scope.userId }) };
  await store.set(SCOPE_DELETION_LOCKS_COLLECTION, id, lock);
  await store.set(SCOPE_MUTATION_BARRIERS_COLLECTION, barrier.id, barrier);
  return { lock, barrier };
}

describe("persisted scope key consumer compatibility", () => {
  it("keeps new extraction offsets independent for old delimiter collisions", async () => {
    const cursors = createExtractionCursorStore({ documentStore: createInMemoryDocumentStore(), now });
    await cursors.record({ scope: collisionA, sourceId: "source", through: 10, outcome: "committed" });
    expect(await cursors.get(collisionB, "source")).toBeNull();
  });

  it("reads a provably owned legacy cursor and preserves it when writing a new key", async () => {
    const store = createInMemoryDocumentStore();
    const legacy = legacyCursor(fullScope);
    await store.set(EXTRACTION_CURSORS_COLLECTION, legacy.id, legacy);
    const cursors = createExtractionCursorStore({ documentStore: store, now });
    expect((await cursors.get(fullScope, "source"))?.committedThrough).toBe(10);
    const next = await cursors.record({ scope: fullScope, sourceId: "source", through: 20, outcome: "failed" });
    expect(next.committedThrough).toBe(10);
    expect(next.scopeKey).toBe(scopeToKey(fullScope));
    expect(next.id).not.toBe(legacy.id);
    expect(await store.get(EXTRACTION_CURSORS_COLLECTION, legacy.id)).toEqual(legacy);
  });

  it("rejects an ambiguous legacy cursor without consuming or overwriting it", async () => {
    const store = createInMemoryDocumentStore();
    const legacy = legacyCursor(collisionA);
    await store.set(EXTRACTION_CURSORS_COLLECTION, legacy.id, legacy);
    const cursors = createExtractionCursorStore({ documentStore: store, now });
    await expect(cursors.get(collisionB, "source")).rejects.toMatchObject({ code: "GOODMEMORY_LEGACY_SCOPE_AMBIGUOUS" });
    await expect(cursors.record({ scope: collisionB, sourceId: "source", through: 20, outcome: "committed" })).rejects.toMatchObject({ code: "GOODMEMORY_LEGACY_SCOPE_AMBIGUOUS" });
    expect(await store.get(EXTRACTION_CURSORS_COLLECTION, legacy.id)).toEqual(legacy);
  });

  it("validates legacy cursor identity before using the offset", async () => {
    const store = createInMemoryDocumentStore();
    const legacy = { ...legacyCursor(fullScope), sourceId: "other-source" };
    await store.set(EXTRACTION_CURSORS_COLLECTION, legacy.id, legacy);
    const cursors = createExtractionCursorStore({ documentStore: store, now });
    await expect(cursors.get(fullScope, "source")).rejects.toMatchObject({ code: "GOODMEMORY_LEGACY_SCOPE_AMBIGUOUS" });
  });

  it("reads legacy spill pointers and payloads only for the exact payload owner", async () => {
    const store = createInMemoryDocumentStore();
    const legacy = await seedLegacySpill(store, collisionA);
    const service = createArtifactSpilloverService({ documentStore: store });
    expect(await service.getBySource(collisionA, "source")).toEqual(legacy);
    expect(await service.resolve(collisionA, legacy.storageUri)).toBe("legacy private content");
    expect(await service.resolve(collisionA, legacy)).toBe("legacy private content");
    expect(await service.getBySource(collisionB, "source")).toBeNull();
    expect(await service.resolve(collisionB, legacy.storageUri)).toBeNull();
    expect(await service.resolve(collisionB, legacy)).toBeNull();
  });

  it("retains legacy spill bytes when publishing a new versioned pointer", async () => {
    const store = createInMemoryDocumentStore();
    const legacy = await seedLegacySpill(store, collisionA);
    const service = createArtifactSpilloverService({ documentStore: store });
    const next = await service.spill(collisionA, { sourceId: "source", kind: "tool_result", content: "updated content" });
    expect(next.id).not.toBe(legacy.id);
    expect(next.replacementText).toBe(legacy.replacementText);
    expect(await store.get(ARTIFACT_SPILL_COLLECTION, legacy.id)).toEqual(legacy);
    expect(await service.resolve(collisionA, legacy.storageUri)).toBe("legacy private content");
  });

  it("validates new spill payload scope even if its key and hash match", async () => {
    const store = createInMemoryDocumentStore();
    const service = createArtifactSpilloverService({ documentStore: store });
    const record = await service.spill(fullScope, { sourceId: "source", kind: "tool_result", content: "payload" });
    const [payload] = await store.query<Record<string, unknown>>(ARTIFACT_SPILL_PAYLOAD_COLLECTION);
    await store.set(ARTIFACT_SPILL_PAYLOAD_COLLECTION, payload!.id as string, { ...payload, scope: collisionB });
    expect(await service.resolve(fullScope, record.storageUri)).toBeNull();
  });

  it("keeps owned legacy locks fencing direct guarded sets and batches", async () => {
    const store = createInMemoryDocumentStore();
    const journal = await seedLegacyJournal(store, collisionA);
    const guarded = createScopeDeletionAwareDocumentStore(store);
    const document = { id: "memory", ...collisionA, content: "late write" };
    await expect(guarded.set("facts", "memory", document)).rejects.toThrow("deletion");
    await expect(guarded.writeBatchIfUnchanged({ expected: { collection: "facts", id: "memory", document: null }, set: [{ collection: "facts", id: "memory", document }] })).rejects.toThrow("deletion");
    expect(await store.get(SCOPE_DELETION_LOCKS_COLLECTION, journal.lock.id)).toEqual(journal.lock);
    await expect(guarded.set("facts", "other", { id: "other", ...collisionB })).resolves.toBeUndefined();
  });

  it("keeps an orphaned legacy barrier fencing coordinator and direct writes", async () => {
    const store = createInMemoryDocumentStore();
    const journal = await seedLegacyJournal(store, fullScope);
    await store.delete(SCOPE_DELETION_LOCKS_COLLECTION, journal.lock.id);
    await expect(createScopeDeletionCoordinator(store).runMutation(fullScope, async () => "unsafe")).rejects.toThrow("deletion");
    await expect(createScopeDeletionAwareDocumentStore(store).set("facts", "memory", { id: "memory", ...fullScope })).rejects.toThrow("deletion");
  });

  it("rejects ambiguous key-only legacy fences without rewriting them", async () => {
    const store = createInMemoryDocumentStore();
    const journal = await seedLegacyJournal(store, collisionA, false);
    await expect(createScopeDeletionAwareDocumentStore(store).set("facts", "memory", { id: "memory", ...collisionB })).rejects.toMatchObject({ code: "GOODMEMORY_LEGACY_SCOPE_AMBIGUOUS" });
    await expect(createScopeDeletionCoordinator(store).runExclusive(collisionB, async () => "unsafe", { resumeInterrupted: { confirmPriorRuntimesStopped: true } })).rejects.toMatchObject({ code: "GOODMEMORY_LEGACY_SCOPE_AMBIGUOUS" });
    expect(await store.get(SCOPE_DELETION_LOCKS_COLLECTION, journal.lock.id)).toEqual(journal.lock);
  });

  it("resumes an explicitly scoped interrupted legacy journal at its existing IDs", async () => {
    const store = createInMemoryDocumentStore();
    const journal = await seedLegacyJournal(store, collisionA);
    let entered = false;
    await expect(createScopeDeletionCoordinator(store).runExclusive(collisionA, async () => { entered = true; return "recovered"; }, { resumeInterrupted: { confirmPriorRuntimesStopped: true } })).resolves.toBe("recovered");
    expect(entered).toBe(true);
    expect(await store.get(SCOPE_DELETION_LOCKS_COLLECTION, journal.lock.id)).toMatchObject({ state: "open" });
    expect(await store.get(SCOPE_MUTATION_BARRIERS_COLLECTION, journal.barrier.id)).toMatchObject({ state: "open" });
    await expect(createScopeDeletionCoordinator(store).runMutation(collisionA, async () => "safe")).resolves.toBe("safe");
  });
});

describe("cross-version scope-key adversarial cases", () => {
  it("uses a disjoint pointer namespace when old source delimiters would collide", async () => {
    const store = createInMemoryDocumentStore();
    const scope = fullScope;
    const legacyOwner = { userId: scopeToKey(scope) };
    const legacy = await seedLegacySpill(store, legacyOwner);
    const collidingSourceId = "::::::::source";
    expect(`${scopeToKey(scope)}::${collidingSourceId}`).toBe(legacy.id);
    const service = createArtifactSpilloverService({ documentStore: store });
    expect(await service.getBySource(scope, collidingSourceId)).toBeNull();
    const next = await service.spill(scope, { sourceId: collidingSourceId, kind: "tool_result", content: "new owner's content" });
    expect(next.id).not.toContain("::");
    expect(next.id).not.toBe(legacy.id);
    expect(await service.resolve(scope, next.storageUri)).toBe("new owner's content");
    expect(await store.get(ARTIFACT_SPILL_COLLECTION, legacy.id)).toEqual(legacy);
  });

  it("rejects legacy fences whose payload scope does not match their persisted key", async () => {
    const store = createInMemoryDocumentStore();
    const journal = await seedLegacyJournal(store, fullScope);
    await store.set(SCOPE_DELETION_LOCKS_COLLECTION, journal.lock.id, { ...journal.lock, sessionId: "different-session" });
    await expect(createScopeDeletionCoordinator(store).runMutation(fullScope, async () => "unsafe")).rejects.toMatchObject({ code: "GOODMEMORY_LEGACY_SCOPE_AMBIGUOUS" });
  });

  it("does not treat a malformed user-wide lock as a tenant-scoped barrier", async () => {
    const store = createInMemoryDocumentStore();
    const id = legacyKey({ userId: fullScope.userId });
    await store.set(SCOPE_DELETION_LOCKS_COLLECTION, id, {
      id, ...fullScope, state: "failed",
    });
    const other = { ...fullScope, tenantId: "another-tenant" };
    await expect(createScopeDeletionAwareDocumentStore(store).set(
      "facts", "memory", { id: "memory", ...other },
    )).rejects.toMatchObject({ code: "GOODMEMORY_LEGACY_SCOPE_AMBIGUOUS" });
  });

  it("fences a direct write when a legacy barrier changes after its snapshot", async () => {
    const inner = createInMemoryDocumentStore();
    let injected = false;
    const store = {
      ...inner,
      async writeBatchIfUnchanged(batch: Parameters<typeof inner.writeBatchIfUnchanged>[0]) {
        if (!injected) {
          injected = true;
          const id = legacyKey({ userId: fullScope.userId });
          await inner.set(SCOPE_MUTATION_BARRIERS_COLLECTION, id, { id, ...fullScope, state: "failed" });
        }
        return inner.writeBatchIfUnchanged(batch);
      },
    };
    await expect(createScopeDeletionAwareDocumentStore(store).set("facts", "memory", { id: "memory", ...fullScope })).rejects.toThrow("deletion generation changed");
    expect(await inner.get("facts", "memory")).toBeNull();
  });
});

describe("trusted extraction cursor recovery", () => {
  it("claims an ambiguous cursor once without changing its original row", async () => {
    const store = createInMemoryDocumentStore();
    const legacy = legacyCursor(collisionA);
    await store.set(EXTRACTION_CURSORS_COLLECTION, legacy.id, legacy);
    const cursors = createExtractionCursorStore({ documentStore: store, now });
    expect(await cursors.recoverLegacyCursor({
      scope: collisionA,
      sourceId: "source",
      expectedLegacyCursor: legacy,
      confirmTrustedOwnership: true,
    })).toBe(true);
    expect((await cursors.get(collisionA, "source"))?.committedThrough).toBe(10);
    expect(await cursors.get(collisionB, "source")).toBeNull();
    expect(await cursors.recoverLegacyCursor({
      scope: collisionB,
      sourceId: "source",
      expectedLegacyCursor: legacy,
      confirmTrustedOwnership: true,
    })).toBe(false);
    expect(await store.get(EXTRACTION_CURSORS_COLLECTION, legacy.id)).toEqual(legacy);
  });

  it("makes same-owner recovery retry idempotent without rolling back a newer cursor", async () => {
    const store = createInMemoryDocumentStore();
    const legacy = legacyCursor(collisionA);
    await store.set(EXTRACTION_CURSORS_COLLECTION, legacy.id, legacy);
    const cursors = createExtractionCursorStore({ documentStore: store, now });
    const recovery = { scope: collisionA, sourceId: "source", expectedLegacyCursor: legacy, confirmTrustedOwnership: true as const };
    expect(await cursors.recoverLegacyCursor(recovery)).toBe(true);
    await cursors.record({ scope: collisionA, sourceId: "source", through: 20, outcome: "committed" });
    const restarted = createExtractionCursorStore({ documentStore: store, now });
    expect(await restarted.recoverLegacyCursor(recovery)).toBe(true);
    expect((await restarted.get(collisionA, "source"))?.committedThrough).toBe(20);
    const current = await restarted.get(collisionA, "source");
    await store.delete(EXTRACTION_CURSORS_COLLECTION, current!.id);
    expect(await restarted.recoverLegacyCursor(recovery)).toBe(false);
    expect(await restarted.get(collisionA, "source")).toBeNull();
  });

  it("rejects a stale recovery snapshot and atomically resolves competing owners", async () => {
    const store = createInMemoryDocumentStore();
    const legacy = legacyCursor(collisionA);
    await store.set(EXTRACTION_CURSORS_COLLECTION, legacy.id, legacy);
    const cursors = createExtractionCursorStore({ documentStore: store, now });
    expect(await cursors.recoverLegacyCursor({
      scope: collisionA, sourceId: "source",
      expectedLegacyCursor: { ...legacy, committedThrough: 9 },
      confirmTrustedOwnership: true,
    })).toBe(false);
    const recovered = await Promise.all([collisionA, collisionB].map((scope) =>
      cursors.recoverLegacyCursor({ scope, sourceId: "source", expectedLegacyCursor: legacy, confirmTrustedOwnership: true })
    ));
    expect(recovered.filter(Boolean)).toHaveLength(1);
    expect(await store.get(EXTRACTION_CURSORS_COLLECTION, legacy.id)).toEqual(legacy);
  });
});

describe("trusted legacy deletion journal recovery", () => {
  const owner = { ...fullScope, tenantId: "tenant::part", workspaceId: "rest" };
  const collision = { ...fullScope, tenantId: "tenant", workspaceId: "part::rest" };

  it("maps a key-only journal without opening its fences or rewriting its raw rows", async () => {
    const store = createInMemoryDocumentStore();
    const original = await seedLegacyJournal(store, owner, false);
    const coordinator = createScopeDeletionCoordinator(store);
    const recovery = {
      scope: owner,
      expectedLock: original.lock,
      expectedBarrier: original.barrier,
      confirmTrustedOwnership: true as const,
      confirmPriorRuntimesStopped: true as const,
    };
    expect(await coordinator.recoverLegacyDeletionJournal(recovery)).toBe(true);
    expect(await store.get(SCOPE_DELETION_LOCKS_COLLECTION, original.lock.id)).toEqual(original.lock);
    expect(await store.get(SCOPE_MUTATION_BARRIERS_COLLECTION, original.barrier.id)).toEqual(original.barrier);
    await expect(coordinator.runMutation(owner, async () => "unsafe")).rejects.toThrow("deletion");
    await expect(createScopeDeletionAwareDocumentStore(store).set("facts", "late", { id: "late", ...owner })).rejects.toThrow("deletion");
    expect(await coordinator.recoverLegacyDeletionJournal({ ...recovery, scope: collision })).toBe(false);
    await expect(coordinator.runExclusive(owner, async () => "completed", {
      resumeInterrupted: { confirmPriorRuntimesStopped: true },
    })).resolves.toBe("completed");
    const completed = await store.get(SCOPE_DELETION_LOCKS_COLLECTION, original.lock.id);
    expect(completed).toMatchObject({ state: "open" });
    expect(await createScopeDeletionCoordinator(store).recoverLegacyDeletionJournal(recovery)).toBe(true);
    expect(await store.get(SCOPE_DELETION_LOCKS_COLLECTION, original.lock.id)).toEqual(completed);
    await expect(coordinator.runMutation(owner, async () => "safe")).resolves.toBe("safe");
  });

  it("requires unchanged source journals and rejects competing current target state", async () => {
    const store = createInMemoryDocumentStore();
    const original = await seedLegacyJournal(store, owner, false);
    const coordinator = createScopeDeletionCoordinator(store);
    const recovery = {
      scope: owner,
      expectedLock: original.lock,
      expectedBarrier: original.barrier,
      confirmTrustedOwnership: true as const,
      confirmPriorRuntimesStopped: true as const,
    };
    expect(await coordinator.recoverLegacyDeletionJournal({
      ...recovery, expectedLock: { ...original.lock, generation: "stale" },
    })).toBe(false);
    await store.set(SCOPE_DELETION_LOCKS_COLLECTION, scopeToKey(owner), {
      id: scopeToKey(owner), ...owner, state: "open", epoch: 8,
    });
    expect(await coordinator.recoverLegacyDeletionJournal(recovery)).toBe(false);
    expect(await store.get(SCOPE_DELETION_LOCKS_COLLECTION, original.lock.id)).toEqual(original.lock);
  });

  it("atomically chooses one owner for colliding key-only journals", async () => {
    const store = createInMemoryDocumentStore();
    const original = await seedLegacyJournal(store, owner, false);
    const coordinator = createScopeDeletionCoordinator(store);
    const outcomes = await Promise.all([owner, collision].map((scope) =>
      coordinator.recoverLegacyDeletionJournal({
        scope,
        expectedLock: original.lock,
        expectedBarrier: original.barrier,
        confirmTrustedOwnership: true,
        confirmPriorRuntimesStopped: true,
      })
    ));
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(await store.get(SCOPE_DELETION_LOCKS_COLLECTION, original.lock.id)).toEqual(original.lock);
  });
});

describe("legacy recovery atomic compare-and-set fences", () => {
  it("does not claim or copy a cursor changed during recovery admission", async () => {
    const inner = createInMemoryDocumentStore();
    const legacy = legacyCursor(collisionA);
    await inner.set(EXTRACTION_CURSORS_COLLECTION, legacy.id, legacy);
    const store = {
      ...inner,
      async writeBatchIfUnchanged(batch: Parameters<typeof inner.writeBatchIfUnchanged>[0]) {
        await inner.set(EXTRACTION_CURSORS_COLLECTION, legacy.id, { ...legacy, committedThrough: 11 });
        return inner.writeBatchIfUnchanged(batch);
      },
    };
    const recovered = await createExtractionCursorStore({ documentStore: store, now }).recoverLegacyCursor({
      scope: collisionA, sourceId: "source", expectedLegacyCursor: legacy, confirmTrustedOwnership: true,
    });
    expect(recovered).toBe(false);
    expect(await inner.query(EXTRACTION_CURSORS_COLLECTION)).toHaveLength(1);
    expect(await inner.query("extraction_cursor_legacy_claims_v1")).toEqual([]);
  });

  it("does not map a deletion journal changed during recovery admission", async () => {
    const inner = createInMemoryDocumentStore();
    const original = await seedLegacyJournal(inner, collisionA, false);
    const store = {
      ...inner,
      async writeBatchIfUnchanged(batch: Parameters<typeof inner.writeBatchIfUnchanged>[0]) {
        await inner.set(SCOPE_MUTATION_BARRIERS_COLLECTION, original.barrier.id, {
          ...original.barrier, generation: "changed-before-commit",
        });
        return inner.writeBatchIfUnchanged(batch);
      },
    };
    const recovered = await createScopeDeletionCoordinator(store).recoverLegacyDeletionJournal({
      scope: collisionA,
      expectedLock: original.lock,
      expectedBarrier: original.barrier,
      confirmTrustedOwnership: true,
      confirmPriorRuntimesStopped: true,
    });
    expect(recovered).toBe(false);
    expect(await inner.query("scope_deletion_legacy_claims_v1")).toEqual([]);
    expect(await inner.get(SCOPE_DELETION_LOCKS_COLLECTION, original.lock.id)).toEqual(original.lock);
    await expect(createScopeDeletionCoordinator(inner).runMutation(collisionA, async () => "unsafe"))
      .rejects.toMatchObject({ code: "GOODMEMORY_LEGACY_SCOPE_AMBIGUOUS" });
  });
});
