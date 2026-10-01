// Explicit diagnostic; not part of the canonical tests/ root. A failed run
// records known cross-process adapter contention rather than a global guarantee.
import { expect, it } from "bun:test";
import { mkdtemp, rm, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGoodMemory } from "../../src";

for (const processes of [2, 4]) {
  it(`preserves writes from ${processes} independent processes sharing one SQLite database`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "gm-process-concurrent-"));
    const database = join(directory, "memory.sqlite");
    const scope = { userId: "process-synthetic", workspaceId: "tachikoma", agentId: "tachikoma" };
    const memory = createGoodMemory({ storage: { provider: "sqlite", url: database } });
    const children: ReturnType<typeof Bun.spawn>[] = [];
    try {
      await memory.exportMemory({ scope });
      const startPath = join(directory, "start");
      const readyPaths: string[] = [];
      for (let index = 0; index < processes; index++) {
        const readyPath = join(directory, `ready-${index}`);
        readyPaths.push(readyPath);
        children.push(Bun.spawn([process.execPath, join(import.meta.dir, "../../tests/integration/fixtures/default-storage.concurrent-writer.ts")], {
          stdin: new TextEncoder().encode(JSON.stringify({ database, userId: scope.userId, width: 16, offset: index * 16, readyPath, startPath })),
          stdout: "pipe", stderr: "pipe",
        }));
      }
      const deadline = Date.now() + 10_000;
      for (const readyPath of readyPaths) {
        while (!await access(readyPath).then(() => true, () => false)) {
          if (Date.now() > deadline) throw new Error("Child writer did not become ready.");
          await Bun.sleep(5);
        }
      }
      await writeFile(startPath, "start");
      const outputs = await Promise.all(children.map(async (child) => {
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout as ReadableStream).text(),
          new Response(child.stderr as ReadableStream).text(),
          child.exited,
        ]);
        return { stdout, stderr, code };
      }));
      expect(outputs.map(({ code, stderr }) => ({ code, stderr }))).toEqual(outputs.map(() => ({ code: 0, stderr: "" })));
      const outcomes = outputs.flatMap(({ stdout }) => JSON.parse(stdout));
      expect(outcomes.filter((result) => result.status !== "fulfilled")).toEqual([]);
      const durable = (await memory.exportMemory({ scope })).durable;
      expect(durable.facts).toHaveLength(processes * 16);
      expect(durable.evidence).toHaveLength(processes * 16);
    } finally {
      for (const child of children) { if (child.exitCode === null) child.kill(); await child.exited; }
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
}
