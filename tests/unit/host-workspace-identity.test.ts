import { describe, expect, it } from "bun:test";
import { mkdir, readFile, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { bootstrapHostWorkspace } from "../../src/bootstrap/hostBootstrap";
import { resolveWorkspaceId } from "../../src/host/managedFiles";
import { parseWorkspaceHostOptInConfig } from "../../src/install/hostConfigValidation";
import { resolveInstalledHostContext } from "../../src/install/hostExecutionContext";
import { enableHostWorkspace, installHost } from "../../src/install/hostInstall";
import { resolveStandaloneMcpContext } from "../../src/install/standaloneMcpContext";
import { createTempWorkspace } from "../../src/testing/utils";

describe("path-derived workspace identity", () => {
  it("isolates different absolute paths with the same basename", () => {
    const left = resolveWorkspaceId("/synthetic/left/project-a", undefined);
    const right = resolveWorkspaceId("/synthetic/right/project-a", undefined);
    expect(left).not.toBe(right);
    expect(left).toMatch(/^workspace-[a-f0-9]{64}$/u);
    expect(right).toMatch(/^workspace-[a-f0-9]{64}$/u);
  });

  it("normalizes relative paths and dot segments without filesystem access", () => {
    const canonical = resolveWorkspaceId(resolve("project-a"), undefined);
    expect(resolveWorkspaceId("./project-a/../project-a/", undefined)).toBe(canonical);
    expect(resolveWorkspaceId("project-a", undefined)).toBe(canonical);
    expect(resolveWorkspaceId("/", undefined)).toMatch(/^workspace-[a-f0-9]{64}$/u);
  });

  it("preserves explicit shared IDs and derives blank IDs", () => {
    expect(resolveWorkspaceId("/left/project-a", "  shared-project  ")).toBe("shared-project");
    expect(resolveWorkspaceId("/right/project-a", "shared-project")).toBe("shared-project");
    expect(resolveWorkspaceId("/left/project-a", "  ")).toBe(
      resolveWorkspaceId("/left/project-a", undefined),
    );
  });

  it("treats case and symlink spellings as distinct lexical paths", async () => {
    const workspace = await createTempWorkspace("goodmemory-workspace-path-spelling");
    try {
      const physical = join(workspace.root, "physical", "project-a");
      const alias = join(workspace.root, "alias", "project-a");
      await mkdir(physical, { recursive: true });
      await mkdir(join(workspace.root, "alias"));
      await symlink(physical, alias, "dir");
      expect(resolveWorkspaceId(physical, undefined)).not.toBe(resolveWorkspaceId(alias, undefined));
      expect(resolveWorkspaceId("/synthetic/Project-a", undefined)).not.toBe(
        resolveWorkspaceId("/synthetic/project-a", undefined),
      );
    } finally {
      await workspace.cleanup();
    }
  });

  it.each(["codex", "claude"] as const)(
    "uses one identity in %s global, opt-in, standalone and bootstrap paths",
    async (host) => {
      const workspace = await createTempWorkspace(`goodmemory-workspace-identity-${host}`);
      const homeRoot = join(workspace.root, "home");
      const left = join(workspace.root, "left", "project-a");
      const right = join(workspace.root, "right", "project-a");
      try {
        await mkdir(left, { recursive: true });
        await mkdir(right, { recursive: true });
        await installHost({ homeRoot, host, activationMode: "global", userId: "identity-user" });
        const ids = [];
        for (const cwd of [left, right]) {
          const standalone = resolveStandaloneMcpContext({
            storage: { provider: "memory" }, userId: "identity-user",
          }, { cwd });
          const workspaceId = standalone.scope.workspaceId;
          if (workspaceId === undefined) throw new Error("missing standalone workspace identity");
          const global = await resolveInstalledHostContext({ cwd, homeRoot, host });
          expect(global.status).toBe("ok");
          if (global.status !== "ok") throw new Error("missing global context");
          expect(global.context.scope.workspaceId).toBe(workspaceId);
          const installed = await enableHostWorkspace({ homeRoot, host, workspaceRoot: cwd });
          expect(installed.workspaceId).toBe(workspaceId);
          const optIn = await resolveInstalledHostContext({ cwd, homeRoot, host });
          expect(optIn.status).toBe("ok");
          if (optIn.status !== "ok") throw new Error("missing opt-in context");
          expect(optIn.context.scope.workspaceId).toBe(workspaceId);
          const bootstrap = await bootstrapHostWorkspace({ host, userId: "identity-user", workspaceRoot: cwd });
          expect(bootstrap.workspaceId).toBe(workspaceId);
          ids.push(workspaceId);
        }
        expect(ids[0]).not.toBe(ids[1]);

        // Persisted legacy IDs are explicit configuration: never silently
        // retarget them or infer ownership of possibly mixed old records.
        await enableHostWorkspace({ homeRoot, host, workspaceRoot: left, workspaceId: "project-a" });
        await enableHostWorkspace({ homeRoot, host, workspaceRoot: left });
        const configured = JSON.parse(await readFile(join(left, `.goodmemory/${host}.json`), "utf8"));
        expect(configured.workspaceId).toBe("project-a");
        const legacy = await resolveInstalledHostContext({ cwd: left, homeRoot, host });
        expect(legacy.status).toBe("ok");
        if (legacy.status !== "ok") throw new Error("missing legacy context");
        expect(legacy.context.scope.workspaceId).toBe("project-a");
      } finally {
        await workspace.cleanup();
      }
    },
  );

  it("derives missing opt-in IDs consistently but retains stored IDs", () => {
    const root = "/synthetic/left/project-a";
    const implicit = parseWorkspaceHostOptInConfig({ host: "codex" }, "codex", root);
    const explicit = parseWorkspaceHostOptInConfig({ host: "codex", workspaceId: "project-a" }, "codex", root);
    expect(implicit.status).toBe("ok");
    expect(explicit.status).toBe("ok");
    if (implicit.status === "invalid" || explicit.status === "invalid") throw new Error("invalid fixture");
    expect(implicit.config.workspaceId).toBe(resolveWorkspaceId(root, undefined));
    expect(explicit.config.workspaceId).toBe("project-a");
  });
});
