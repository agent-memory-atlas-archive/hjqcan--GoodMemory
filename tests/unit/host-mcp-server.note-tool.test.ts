import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as z from "zod/v4";
import { createGoodMemory } from "../../src";
import type { GoodMemoryConfig } from "../../src";
import type { GoodMemoryMcpServerDependencies } from "../../src/install/hostMcpServer";
import { createGoodMemoryMcpServer } from "../../src/install/hostMcpServer";

const WORKSPACE_ROOT = "/tmp/goodmemory-note-tool-workspace";
const BODY = "# Reading MediaWiki\n\nMost MediaWiki sites expose api.php.\n";

interface InspectableTool {
  description?: string;
  handler: (args: Record<string, unknown>) => Promise<{
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
  }>;
  inputSchema?: z.ZodType;
}

function inspectServer(server: object): { _registeredTools: Record<string, InspectableTool | undefined> } {
  return server as unknown as { _registeredTools: Record<string, InspectableTool | undefined> };
}

function runtimeConfig(): string {
  return JSON.stringify({
    activationMode: "global",
    host: "codex",
    maxTokens: 64,
    retrievalProfile: "coding_agent",
    storage: { provider: "memory", url: "memory://note-tool" },
    userId: "mcp-user",
    version: 1,
    writeback: {
      allowAssistantOutput: "confirmed_or_verified",
      dryRun: false,
      maxChars: 12_000,
      maxMessages: 12,
      minConfidence: 0.7,
      mode: "off",
      persistRawTranscript: false,
    },
  });
}

function createDependencies(homeRoot: string): GoodMemoryMcpServerDependencies {
  let memory: ReturnType<typeof createGoodMemory> | undefined;
  return {
    createMemory: (config: GoodMemoryConfig) => {
      memory ??= createGoodMemory({ ...config, storage: { provider: "memory" } });
      return memory;
    },
    homeRoot,
    readFile: async (path: string) => {
      if (path === `${WORKSPACE_ROOT}/.goodmemory/codex.json`) {
        return JSON.stringify({ enabled: true, host: "codex", workspaceId: "mcp-workspace" });
      }
      if (path.endsWith("/.goodmemory/codex.json")) {
        return runtimeConfig();
      }
      throw Object.assign(new Error(`missing ${path}`), { code: "ENOENT" as const });
    },
  };
}

describe("goodmemory_write_note MCP tool", () => {
  it("accepts null only for optional wire inputs and normalizes it before handlers", () => {
    const server = inspectServer(createGoodMemoryMcpServer({
      allowWrite: true,
      standalone: { userId: "nullable-schema-test", storage: { provider: "memory" } },
    }));
    const requiredInputs: Record<string, Record<string, unknown>> = {
      goodmemory_get_context: { query: "project storage" },
      goodmemory_get_records: { recordRefs: ["gm:fact:example"] },
      goodmemory_inspect_memory: {},
      goodmemory_read_artifacts: {},
      goodmemory_remember: { content: "Use PostgreSQL for project storage." },
      goodmemory_search_index: { query: "project storage" },
      goodmemory_stats: {},
      goodmemory_timeline: { query: "project storage" },
      goodmemory_trace_recall: { query: "project storage" },
      goodmemory_write_note: { body: BODY, title: "MediaWiki" },
    };
    for (const [name, tool] of Object.entries(server._registeredTools)) {
      const schema = tool!.inputSchema!;
      const wire = z.toJSONSchema(schema, { io: "input" });
      const optional = Object.keys(wire.properties ?? {}).filter((key) => !wire.required?.includes(key));
      const parsed = schema.safeParse({ ...requiredInputs[name], ...Object.fromEntries(optional.map((key) => [key, null])) });
      expect(parsed.success, name).toBe(true);
      if (!parsed.success) continue;
      for (const key of optional) expect((parsed.data as Record<string, unknown>)[key], `${name}.${key}`).toBeUndefined();
      for (const key of wire.required ?? []) {
        expect(schema.safeParse({ ...requiredInputs[name], [key]: null }).success, `${name}.${key}`).toBe(false);
      }
    }
  });

  it("tells recall callers to omit unspecified temporal controls", () => {
    const server = inspectServer(createGoodMemoryMcpServer({
      standalone: { userId: "temporal-schema-test", storage: { provider: "memory" } },
    }));
    for (const name of ["goodmemory_get_context", "goodmemory_trace_recall", "goodmemory_search_index"]) {
      const schema = z.toJSONSchema(server._registeredTools[name]!.inputSchema!, { io: "input" });
      for (const key of ["referenceTime", "timezone"]) {
        const property = schema.properties?.[key];
        expect(typeof property === "object" ? property.description : undefined).toContain("Omit");
        expect(schema.required).not.toContain(key);
      }
    }
  });

  it("tells callers to omit unknown write timestamps instead of inventing dates", async () => {
    const server = inspectServer(createGoodMemoryMcpServer({
      allowWrite: true,
      standalone: { userId: "temporal-schema-test", storage: { provider: "memory" } },
    }));
    for (const name of ["goodmemory_remember", "goodmemory_write_note"]) {
      const schema = z.toJSONSchema(server._registeredTools[name]!.inputSchema!, { io: "input" });
      const observedAt = schema.properties?.observedAt;
      expect(observedAt).toHaveProperty("anyOf", [{ type: "string" }, { type: "null" }]);
      const description = typeof observedAt === "object" ? observedAt.description : undefined;
      expect(description).toContain("RFC 3339");
      expect(description).toContain("Omit");
      expect(description).toContain("date-only");
      expect(schema.required).not.toContain("observedAt");
    }
  });

  it("is registered only when writes are allowed", async () => {
    const homeRoot = await mkdtemp(join(tmpdir(), "goodmemory-note-tool-"));
    try {
      const readOnly = inspectServer(createGoodMemoryMcpServer({ dependencies: createDependencies(homeRoot), host: "codex" }));
      expect(readOnly._registeredTools.goodmemory_write_note).toBeUndefined();

      const writable = inspectServer(createGoodMemoryMcpServer({ allowWrite: true, dependencies: createDependencies(homeRoot), host: "codex" }));
      expect(writable._registeredTools.goodmemory_write_note?.description).toContain("page");
    } finally {
      await rm(homeRoot, { force: true, recursive: true });
    }
  });

  it("writes a verbatim note, supersedes on rewrite, and exposes the note through get_context", async () => {
    const homeRoot = await mkdtemp(join(tmpdir(), "goodmemory-note-tool-"));
    try {
      const server = inspectServer(createGoodMemoryMcpServer({ allowWrite: true, dependencies: createDependencies(homeRoot), host: "codex" }));
      const tool = server._registeredTools.goodmemory_write_note!;

      const first = await tool.handler({ body: BODY, cwd: WORKSPACE_ROOT, sessionId: "sess-1", title: "Reading MediaWiki sites as an agent" });
      expect(first.isError).toBeUndefined();
      expect(first.structuredContent).toMatchObject({ outcome: "written", memoryType: "note" });
      expect(typeof first.structuredContent?.noteId).toBe("string");

      const second = await tool.handler({ body: `${BODY}\nPrefer the REST summary endpoint.\n`, cwd: WORKSPACE_ROOT, sessionId: "sess-1", title: "Reading MediaWiki sites as an agent" });
      expect(second.structuredContent).toMatchObject({ outcome: "superseded", memoryType: "note" });

      const context = await server._registeredTools.goodmemory_get_context!.handler({ cwd: WORKSPACE_ROOT, output: "markdown", query: "How do MediaWiki sites expose api.php?" });
      expect(String(context.structuredContent?.content)).toContain("## Notes");
      expect(String(context.structuredContent?.content)).toContain("Prefer the REST summary endpoint.");
    } finally {
      await rm(homeRoot, { force: true, recursive: true });
    }
  });

  it("rejects an oversize body at the schema and accepts a note kind hint on goodmemory_remember", async () => {
    const homeRoot = await mkdtemp(join(tmpdir(), "goodmemory-note-tool-"));
    try {
      const server = inspectServer(createGoodMemoryMcpServer({ allowWrite: true, dependencies: createDependencies(homeRoot), host: "codex" }));
      const schema = server._registeredTools.goodmemory_write_note!.inputSchema!;
      expect(schema.safeParse({ body: "x".repeat(8193), cwd: WORKSPACE_ROOT, title: "Too big" }).success).toBe(false);
      expect(schema.safeParse({ body: "x".repeat(8192), cwd: WORKSPACE_ROOT, title: "Fits" }).success).toBe(true);

      const remembered = await server._registeredTools.goodmemory_remember!.handler({ content: BODY, cwd: WORKSPACE_ROOT, kindHint: "note" });
      expect(remembered.structuredContent?.accepted).toBe(1);
      expect((remembered.structuredContent?.events as Array<{ memoryType: string }>)[0]?.memoryType).toBe("note");
    } finally {
      await rm(homeRoot, { force: true, recursive: true });
    }
  });
});
