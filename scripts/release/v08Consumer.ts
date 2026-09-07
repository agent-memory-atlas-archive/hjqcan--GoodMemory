export const V08_CONSUMER_SMOKE = `
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createGoodMemory } from "goodmemory";

const scope = { userId: "release-consumer", workspaceId: "v08" };
const memory = createGoodMemory({ storage: { provider: "memory" } });
const source = { kind: "pages", pages: [{ path: "policy.md", content: "# Deployment policy\\n\\nPreserve audit history when deploying.\\n" }] };
const dryRun = await memory.importMemory({ scope, source, dryRun: true });
assert.equal(dryRun.outcome, "dry_run");
assert.equal((await memory.exportMemory({ scope })).durable.notes.length, 0);
const imported = await memory.importMemory({ scope, source, expectedSha256: dryRun.inputSha256 });
assert.equal(imported.counts.imported, 1);
const exported = await memory.exportMemory({ scope });
assert.equal(exported.durable.notes.length, 1);
assert.match(exported.durable.notes[0].body, /Preserve audit history/);
assert.equal(exported.pages.manifest.pageCount, 1);
const target = createGoodMemory({ storage: { provider: "memory" } });
await target.importMemory({ scope, source: { kind: "durable", durable: exported.durable } });
assert.deepEqual((await target.exportMemory({ scope })).durable.notes, exported.durable.notes);
await assert.rejects(target.importMemory({ scope, source: { kind: "durable", durable: { ...exported.durable, facts: [{ id: "broken", ...scope }] } } }), /invalid_durable/);
const recalled = await target.recall({ scope, query: "deployment policy audit history" });
assert.equal(recalled.notes[0]?.id, exported.durable.notes[0].id);

const workspaceIdentityRoot = await mkdtemp(join(tmpdir(), "goodmemory-workspace-consumer-"));
try {
  const cli = resolve("node_modules/.bin/goodmemory");
  const left = join(workspaceIdentityRoot, "left", "project-a");
  const right = join(workspaceIdentityRoot, "right", "project-a");
  await mkdir(left, { recursive: true });
  await mkdir(right, { recursive: true });
  function bootstrapIdentity(host, workspaceRoot, workspaceId) {
    return JSON.parse(execFileSync(process.execPath, [
      cli, host, "bootstrap", "--user-id", "workspace-consumer",
      "--workspace-root", workspaceRoot, "--json",
      ...(workspaceId ? ["--workspace-id", workspaceId] : []),
    ], { encoding: "utf8", env: { ...process.env, GOODMEMORY_HOME: join(workspaceIdentityRoot, "home") } })).workspaceId;
  }
  for (const host of ["codex", "claude"]) {
    const leftId = bootstrapIdentity(host, left);
    const rightId = bootstrapIdentity(host, right);
    assert.notEqual(leftId, rightId);
    assert.equal(leftId, "workspace-" + createHash("sha256").update(resolve(left), "utf8").digest("hex"));
    assert.equal(bootstrapIdentity(host, left, "shared-project"), "shared-project");
    assert.equal(bootstrapIdentity(host, right, "shared-project"), "shared-project");
  }
  console.log("V08_WORKSPACE_IDENTITY_OK");
} finally {
  await rm(workspaceIdentityRoot, { recursive: true, force: true });
}
console.log("V08_CONSUMER_OK");
`;
