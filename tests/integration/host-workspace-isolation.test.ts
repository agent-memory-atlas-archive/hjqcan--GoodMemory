import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { describe, expect, it } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createGoodMemory } from "../../src";
import { resolveWorkspaceId } from "../../src/host/managedFiles";
import { createTempWorkspace } from "../../src/testing/utils";

describe("default workspace isolation through standalone MCP", () => {
  it("isolates same-name workspace writes, recalls and deletion in shared SQLite without migrating legacy records", async () => {
    const temporary = await createTempWorkspace("goodmemory-mcp-workspace-isolation");
    const userId = "workspace-isolation-user";
    const sqlitePath = join(temporary.root, "memory.sqlite");
    const left = join(temporary.root, "left", "project-a");
    const right = join(temporary.root, "right", "project-a");
    const legacyScope = { userId, workspaceId: "project-a" };
    const leftScope = { userId, workspaceId: resolveWorkspaceId(left, undefined) };
    const rightScope = { userId, workspaceId: resolveWorkspaceId(right, undefined) };
    const transports: StdioClientTransport[] = [];
    const memory = createGoodMemory({ storage: { provider: "sqlite", url: sqlitePath } });
    const inheritedEnv = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] =>
        entry[1] !== undefined && !entry[0].startsWith("GOODMEMORY_"),
      ),
    );
    async function connect(workspaceId?: string) {
      const transport = new StdioClientTransport({
        args: [
          "--env-file=/dev/null",
          join(import.meta.dir, "../../scripts/goodmemory-mcp.ts"),
          "--standalone", "--user-id", userId,
          "--storage-provider", "sqlite", "--storage-url", sqlitePath,
          "--allow-write",
          ...(workspaceId ? ["--workspace-id", workspaceId] : []),
        ],
        command: process.execPath,
        cwd: left,
        env: { ...inheritedEnv, GOODMEMORY_HOME: join(temporary.root, "home") },
        stderr: "pipe",
      });
      transports.push(transport);
      const client = new Client({ name: "workspace-isolation-regression", version: "0.0.0" }, { capabilities: {} });
      await client.connect(transport);
      return client;
    }
    async function recall(client: Client, cwd: string) {
      const result = await client.callTool({
        name: "goodmemory_get_context",
        arguments: { cwd, query: "What is the deployment policy?", maxTokens: 2048, output: "markdown" },
      });
      expect(result.isError ?? false).toBe(false);
      return result.structuredContent as { content: string; scope: { workspaceId: string } };
    }
    try {
      await mkdir(left, { recursive: true });
      await mkdir(right, { recursive: true });
      await memory.importMemory({
        scope: legacyScope,
        source: { kind: "pages", pages: [{ path: "legacy.md", content: "# Deployment policy\n\nLegacy mixed workspace policy: preserve for explicit reconciliation." }] },
      });
      const client = await connect();
      for (const [cwd, body] of [
        [left, "Deployment policy for the left workspace: require amber approval."],
        [right, "Deployment policy for the right workspace: require indigo approval."],
      ] as const) {
        const result = await client.callTool({
          name: "goodmemory_write_note",
          arguments: { cwd, title: "Deployment policy", body },
        });
        expect(result.isError ?? false).toBe(false);
        expect(result.structuredContent).toHaveProperty("accepted", 1);
      }
      const leftRecall = await recall(client, left);
      const rightRecall = await recall(client, right);
      expect(leftRecall.scope.workspaceId).not.toBe(rightRecall.scope.workspaceId);
      expect(leftRecall.content).toContain("amber approval");
      expect(leftRecall.content).not.toContain("indigo approval");
      expect(rightRecall.content).toContain("indigo approval");
      expect(rightRecall.content).not.toContain("amber approval");
      expect(leftRecall.content).not.toContain("Legacy mixed workspace");
      expect(rightRecall.content).not.toContain("Legacy mixed workspace");
      expect((await memory.exportMemory({ scope: leftScope })).durable.notes).toHaveLength(1);
      expect((await memory.exportMemory({ scope: rightScope })).durable.notes).toHaveLength(1);

      // An explicit ID is the intentional sharing/recovery mechanism.
      const shared = await connect(leftScope.workspaceId);
      const sharedRecall = await recall(shared, right);
      expect(sharedRecall.scope.workspaceId).toBe(leftScope.workspaceId);
      expect(sharedRecall.content).toContain("amber approval");
      expect(sharedRecall.content).not.toContain("indigo approval");

      await memory.deleteAllMemory({ scope: rightScope });
      expect((await memory.exportMemory({ scope: rightScope })).durable.notes).toEqual([]);
      expect((await memory.exportMemory({ scope: leftScope })).durable.notes).toHaveLength(1);
      expect((await recall(client, left)).content).toContain("amber approval");
      expect((await recall(client, right)).content).not.toContain("indigo approval");
      const legacy = (await memory.exportMemory({ scope: legacyScope })).durable.notes;
      expect(legacy).toHaveLength(1);
      expect(legacy?.[0]?.body).toContain("Legacy mixed workspace");
    } finally {
      for (const transport of transports) await transport.close();
      await temporary.cleanup();
    }
  }, 30_000);
});
