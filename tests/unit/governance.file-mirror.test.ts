import { describe, expect, it } from "bun:test";
import type { MemoryScope } from "../../src/domain/scope";
import type {
  FileMirrorExport,
  FileMirrorFsPort,
  FileMirrorTimers,
} from "../../src/governance/fileMirror";
import type { GoodMemoryTraceSpan } from "../../src/observability/contracts";
import { createGoodMemoryTracer } from "../../src/observability/tracer";
import {
  createFileMirror,
  toDurableMirrorScope,
} from "../../src/governance/fileMirror";

const ROOT = "/ws/.goodmemory/memory";
const BOUND: MemoryScope = { userId: "u-1", workspaceId: "ws-a" };
const scope: MemoryScope = { userId: "u-1", workspaceId: "ws-a", sessionId: "s-1" };

function bundle(memoryText: string): FileMirrorExport {
  return {
    artifacts: {
      files: [
        { content: "# User Memory\n", kind: "user", relativePath: "user.md" },
        { content: memoryText, kind: "memory", relativePath: "MEMORY.md" },
        { content: "# Facts\n", kind: "topic", relativePath: "topics/facts.md" },
      ],
      rootPath: ".goodmemory/users/u-1/workspaces/ws-a",
    },
    pages: {
      files: [
        { bytes: 10, content: "# Pages\n\n(no pages)\n", kind: "listing", relativePath: "pages/listing.md", sha256: "x" },
      ],
      manifest: { files: [], format: "goodmemory.pages/v1", pageCount: 0, pagesSha256: "y" },
      rootPath: "pages",
    },
  };
}

function fakeFs(options: { failSwap?: boolean; failWrite?: boolean; failRestore?: boolean; failCleanup?: boolean; failRetiredCleanup?: boolean; rootPresent?: boolean } = {}) {
  const calls: string[] = [];
  const written = new Map<string, string>();
  let rootPresent = options.rootPresent ?? false;
  const fs: FileMirrorFsPort = {
    async mkdir(path) {
      calls.push(`mkdir ${path}`);
    },
    async rename(from, to) {
      calls.push(`rename ${from} -> ${to}`);
      if (options.failRestore && from.includes(".old-")) {
        throw new Error("restore denied");
      }
      if (from === ROOT && !rootPresent) {
        const error = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      if (to === ROOT && options.failSwap && from.includes(".tmp-")) {
        const error = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      if (to === ROOT) {
        rootPresent = true;
      }
      if (from === ROOT) {
        rootPresent = false;
      }
    },
    async rm(path) {
      calls.push(`rm ${path}`);
      if (options.failCleanup && path.includes(".tmp-")) {
        throw new Error("cleanup denied");
      }
      if (options.failRetiredCleanup && path.includes(".old-")) {
        throw new Error("retired cleanup denied");
      }
    },
    async writeFile(path, content) {
      if (options.failWrite) {
        throw new Error("disk full");
      }
      calls.push(`write ${path}`);
      written.set(path, content);
    },
  };
  return { calls, fs, written };
}

function fakeTimers() {
  const queue: Array<{ callback: () => void; id: number }> = [];
  let next = 1;
  const timers: FileMirrorTimers = {
    clearTimeout(handle) {
      const index = queue.findIndex((entry) => entry.id === handle);
      if (index >= 0) {
        queue.splice(index, 1);
      }
    },
    setTimeout(callback) {
      const id = next;
      next += 1;
      queue.push({ callback, id });
      return id;
    },
  };
  return {
    fire() {
      for (const entry of queue.splice(0)) {
        entry.callback();
      }
    },
    get pendingCount() {
      return queue.length;
    },
    timers,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("file mirror", () => {
  it.each([
    { label: "restoration", options: { failSwap: true, failRestore: true }, previous: true, staging: false },
    { label: "staging cleanup", options: { failWrite: true, failCleanup: true }, previous: false, staging: true },
    { label: "restoration and cleanup", options: { failSwap: true, failRestore: true, failCleanup: true }, previous: true, staging: true },
    { label: "retired tree cleanup", options: { failRetiredCleanup: true }, previous: true, staging: false },
  ])("exposes recovery paths but not raw errors in the $label failure trace", async ({ options, previous, staging }) => {
    const spans: GoodMemoryTraceSpan[] = [];
    const { fs } = fakeFs({ ...options, rootPresent: true });
    const mirror = createFileMirror({
      config: { root: ROOT, scope: BOUND },
      exportMemory: async () => bundle("private note body"),
      fs,
      timers: fakeTimers().timers,
      tracer: createGoodMemoryTracer({ traceSink: { emit: (span) => { spans.push(span); } } }, () => new Date()),
    });
    mirror.schedule(scope);
    await expect(mirror.flush()).resolves.toBeUndefined();
    const failure = spans.find((span) => span.status === "failed");
    expect(failure?.attributes?.retainedPreviousRoot).toEqual(previous ? expect.stringMatching(/\.old-/u) : undefined);
    expect(failure?.attributes?.retainedStagingRoot).toEqual(staging ? expect.stringMatching(/\.tmp-/u) : undefined);
    expect(JSON.stringify(spans)).not.toContain("denied");
    expect(JSON.stringify(spans)).not.toContain("private note body");
  });

  it("reports swap and restoration failures with the retained recovery path", async () => {
    const { calls, fs } = fakeFs({ failRestore: true, failSwap: true, rootPresent: true });
    const failures: unknown[] = [];
    const mirror = createFileMirror({ config: { root: ROOT, scope: BOUND }, exportMemory: async () => bundle("old"), fs, onFailure: error => failures.push(error), timers: fakeTimers().timers });
    mirror.schedule(scope);
    await mirror.flush();
    expect(failures[0]).toBeInstanceOf(AggregateError);
    const failure = failures[0] as AggregateError;
    expect(failure.errors.map((error: Error) => error.message)).toEqual(["EACCES: permission denied", "restore denied"]);
    const recovery = calls.find(call => call.startsWith(`rename ${ROOT} -> `))!.split(" -> ")[1]!;
    expect(failure.message).toContain(recovery);
    expect(calls).not.toContain(`rm ${recovery}`);
    expect(calls.some(call => call.startsWith(`rm ${ROOT}.tmp-`))).toBe(true);
  });

  it("reports staging cleanup failure alongside the original write error", async () => {
    const { fs } = fakeFs({ failCleanup: true, failWrite: true });
    const failures: unknown[] = [];
    const mirror = createFileMirror({ config: { root: ROOT, scope: BOUND }, exportMemory: async () => bundle("old"), fs, onFailure: error => failures.push(error), timers: fakeTimers().timers });
    mirror.schedule(scope);
    await mirror.flush();
    expect(failures[0]).toBeInstanceOf(AggregateError);
    expect((failures[0] as AggregateError).errors.map((error: Error) => error.message)).toEqual(["disk full", "cleanup denied"]);
  });

  it("strips the session refinement from the mirrored scope", () => {
    expect(toDurableMirrorScope(scope)).toEqual({ userId: "u-1", workspaceId: "ws-a" });
  });

  it("coalesces mutations per durable scope and swaps the root with two renames", async () => {
    const { calls, fs, written } = fakeFs();
    const clock = fakeTimers();
    const exportCalls: unknown[] = [];
    const mirror = createFileMirror({
      config: { debounceMs: 50, root: ROOT, scope: BOUND },
      exportMemory: async (input) => {
        exportCalls.push(input);
        return bundle("# MEMORY\n- fact 1\n");
      },
      fs,
      now: () => new Date(1_700_000_000_000),
      timers: clock.timers,
    });

    mirror.schedule(scope);
    mirror.schedule({ ...scope, sessionId: "s-2" });
    expect(clock.pendingCount).toBe(1);
    expect(exportCalls).toHaveLength(0);

    clock.fire();
    await settle();
    await mirror.flush();

    expect(exportCalls).toEqual([{ includeRuntime: false, scope: { userId: "u-1", workspaceId: "ws-a" } }]);
    const staging = calls.find((call) => call.startsWith("mkdir "))!.slice("mkdir ".length);
    expect(staging).toMatch(/^\/ws\/\.goodmemory\/memory\.tmp-[0-9a-z]+-1$/);
    expect(written.get(`${staging}/MEMORY.md`)).toBe("# MEMORY\n- fact 1\n");
    expect(written.get(`${staging}/topics/facts.md`)).toBe("# Facts\n");
    expect(written.get(`${staging}/pages/listing.md`)).toBe("# Pages\n\n(no pages)\n");
    expect(calls.filter((call) => call.startsWith("rename "))).toEqual([
      `rename ${ROOT} -> ${ROOT}.old-${staging.slice(`${ROOT}.tmp-`.length)}`,
      `rename ${staging} -> ${ROOT}`,
    ]);
    expect(calls.some((call) => call.startsWith("rm "))).toBe(false);

    mirror.schedule(scope);
    clock.fire();
    await mirror.flush();
    expect(exportCalls).toHaveLength(2);
    const retired = calls.filter((call) => call.startsWith("rm "));
    expect(retired).toEqual([expect.stringMatching(/^rm \/ws\/\.goodmemory\/memory\.old-[0-9a-z]+-2$/)]);
  });

  it("regenerates once more when a mutation lands during an in-flight write", async () => {
    const { fs } = fakeFs();
    const clock = fakeTimers();
    let release: (() => void) | undefined;
    let exportCount = 0;
    const mirror = createFileMirror({
      config: { debounceMs: 0, root: ROOT, scope: BOUND },
      exportMemory: async () => {
        exportCount += 1;
        if (exportCount === 1) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return bundle(`# MEMORY ${exportCount}\n`);
      },
      fs,
      timers: clock.timers,
    });

    mirror.schedule(scope);
    clock.fire();
    await settle();
    expect(exportCount).toBe(1);

    mirror.schedule(scope);
    clock.fire();
    await settle();
    expect(exportCount).toBe(1);

    release!();
    await mirror.flush();
    expect(exportCount).toBe(2);
  });

  it("reports failures through the callback and never rejects", async () => {
    const { fs } = fakeFs({ failWrite: true });
    const clock = fakeTimers();
    const failures: Array<{ error: unknown; scope: MemoryScope }> = [];
    const mirror = createFileMirror({
      config: { root: ROOT, scope: BOUND },
      exportMemory: async () => bundle("# MEMORY\n"),
      fs,
      onFailure: (error, failedScope) => failures.push({ error, scope: failedScope }),
      timers: clock.timers,
    });

    mirror.schedule(scope);
    await expect(mirror.flush()).resolves.toBeUndefined();
    expect(failures).toHaveLength(1);
    expect((failures[0]!.error as Error).message).toBe("disk full");
    expect(failures[0]!.scope).toEqual({ userId: "u-1", workspaceId: "ws-a" });
  });

  it("flushes pending work without waiting for the debounce timer", async () => {
    const { written, fs } = fakeFs();
    const clock = fakeTimers();
    let exportCount = 0;
    const mirror = createFileMirror({
      config: { debounceMs: 10_000, root: ROOT, scope: BOUND },
      exportMemory: async () => {
        exportCount += 1;
        return bundle("# MEMORY\n");
      },
      fs,
      timers: clock.timers,
    });

    mirror.schedule({ ...scope, agentId: "claude" });
    mirror.schedule({ ...scope, agentId: "codex", sessionId: "s-9" });
    await mirror.flush();

    expect(exportCount).toBe(1);
    expect(clock.pendingCount).toBe(0);
    expect([...written.keys()].filter((path) => path.endsWith("/MEMORY.md"))).toHaveLength(1);
    await mirror.flush();
    expect(exportCount).toBe(1);
  });

  it("mirrors overlapping mutations but always exports only the bound durable scope", async () => {
    const { fs, written } = fakeFs();
    const clock = fakeTimers();
    const exportScopes: MemoryScope[] = [];
    const mirror = createFileMirror({
      config: { debounceMs: 0, root: ROOT, scope: { ...BOUND, sessionId: "ignored" } },
      exportMemory: async (input) => {
        exportScopes.push(input.scope);
        return bundle("# MEMORY\n");
      },
      fs,
      timers: clock.timers,
    });

    mirror.schedule({ userId: "u-2", workspaceId: "ws-a" });
    mirror.schedule({ userId: "u-1", workspaceId: "ws-b" });
    await mirror.flush();
    expect(exportScopes).toEqual([]);
    expect(written.size).toBe(0);
    expect(clock.pendingCount).toBe(0);

    mirror.schedule({ userId: "u-1" });
    await mirror.flush();
    expect(exportScopes).toEqual([BOUND]);

    mirror.schedule({ userId: "u-1", workspaceId: "ws-a", agentId: "codex", sessionId: "s-3" });
    await mirror.flush();
    expect(exportScopes).toEqual([BOUND, BOUND]);
    expect(mirror.root).toBe(ROOT);
  });

  it("restores the previous root and removes the staging tree when the swap fails", async () => {
    const { calls, fs } = fakeFs({ failSwap: true, rootPresent: true });
    const clock = fakeTimers();
    const failures: unknown[] = [];
    const mirror = createFileMirror({
      config: { debounceMs: 0, root: ROOT, scope: BOUND },
      exportMemory: async () => bundle("# MEMORY\n"),
      fs,
      onFailure: (error) => failures.push(error),
      timers: clock.timers,
    });

    mirror.schedule(scope);
    await mirror.flush();
    const staging = calls.find((call) => call.startsWith("mkdir "))!.slice("mkdir ".length);
    expect(calls.filter((call) => call.startsWith("rename ") || call.startsWith("rm "))).toEqual([
      `rename ${ROOT} -> ${ROOT}.old-${staging.slice(`${ROOT}.tmp-`.length)}`,
      `rename ${staging} -> ${ROOT}`,
      `rename ${ROOT}.old-${staging.slice(`${ROOT}.tmp-`.length)} -> ${ROOT}`,
      `rm ${staging}`,
    ]);
    expect(failures).toHaveLength(1);
    expect((failures[0] as Error).message).toBe("EACCES: permission denied");
  });
});
