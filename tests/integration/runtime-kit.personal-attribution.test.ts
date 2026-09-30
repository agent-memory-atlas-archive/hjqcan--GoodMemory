import { describe, expect, it } from "bun:test";
import { createGoodMemory } from "../../src";
import { createGoodMemoryRuntimeKit } from "../../src/runtime-kit";

describe("runtime-kit personal provenance", () => {
  it("does not turn host writeback permission into user confirmation of assistant identity claims", async () => {
    const memory = createGoodMemory({ storage: { provider: "memory" }, testing: {
      extractor: { async extract() { return { ignoredMessageCount: 0, candidates: [{
        id: "assistant-claim", kindHint: "profile", explicitness: "explicit", content: "Alice",
        sourceMessageIndex: 1, sourceRole: "assistant", metadata: { profileField: "name" },
      }] }; } },
    } });
    const kit = createGoodMemoryRuntimeKit({ memory });
    const scope = { userId: "runtime-attribution-user", sessionId: "first" };
    const result = await kit.afterModelCall({ scope, messages: [{ role: "user", content: "Hello." }],
      assistantText: "Your name is Alice.", writeback: { mode: "selective", annotation: "durable_candidate", policy: "allow" },
    });
    expect(result.rememberResult?.accepted).toBe(0);
    const exported = await memory.exportMemory({ scope: { userId: scope.userId } });
    expect(exported.durable.profile?.identity.name).toBeUndefined();
  });
});
