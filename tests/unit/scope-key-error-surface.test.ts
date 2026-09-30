import { describe, expect, it } from "bun:test";
import { createGoodMemory, createInMemoryDocumentStore, LegacyScopeKeyError } from "../../src";
import { createGoodMemoryHttpMemoryBridge } from "../../src/http";
import { createInspectorApp } from "../../src/inspector/public";

const scope = { userId: "error-user" };

describe("scope-key migration error surfaces", () => {
  it("returns an actionable conflict from the authorized memory bridge without exposing the key", async () => {
    const memory = createGoodMemory({ storage: { provider: "memory" } });
    memory.buildContext = async () => { throw new LegacyScopeKeyError("private-legacy-key"); };
    const bridge = createGoodMemoryHttpMemoryBridge({ memory });
    const response = await bridge.fetch(new Request("http://localhost/memory/recall-context", {
      method: "POST", headers: { "content-type": "application/json", "x-goodmemory-user-id": scope.userId, "x-goodmemory-operations": "recall-context" },
      body: JSON.stringify({ scope, query: "Continue" }),
    }));
    expect(response.status).toBe(409);
    const text = await response.text();
    expect(text).toContain("GOODMEMORY_LEGACY_SCOPE_AMBIGUOUS");
    expect(text).toContain("preserved");
    expect(text).not.toContain("private-legacy-key");
  });

  it("returns the same safe conflict from authenticated Inspector access", async () => {
    const memory = createGoodMemory({ storage: { provider: "memory" } });
    const store = createInMemoryDocumentStore();
    store.query = async () => { throw new LegacyScopeKeyError("private-legacy-key"); };
    store.queryPage = async () => { throw new LegacyScopeKeyError("private-legacy-key"); };
    const app = createInspectorApp({ documentStore: store, memory, token: "scope-key-test-token" });
    const response = await app.fetch(new Request("http://localhost/admin/v1/scopes", { headers: { authorization: "Bearer scope-key-test-token" } }));
    expect(response.status).toBe(409);
    const text = await response.text();
    expect(text).toContain("GOODMEMORY_LEGACY_SCOPE_AMBIGUOUS");
    expect(text).toContain("preserved");
    expect(text).not.toContain("private-legacy-key");
  });
});
