import { expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGoodMemory, createDeterministicMemoryExtractor, createLocalEmbeddingAdapter, createSQLiteDocumentStore } from "../../src";
import { REMEMBER_WRITE_OWNERS_COLLECTION } from "../../src/remember/writeOwnership";

async function runRoundGroup(input: { instances: number; width: number; parallel: boolean; separateWorkspaces?: boolean }) {
  const directory = await mkdtemp(join(tmpdir(), "gm-default-concurrent-"));
  const database = join(directory, "memory.sqlite");
  // Do not inject a custom documentStore: doing so disables persistentScopeProof.
  const memories = Array.from({ length: input.instances }, () => createGoodMemory({
    storage: { provider: "sqlite", url: database },
    adapters: { assistedExtractor: createDeterministicMemoryExtractor(), embeddingAdapter: createLocalEmbeddingAdapter() },
  }));
  const observer = createSQLiteDocumentStore(database);
  try {
    for (const order of ["forward", "reverse", "rotate"] as const) {
      for (let round = 0; round < 3; round++) {
        const userId = `synthetic-${order}-${round}`;
        const scope = { userId, workspaceId: "tachikoma", agentId: "tachikoma" };
        for (const memory of memories) await memory.exportMemory({ scope });
        let indices = Array.from({ length: input.width }, (_, index) => index);
        if (order === "reverse") indices.reverse();
        if (order === "rotate") indices = [...indices.slice(round + 1), ...indices.slice(0, round + 1)];
        const write = (index: number) => {
          const observedAt = new Date(Date.parse("2026-09-01T00:00:00.000Z") + index).toISOString();
          return memories[index % memories.length]!.remember({
            scope: { ...scope, ...(input.separateWorkspaces ? { workspaceId: `workspace-${index}` } : {}), sessionId: `session-${index}` },
            messages: [
              { id: `turn-${index}:user`, role: "user", content: `请记住项目${index}的代号=Canary${index}。`, observedAt },
              { role: "assistant", content: "Acknowledged.", observedAt },
            ],
            annotations: [{ messageIndex: 1, remember: "always", confirmed: true,
              reason: "runtime-kit selective writeback approved by host annotation and policy" }],
          });
        };
        const outcomes: PromiseSettledResult<Awaited<ReturnType<typeof write>>>[] = [];
        if (input.parallel) outcomes.push(...await Promise.allSettled(indices.map(write)));
        else for (const index of indices) outcomes.push(...await Promise.allSettled([write(index)]));
        expect(outcomes.filter((result) => result.status === "rejected").map((result) => String(result.reason))).toEqual([]);
        const durable = (await memories[0]!.exportMemory({ scope: { userId } })).durable;
        expect(durable.facts).toHaveLength(input.width);
        for (const index of indices) expect(durable.facts.some((fact) => fact.content === `项目${index}的代号=Canary${index}`)).toBe(true);
        expect(durable.evidence).toHaveLength(input.width);
        expect(durable.sourceMessages).toHaveLength(input.width * 2);
        const facts = new Set(durable.facts.map((fact) => fact.id));
        const sources = new Set((durable.sourceMessages ?? []).map((source) => source.id));
        for (const evidence of durable.evidence) {
          expect(evidence.linkedMemoryIds.every((id) => facts.has(id))).toBe(true);
          expect(evidence.sourceRecordIds?.every((id) => sources.has(id))).toBe(true);
        }
        expect(await observer.query(REMEMBER_WRITE_OWNERS_COLLECTION, { kind: "document_write_owner" })).toEqual([]);
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
}

it("stores every supported input serially before testing parallel admission", async () => {
  await runRoundGroup({ instances: 1, width: 16, parallel: false });
}, 30_000);

for (const instances of [1, 2]) {
  for (const width of [2, 4, 8, 16, 32]) {
    it(`preserves ${width} concurrent default-storage writes across ${instances} facade(s) and rotated arrival orders`, async () => {
      await runRoundGroup({ instances, width, parallel: true });
    }, 30_000);
  }
}

it("preserves independent workspaces under the same concurrent load", async () => {
  await runRoundGroup({ instances: 2, width: 16, parallel: true, separateWorkspaces: true });
}, 30_000);
