import { describe, expect, it } from "bun:test";
import * as scopeKeys from "../../src/domain/scope";
import type { MemoryScope } from "../../src/domain/scope";

const pairs: [MemoryScope, MemoryScope][] = [
  [{ userId: "u", tenantId: "a::b", sessionId: "s" }, { userId: "u::a", tenantId: "b", sessionId: "s" }],
  [{ userId: "u:", tenantId: "t", sessionId: "s" }, { userId: "u", tenantId: ":t", sessionId: "s" }],
  [{ userId: "u", tenantId: "w" }, { userId: "u", workspaceId: "w" }],
];

describe("versioned scope keys", () => {
  it.each(pairs)("separates colliding or shifted scope tuples %#", (left, right) => {
    expect(scopeKeys.scopeToKey(left)).not.toBe(scopeKeys.scopeToKey(right));
    expect(scopeKeys.isSameScope(left, right)).toBe(false);
  });

  it("uses a canonical namespace disjoint from all legacy keys", () => {
    for (const userId of ["gm2:any", "x::y", "", "\ud800", "中文", "a%_\\"]) {
      if (!userId) continue;
      const key = scopeKeys.scopeToKey({ userId, sessionId: "::" });
      expect(key.startsWith("gm2:")).toBe(true);
      expect(key).not.toContain("::");
      expect(scopeKeys.parseScopeKey(key)).toEqual(scopeKeys.normalizeScope({ userId, sessionId: "::" }));
    }
  });

  it("roundtrips a bounded adversarial component matrix injectively", () => {
    const values = [undefined, "a", ":", "::", "a:", ":a", "a:b", "a::b", "a%", "a_", "中文", "\ud800", "null", "gm2:"];
    const keys = new Set<string>();
    for (const tenantId of values) {
      for (const workspaceId of values) {
        const scope = { userId: "u", tenantId, workspaceId };
        const key = scopeKeys.scopeToKey(scope);
        expect(keys.has(key)).toBe(false);
        keys.add(key);
        expect(scopeKeys.parseScopeKey(key)).toEqual(scopeKeys.normalizeScope(scope));
      }
    }
  });

  it("rejects malformed, noncanonical, and legacy input when decoding v2", () => {
    const valid = scopeKeys.scopeToKey({ userId: "u" });
    for (const key of ["u::::::::", "gm2:", valid + ":extra", valid.replace("gm2:", "gm3:"), valid + "=", valid.replace("InUi", "IiB1ICI")]) {
      expect(scopeKeys.parseScopeKey(key)).toBeNull();
    }
  });

  it("has an exact durable prefix with a field boundary", () => {
    const scope = { userId: "u::x", tenantId: "t:" };
    const prefix = scopeKeys.scopeToPrefix(scope);
    expect(scopeKeys.scopeToKey({ ...scope, sessionId: "s" }).startsWith(prefix)).toBe(true);
    expect(scopeKeys.scopeToKey({ ...scope, tenantId: "t::", sessionId: "s" }).startsWith(prefix)).toBe(false);
    expect(scopeKeys.scopeToPrefix({ ...scope, sessionId: "" })).toBe(scopeKeys.scopeToKey(scope));
  });

  it("only decodes legacy tuples with provable unique boundaries", () => {
    for (const scope of [{ userId: "u", sessionId: "s" }, { userId: ":u", tenantId: "a:b", sessionId: "s:" }]) {
      expect(scopeKeys.decodeLegacyScopeKey(scopeKeys.legacyScopeToKey(scope))).toEqual(scopeKeys.normalizeScope(scope));
    }
    for (const [left] of pairs.slice(0, 2)) {
      expect(scopeKeys.decodeLegacyScopeKey(scopeKeys.legacyScopeToKey(left))).toBeNull();
    }
    for (const key of ["", "::::::::", " u::::::::", "u:: ::w::::s", "u:::::::s", "u::::::::::s"]) {
      expect(scopeKeys.decodeLegacyScopeKey(key)).toBeNull();
    }
  });
});
