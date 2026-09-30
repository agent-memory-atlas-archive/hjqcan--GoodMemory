import { describe, expect, it } from "bun:test";
import { createGoodMemory } from "../../src";

describe("explicit semicolon lists preserve their instruction scope", () => {
  it.each([
    ["en-US", "Remember that Project A uses PostgreSQL; Project B uses SQLite.", ["Project A uses PostgreSQL", "Project B uses SQLite"]],
    ["zh-CN", "请记住，项目甲使用 PostgreSQL；项目乙使用 SQLite。", ["项目甲使用 PostgreSQL", "项目乙使用 SQLite"]],
    ["zh-TW", "請記住，專案甲採用 PostgreSQL；專案乙採用 SQLite。", ["專案甲採用 PostgreSQL", "專案乙採用 SQLite"]],
    ["en-US", "Remember that the build uses pnpm; the tests use Bun.", ["the build uses pnpm", "the tests use Bun"]],
  ])("writes every independent explicit assertion: %s", async (locale, content, expected) => {
    const memory = createGoodMemory({ storage: { provider: "memory" } });
    const scope = { userId: `semicolon-${locale}` };
    await memory.remember({ scope, locale, messages: [{ role: "user", content }] });
    const values = (await memory.exportMemory({ scope })).durable.facts.map((fact) => fact.content);
    for (const value of expected) expect(values.some((content) => content.includes(value))).toBe(true);
    expect(values).toHaveLength(expected.length);
  });

  it.each([
    ["en-US", "Remember that Project A uses PostgreSQL; does Project B use SQLite?"],
    ["en-US", "Remember that Project A uses PostgreSQL; use SQLite for this example."],
    ["en-US", "Remember that Project A uses PostgreSQL; do not remember Project B uses SQLite."],
    ["zh-CN", "请记住，项目甲使用 PostgreSQL；项目乙使用 SQLite 吗？"],
    ["zh-CN", "请记住，项目甲使用 PostgreSQL；请用 SQLite 写一个示例。"],
    ["zh-CN", "请记住，项目甲使用 PostgreSQL；不要记住项目乙使用 SQLite。"],
  ])("does not promote a question, one-off instruction or opt-out: %s %s", async (locale, content) => {
    const memory = createGoodMemory({ storage: { provider: "memory" } });
    const scope = { userId: `semicolon-control-${locale}` };
    await memory.remember({ scope, locale, messages: [{ role: "user", content }] });
    expect((await memory.exportMemory({ scope })).durable.facts.every((fact) => !fact.content.includes("SQLite"))).toBe(true);
  });
});
