import { existsSync, writeFileSync } from "node:fs";
const { createGoodMemory, createDeterministicMemoryExtractor, createLocalEmbeddingAdapter } = await import(
  process.env.GOODMEMORY_CONCURRENT_SOURCE ?? "../../../src/index.ts"
);

const input = JSON.parse(await Bun.stdin.text()) as {
  database: string; userId: string; width: number; offset: number; readyPath: string; startPath: string;
};
const memory = createGoodMemory({
  storage: { provider: "sqlite", url: input.database },
  adapters: { assistedExtractor: createDeterministicMemoryExtractor(), embeddingAdapter: createLocalEmbeddingAdapter() },
});
await memory.exportMemory({ scope: { userId: input.userId } });
writeFileSync(input.readyPath, "ready");
const deadline = Date.now() + 10_000;
while (!existsSync(input.startPath)) {
  if (Date.now() > deadline) throw new Error("Parent did not release concurrent writers.");
  await Bun.sleep(5);
}
const results = await Promise.allSettled(Array.from({ length: input.width }, (_, localIndex) => {
  const index = input.offset + localIndex;
  return memory.remember({
    scope: { userId: input.userId, workspaceId: "tachikoma", agentId: "tachikoma", sessionId: `session-${index}` },
    messages: [{ id: `turn-${index}`, role: "user", content: `请记住项目${index}的代号=Canary${index}。` }],
  });
}));
console.log(JSON.stringify(results.map((result) => result.status === "fulfilled"
  ? { status: "fulfilled", accepted: result.value.accepted }
  : { status: "rejected", reason: String(result.reason), stack: result.reason?.stack })));
