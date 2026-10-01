import type { FactMemory } from "../domain/records";
import type { DocumentStore } from "./contracts";

/** No writes: use the adapter's atomic compare to validate a joint read snapshot. */
export async function checkFactSnapshots(store: DocumentStore, facts: readonly FactMemory[]): Promise<boolean> {
  if (!store.writeBatchIfUnchanged || facts.length === 0) return false;
  const [first, ...rest] = facts;
  return store.writeBatchIfUnchanged({
    expected: { collection: "facts", id: first!.id, document: first! },
    unchanged: rest.map((fact) => ({ collection: "facts", id: fact.id, document: fact })),
    set: [],
  });
}
