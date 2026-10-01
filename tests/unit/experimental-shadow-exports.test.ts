import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import * as shadow from "../../src/experimental/shadow";
import * as implementation from "../../src/provider/memoryDecisionShadow";

describe("experimental shadow package boundary", () => {
  it("exposes only the three opt-in runtime helpers", () => {
    expect(Object.keys(shadow).sort()).toEqual([
      "createMemoryDecisionSnapshot", "evaluateMemoryDecisionShadow", "memoryShadowContextVersion",
    ]);
    expect(shadow.createMemoryDecisionSnapshot).toBe(implementation.createMemoryDecisionSnapshot);
    expect(shadow.evaluateMemoryDecisionShadow).toBe(implementation.evaluateMemoryDecisionShadow);
    expect(shadow.memoryShadowContextVersion).toBe(implementation.memoryShadowContextVersion);
  });
  it("coordinates JS, declarations and the package subpath without a Hub dependency", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(pkg.exports["./experimental/shadow"]).toEqual({
      types: "./dist/experimental/shadow.d.ts", import: "./dist/experimental/shadow.js",
    });
    expect(Object.keys(pkg.dependencies).some((name) => name.includes("cognitive"))).toBe(false);
    const types = JSON.parse(readFileSync(new URL("../../tsconfig.package.json", import.meta.url), "utf8"));
    expect(types.files).toContain("./src/experimental/shadow.ts");
    const build = readFileSync(new URL("../../scripts/build-package.ts", import.meta.url), "utf8");
    expect(build).toContain('join(REPO_ROOT, "src/experimental/shadow.ts")');
    const root = readFileSync(new URL("../../src/index.ts", import.meta.url), "utf8");
    expect(root).not.toContain("memoryDecisionShadow");
    expect(root).not.toContain("experimental/shadow");
  });
});
