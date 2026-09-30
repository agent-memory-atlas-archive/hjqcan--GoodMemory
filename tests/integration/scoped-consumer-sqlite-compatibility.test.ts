import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { legacyScopeToKey, scopeToKey } from "../../src/domain/scope";
import {
  EXTRACTION_CURSORS_COLLECTION,
  createExtractionCursorStore,
  type ExtractionCursor,
} from "../../src/remember/extractionCursor";
import {
  ARTIFACT_SPILL_PAYLOAD_COLLECTION,
  createArtifactSpilloverService,
} from "../../src/runtime/spillover";
import { createSQLiteDocumentStore } from "../../src/storage/sqlite";
import {
  createScopeDeletionAwareDocumentStore,
  createScopeDeletionCoordinator,
  SCOPE_DELETION_LOCKS_COLLECTION,
  SCOPE_MUTATION_BARRIERS_COLLECTION,
} from "../../src/storage/scopeDeletion";

const now = () => "2026-09-30T00:00:00.000Z";
const scope = {
  userId: "user",
  tenantId: "tenant",
  workspaceId: "workspace",
  agentId: "agent",
  sessionId: "session",
};

async function cleanup(path: string) {
  await Promise.all([path, `${path}-wal`, `${path}-shm`].map((file) =>
    rm(file, { force: true })
  ));
}

describe("SQLite persisted consumer scope-key compatibility", () => {
  it("preserves old cursor and payload bytes across versioned writes and restart", async () => {
    const path = join(tmpdir(), `goodmemory-consumer-keys-${randomUUID()}.db`);
    try {
      const before = createSQLiteDocumentStore(path);
      const oldScopeKey = legacyScopeToKey(scope);
      const id = createHash("sha256").update(oldScopeKey).update("\0source").digest("hex");
      const cursor = {
        id,
        scopeKey: oldScopeKey,
        sourceId: "source",
        schemaVersion: 1,
        committedThrough: 10,
        lastAttempt: { attempts: 1, outcome: "committed", through: 10, updatedAt: now() },
      };
      await before.set(EXTRACTION_CURSORS_COLLECTION, id, cursor);
      const content = "legacy content survives restart";
      const contentHash = createHash("sha256").update(content).digest("hex");
      const payloadId = `${oldScopeKey}::${contentHash}`;
      const payload = { id: payloadId, scope, contentHash, content, originalBytes: content.length, createdAt: now() };
      await before.set(ARTIFACT_SPILL_PAYLOAD_COLLECTION, payloadId, payload);
      const restarted = createSQLiteDocumentStore(path);
      const cursors = createExtractionCursorStore({ documentStore: restarted, now });
      expect((await cursors.get(scope, "source"))?.committedThrough).toBe(10);
      expect(await cursors.record({ scope, sourceId: "source", through: 20, outcome: "failed" }))
        .toMatchObject({ committedThrough: 10, scopeKey: scopeToKey(scope) });
      const afterWrite = createSQLiteDocumentStore(path);
      expect(await afterWrite.get(EXTRACTION_CURSORS_COLLECTION, id)).toEqual(cursor);
      expect(await afterWrite.get(ARTIFACT_SPILL_PAYLOAD_COLLECTION, payloadId)).toEqual(payload);
      expect(await createArtifactSpilloverService({ documentStore: afterWrite }).resolve(
        scope,
        `memory://artifact-spill-payloads/${encodeURIComponent(payloadId)}`,
      )).toBe(content);
    } finally {
      await cleanup(path);
    }
  });

  it("keeps old deletion journals closed after restart and supports explicit scoped recovery", async () => {
    const path = join(tmpdir(), `goodmemory-consumer-fence-${randomUUID()}.db`);
    try {
      const before = createSQLiteDocumentStore(path);
      const id = legacyScopeToKey(scope);
      const barrierId = legacyScopeToKey({ userId: scope.userId });
      const lock = {
        ...scope,
        id,
        epoch: 1,
        generation: "old-generation",
        operationId: "old-operation",
        operationKey: `scope-deletion:v1:${id}`,
        ownerId: "stopped-owner",
        phase: "delete_all",
        state: "failed",
      };
      await before.set(SCOPE_DELETION_LOCKS_COLLECTION, id, lock);
      await before.set(SCOPE_MUTATION_BARRIERS_COLLECTION, barrierId, { ...lock, id: barrierId });
      const restarted = createSQLiteDocumentStore(path);
      const coordinator = createScopeDeletionCoordinator(restarted);
      await expect(coordinator.runMutation(scope, async () => "unsafe"))
        .rejects.toThrow("deletion");
      await expect(createScopeDeletionAwareDocumentStore(restarted).set(
        "facts", "late-write", { id: "late-write", ...scope },
      )).rejects.toThrow("deletion");
      expect(await restarted.get(SCOPE_DELETION_LOCKS_COLLECTION, id)).toEqual(lock);
      await expect(coordinator.runExclusive(scope, async () => "recovered", {
        resumeInterrupted: { confirmPriorRuntimesStopped: true },
      })).resolves.toBe("recovered");
      const afterRecovery = createSQLiteDocumentStore(path);
      expect(await afterRecovery.get(SCOPE_DELETION_LOCKS_COLLECTION, id))
        .toMatchObject({ state: "open" });
      expect(await afterRecovery.get(SCOPE_MUTATION_BARRIERS_COLLECTION, barrierId))
        .toMatchObject({ state: "open" });
      await expect(createScopeDeletionCoordinator(afterRecovery).runMutation(scope, async () => "safe"))
        .resolves.toBe("safe");
    } finally {
      await cleanup(path);
    }
  });
});


it("keeps single-owner cursor and key-only journal recovery claims across SQLite restart", async () => {
  const path = join(tmpdir(), `goodmemory-recovery-claims-${randomUUID()}.db`);
  try {
    const owner = { ...scope, tenantId: "tenant::part", workspaceId: "rest" };
    const other = { ...scope, tenantId: "tenant", workspaceId: "part::rest" };
    const before = createSQLiteDocumentStore(path);
    const oldKey = legacyScopeToKey(owner);
    const id = createHash("sha256").update(oldKey).update("\0source").digest("hex");
    const cursor: ExtractionCursor = {
      id, scopeKey: oldKey, sourceId: "source", schemaVersion: 1, committedThrough: 10,
      lastAttempt: { attempts: 1, outcome: "committed", through: 10, updatedAt: now() },
    };
    await before.set(EXTRACTION_CURSORS_COLLECTION, id, cursor);
    expect(await createExtractionCursorStore({ documentStore: before, now }).recoverLegacyCursor({
      scope: owner, sourceId: "source", expectedLegacyCursor: cursor, confirmTrustedOwnership: true,
    })).toBe(true);
    const lock = {
      id: oldKey, epoch: 1, generation: "generation", operationId: "operation",
      operationKey: `scope-deletion:v1:${oldKey}`, ownerId: "stopped",
      phase: "delete_all" as const, state: "failed" as const,
    };
    const barrier = { ...lock, id: legacyScopeToKey({ userId: owner.userId }) };
    await before.set(SCOPE_DELETION_LOCKS_COLLECTION, lock.id, lock);
    await before.set(SCOPE_MUTATION_BARRIERS_COLLECTION, barrier.id, barrier);
    expect(await createScopeDeletionCoordinator(before).recoverLegacyDeletionJournal({
      scope: owner, expectedLock: lock, expectedBarrier: barrier,
      confirmTrustedOwnership: true, confirmPriorRuntimesStopped: true,
    })).toBe(true);
    const restarted = createSQLiteDocumentStore(path);
    const cursors = createExtractionCursorStore({ documentStore: restarted, now });
    expect((await cursors.get(owner, "source"))?.committedThrough).toBe(10);
    expect(await cursors.recoverLegacyCursor({
      scope: other, sourceId: "source", expectedLegacyCursor: cursor, confirmTrustedOwnership: true,
    })).toBe(false);
    const coordinator = createScopeDeletionCoordinator(restarted);
    await expect(coordinator.runMutation(owner, async () => "unsafe")).rejects.toThrow("deletion");
    expect(await coordinator.recoverLegacyDeletionJournal({
      scope: other, expectedLock: lock, expectedBarrier: barrier,
      confirmTrustedOwnership: true, confirmPriorRuntimesStopped: true,
    })).toBe(false);
    await expect(coordinator.runExclusive(owner, async () => "recovered", {
      resumeInterrupted: { confirmPriorRuntimesStopped: true },
    })).resolves.toBe("recovered");
    expect(await restarted.get(EXTRACTION_CURSORS_COLLECTION, id)).toEqual(cursor);
  } finally {
    await cleanup(path);
  }
});
