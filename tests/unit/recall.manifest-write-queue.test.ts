import { expect, it } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSQLiteDocumentStore } from "../../src/storage/sqlitePublic";
import { resolveDocumentStoreIdentity } from "../../src/storage/documentStoreIdentity";
import { createManifestWriteQueue } from "../../src/recall/projections/manifestWriteQueue";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

it("queues one scope FIFO while independent scopes remain available", async () => {
  const queue = createManifestWriteQueue();
  const first = deferred();
  const entered = deferred();
  const order: number[] = [];
  const a = queue.run(["scope-a"], async () => { entered.resolve(); await first.promise; order.push(1); });
  await entered.promise;
  const b = queue.run(["scope-a"], async () => { order.push(2); });
  const c = queue.run(["scope-a"], async () => { order.push(3); });
  await queue.run(["scope-b"], async () => { order.push(0); });
  expect(order).toEqual([0]);
  first.resolve();
  await Promise.all([a, b, c]);
  expect(order).toEqual([0, 1, 2, 3]);
});

it("removes an expired waiter without executing it and releases locks after failure", async () => {
  const queue = createManifestWriteQueue(15);
  const first = deferred();
  const entered = deferred();
  const a = queue.run(["scope"], async () => { entered.resolve(); await first.promise; });
  await entered.promise;
  let expiredRan = false;
  await expect(queue.run(["scope"], async () => { expiredRan = true; })).rejects.toThrow("timed out");
  first.resolve();
  await a;
  expect(expiredRan).toBe(false);
  await expect(queue.run(["scope"], async () => { throw new Error("synthetic storage failure"); })).rejects.toThrow("synthetic");
  expect(await queue.run(["scope"], async () => "healthy")).toBe("healthy");
});

it("orders multi-scope acquisitions consistently and releases partial acquisitions", async () => {
  const queue = createManifestWriteQueue(15);
  expect(await Promise.all([
    queue.run(["b", "a"], async () => 1),
    queue.run(["a", "b", "a"], async () => 2),
  ])).toEqual([1, 2]);
  const held = deferred();
  const entered = deferred();
  const a = queue.run(["b"], async () => { entered.resolve(); await held.promise; });
  await entered.promise;
  await expect(queue.run(["a", "b"], async () => 0)).rejects.toThrow("timed out");
  expect(await queue.run(["a"], async () => 3)).toBe(3);
  held.resolve();
  await a;
});

it("shares only resolved physical SQLite identities across deferred facades", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gm-manifest-identity-"));
  try {
    const path = join(directory, "db.sqlite");
    const original = createSQLiteDocumentStore(path);
    await original.query("facts");
    const alias = join(directory, "alias.sqlite");
    await symlink(path, alias);
    expect(await resolveDocumentStoreIdentity(original)).toBe(await resolveDocumentStoreIdentity(createSQLiteDocumentStore(alias)));
    expect(await resolveDocumentStoreIdentity(original)).toBe(await resolveDocumentStoreIdentity(createSQLiteDocumentStore(join(directory, ".", "db.sqlite"))));
    expect(await resolveDocumentStoreIdentity(original)).not.toBe(await resolveDocumentStoreIdentity(createSQLiteDocumentStore(join(directory, "other.sqlite"))));
    expect(await resolveDocumentStoreIdentity(createSQLiteDocumentStore(":memory:"))).not.toBe(await resolveDocumentStoreIdentity(createSQLiteDocumentStore(":memory:")));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("preserves stale validation and owner conditions instead of rebasing queued batches", async () => {
  const { createInMemoryDocumentStore } = await import("../../src/storage/memory");
  const { createManifestWriteCoordinatedStore } = await import("../../src/recall/projections/manifestWriteQueue");
  const { createProjectionManifestTracker } = await import("../../src/recall/projections/manifest");
  const raw = createInMemoryDocumentStore();
  const store = createManifestWriteCoordinatedStore(raw, raw);
  const tracker = createProjectionManifestTracker({ documentStore: store, buildId: "synthetic-build", now: () => "2026-01-01T00:00:00Z" });
  const scope = { userId: "owner" };
  await tracker.invalidate(scope);
  const captured = await tracker.beginValidation(scope);
  expect(captured).not.toBeNull();
  await raw.set("owners", "owner", { token: "newer" });
  const unsuccessful = await tracker.prepareInvalidation([scope]);
  expect(await store.writeBatchIfUnchanged({
    expected: { collection: "facts", id: "fact", document: null },
    unchanged: [{ collection: "owners", id: "owner", document: { token: "older" } }],
    set: [{ collection: "facts", id: "fact", document: { value: "must not write" } }, ...unsuccessful.set],
  })).toBe(false);
  expect(await tracker.beginValidation(scope)).toEqual(captured);
  const successful = await tracker.prepareInvalidation([scope]);
  expect(await store.writeBatchIfUnchanged({
    expected: { collection: "facts", id: "fact", document: null },
    unchanged: [{ collection: "owners", id: "owner", document: { token: "newer" } }],
    set: [{ collection: "facts", id: "fact", document: { value: "current" } }, ...successful.set],
  })).toBe(true);
  expect(await tracker.completeValidation(captured)).toBe(false);
  expect(await tracker.hasValidProof(scope)).toBe(false);
  const next = await tracker.beginValidation(scope);
  expect(next?.sourceGeneration).not.toBe(captured?.sourceGeneration);
  expect(await tracker.completeValidation(next)).toBe(true);
  expect(await tracker.hasValidProof(scope)).toBe(true);
  // A stale rollback cannot erase the latest owner or canonical value.
  expect(await store.writeBatchIfUnchanged({
    expected: { collection: "owners", id: "owner", document: { token: "older" } },
    delete: [{ collection: "facts", id: "fact" }], set: [],
  })).toBe(false);
  expect(await raw.get("facts", "fact")).toEqual({ value: "current" });
});
