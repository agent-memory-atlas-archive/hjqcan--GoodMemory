import type { ProjectionCapableDocumentStore } from "../../storage/contracts";
import { resolveDocumentStoreIdentity } from "../../storage/documentStoreIdentity";
import { PROJECTION_MANIFESTS_COLLECTION } from "./contracts";

interface Waiter {
  grant(): void;
}

// Each queue owns only the inner guard-read/atomic-commit window. Nothing here
// changes a caller's expected snapshots or grants permission to overwrite one.
export function createManifestWriteQueue(waitTimeoutMs = 30_000) {
  const queues = new Map<string, Waiter[]>();
  async function acquire(key: string): Promise<() => void> {
    let queue = queues.get(key);
    if (!queue) {
      queues.set(key, []);
    } else {
      await new Promise<void>((resolve, reject) => {
        const waiter: Waiter = { grant() { clearTimeout(timer); resolve(); } };
        const timer = setTimeout(() => {
          const index = queue!.indexOf(waiter);
          if (index >= 0) queue!.splice(index, 1);
          reject(new Error("Projection manifest write queue wait timed out."));
        }, waitTimeoutMs);
        queue!.push(waiter);
      });
    }
    return () => {
      const waiting = queues.get(key)!;
      const next = waiting.shift();
      if (next) next.grant();
      else queues.delete(key);
    };
  }
  return {
    async run<T>(keys: readonly string[], operation: () => Promise<T>): Promise<T> {
      const releases: Array<() => void> = [];
      try {
        for (const key of [...new Set(keys)].sort()) releases.push(await acquire(key));
        return await operation();
      } finally {
        for (const release of releases.reverse()) release();
      }
    },
  };
}

const backendQueues = new WeakMap<object, ReturnType<typeof createManifestWriteQueue>>();

export function createManifestWriteCoordinatedStore(
  store: ProjectionCapableDocumentStore,
  identityStore: ProjectionCapableDocumentStore,
): ProjectionCapableDocumentStore {
  return {
    ...store,
    async writeBatchIfUnchanged(batch) {
      const keys = [...batch.set, ...(batch.delete ?? [])]
        .filter(({ collection }) => collection === PROJECTION_MANIFESTS_COLLECTION)
        .map(({ id }) => id);
      if (keys.length === 0) return store.writeBatchIfUnchanged(batch);
      const identity = await resolveDocumentStoreIdentity(identityStore);
      let queue = backendQueues.get(identity);
      if (!queue) {
        queue = createManifestWriteQueue();
        backendQueues.set(identity, queue);
      }
      return queue.run(keys, () => store.writeBatchIfUnchanged(batch));
    },
  };
}
