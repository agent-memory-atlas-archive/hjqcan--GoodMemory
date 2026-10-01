import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import type { DocumentStore } from "./contracts";

// Internal, process-local coordination metadata. This is not a storage fence or
// an adapter capability: independent processes still rely on atomic batches.
const identities = new WeakMap<DocumentStore, () => Promise<object>>();
const sqliteIdentities = new Map<string, WeakRef<object>>();
const sqliteFinalizer = new FinalizationRegistry<string>((key) => {
  if (!sqliteIdentities.get(key)?.deref()) sqliteIdentities.delete(key);
});

export function bindDocumentStoreIdentity<T extends DocumentStore>(
  store: T,
  resolveIdentity: () => Promise<object>,
): T {
  identities.set(store, resolveIdentity);
  return store;
}

export async function resolveDocumentStoreIdentity(
  store: DocumentStore,
): Promise<object> {
  return identities.get(store)?.() ?? store;
}

export function bindSQLiteDocumentStoreIdentity<T extends DocumentStore>(
  store: T,
  path: string,
): T {
  // The database has already been opened. realpath handles relative paths and
  // symlink aliases, while private in-memory/temporary databases stay distinct.
  if (path === ":memory:" || path === "") return store;
  let key: string;
  try {
    key = realpathSync(resolve(path));
  } catch {
    return store;
  }
  let identity = sqliteIdentities.get(key)?.deref();
  if (!identity) {
    identity = {};
    sqliteIdentities.set(key, new WeakRef(identity));
    sqliteFinalizer.register(identity, key);
  }
  const stableIdentity = identity;
  return bindDocumentStoreIdentity(store, async () => stableIdentity);
}
