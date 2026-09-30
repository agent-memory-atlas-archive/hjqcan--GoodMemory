import { describe, expect, it } from "bun:test";
import { scopeToKey } from "../../src/domain/scope";
import { createInMemoryDocumentStore } from "../../src/storage/memory";

describe("in-memory document cursor ordering", () => {
  it("uses the same binary order for sorting and continuation across ASCII, Unicode, and encoded scope IDs", async () => {
    const store = createInMemoryDocumentStore();
    const ids = ["a", "Z", "A", "z", "é", "中文", "日本語", scopeToKey({ userId: "a" }), scopeToKey({ userId: "g" })];
    for (const id of ids) await store.set("scope-pages", id, { id });
    const received: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.queryPage!<{ id: string }>("scope-pages", { limit: 1, cursor });
      received.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    expect(received).toEqual([...ids].sort());
    expect(new Set(received).size).toBe(ids.length);
  });
});
