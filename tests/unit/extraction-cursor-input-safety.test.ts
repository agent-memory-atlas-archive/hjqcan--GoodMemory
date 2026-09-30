import { describe, expect, it } from "bun:test";
import { createExtractionCursorStore, createInMemoryDocumentStore } from "../../src";

const now = () => "2026-09-30T00:00:00.000Z";

describe("public extraction cursor input safety", () => {
  for (const unsafe of ["hidden\0separator", "unpaired\ud801"]) {
    for (const field of ["scope", "sourceId"] as const) {
      it(`rejects unsafe ${field} before any storage call (${JSON.stringify(unsafe)})`, async () => {
        const base = createInMemoryDocumentStore();
        let storageCalls = 0;
        const store = createExtractionCursorStore({ now, documentStore: {
          ...base,
          async get(collection, id) { storageCalls += 1; return base.get(collection, id); },
          async writeBatchIfUnchanged(input) { storageCalls += 1; return base.writeBatchIfUnchanged(input); },
        } });
        const scope = { userId: field === "scope" ? unsafe : "u" };
        const sourceId = field === "sourceId" ? unsafe : "source";
        await expect(store.get(scope, sourceId)).rejects.toThrow("Storage-unsafe text");
        await expect(store.record({ scope, sourceId, through: 1, outcome: "committed" })).rejects.toThrow("Storage-unsafe text");
        await expect(store.recoverLegacyCursor({
          scope, sourceId, confirmTrustedOwnership: true,
          expectedLegacyCursor: { id: "unused", schemaVersion: 1, scopeKey: "unused", sourceId,
            committedThrough: 1, lastAttempt: { attempts: 1, outcome: "committed", through: 1, updatedAt: now() } },
        })).rejects.toThrow("Storage-unsafe text");
        expect(storageCalls).toBe(0);
      });
    }
  }
});
