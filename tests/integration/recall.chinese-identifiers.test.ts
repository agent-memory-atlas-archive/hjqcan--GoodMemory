import { expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGoodMemory, createDeterministicMemoryExtractor } from "../../src";

it("retrieves each numbered project through a fresh default SQLite facade", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gm-numbered-recall-"));
  const storage = { provider: "sqlite" as const, url: join(directory, "memory.sqlite") };
  const config = { storage, adapters: { assistedExtractor: createDeterministicMemoryExtractor() } };
  const memory = createGoodMemory(config);
  const scope = { userId: "numbered-projects", workspaceId: "workspace" };
  try {
    for (let index = 0; index < 8; index++) {
      await memory.remember({
        scope: { ...scope, sessionId: `seed-${index}` },
        messages: [{ role: "user", content: `请记住项目${index}的代号=Canary${index}。` }],
      });
    }
    const before = (await memory.exportMemory({ scope })).durable;
    expect(before.facts).toHaveLength(8);
    const fresh = createGoodMemory(config);
    const outcomes: boolean[] = [];
    for (let index = 0; index < 8; index++) {
      // The question identifies the project, but does not contain its answer.
      const recall = await fresh.recall({ scope: { ...scope, sessionId: `query-${index}` }, query: `项目${index}的代号是什么？` });
      const context = await fresh.buildContext({ recall, output: "markdown" });
      outcomes.push(recall.facts.some((fact) => fact.content === `项目${index}的代号=Canary${index}`) && context.content.includes(`Canary${index}`));
    }
    expect(outcomes).toEqual(Array.from({ length: 8 }, () => true));
    expect((await fresh.exportMemory({ scope })).durable).toEqual(before);
    expect((await fresh.recall({ scope: { ...scope, userId: "unrelated-user" }, query: "项目0的代号是什么？" })).facts).toEqual([]);
    expect((await fresh.recall({ scope: { ...scope, workspaceId: "another-workspace" }, query: "项目0的代号是什么？" })).facts).toEqual([]);
    const forgotten = before.facts.find((fact) => fact.content === "项目7的代号=Canary7")!;
    expect((await fresh.forget({ scope, memoryId: forgotten.id })).forgotten).toBe(true);
    const afterForget = await fresh.recall({ scope, query: "项目7的代号是什么？" });
    expect(afterForget.facts.some((fact) => fact.id === forgotten.id)).toBe(false);
    expect((await fresh.buildContext({ recall: afterForget, output: "markdown" })).content).not.toContain("Canary7");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
