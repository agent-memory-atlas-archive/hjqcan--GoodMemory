import { afterEach, describe, expect, it } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { buildKimiPluginArchive, KIMI_PLUGIN_FILES } from "../../scripts/release/kimiPlugin";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "goodmemory-kimi-archive-"));
  roots.push(root);
  const source = join(root, "source");
  await mkdir(source);
  for (const path of ["package.json", ...KIMI_PLUGIN_FILES]) {
    await mkdir(dirname(join(source, path)), { recursive: true });
    await cp(join(import.meta.dir, "../..", path), join(source, path));
  }
  return { root, source };
}

describe("Kimi plugin release ZIP", () => {
  it("packs only declared plugin files deterministically, without source mtimes or unrelated data", async () => {
    const { root, source } = await fixture();
    await writeFile(join(source, ".env"), "MUST_NOT_SHIP=secret-fixture");
    const first = join(root, "first.zip");
    const result = await buildKimiPluginArchive({ outputPath: first, repoRoot: source });
    expect(result.bytes).toBeLessThan(64 * 1024);
    const listing = Bun.spawn(["unzip", "-Z1", first], { stdout: "pipe", stderr: "pipe" });
    expect((await new Response(listing.stdout).text()).trim().split("\n")).toEqual([...KIMI_PLUGIN_FILES].sort());
    expect(await listing.exited).toBe(0);
    for (const path of KIMI_PLUGIN_FILES) await utimes(join(source, path), new Date(), new Date());
    const second = join(root, "second.zip");
    expect((await buildKimiPluginArchive({ outputPath: second, repoRoot: source })).sha256).toBe(result.sha256);
    expect(await readFile(second)).toEqual(await readFile(first));
    await expect(buildKimiPluginArchive({ outputPath: first, repoRoot: source })).rejects.toThrow("EEXIST");
  });

  it.each(["version", "runtime", "commands"])("rejects inconsistent %s identity or declared paths", async (field) => {
    const { root, source } = await fixture();
    const path = join(source, "kimi.plugin.json");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    if (field === "version") manifest.version = "99.0.0";
    if (field === "runtime") manifest.mcpServers.goodmemory.args[1] = "goodmemory@latest";
    if (field === "commands") manifest.commands = "../private";
    await writeFile(path, JSON.stringify(manifest));
    await expect(buildKimiPluginArchive({ outputPath: join(root, "bad.zip"), repoRoot: source })).rejects.toThrow();
  });

  it.each(["file", "parent"])("rejects a symlinked %s in the allowlisted closure", async (kind) => {
    const { root, source } = await fixture();
    const target = join(source, kind === "file" ? "LICENSE" : "integrations/kimi-code/commands");
    const external = join(root, "external");
    await cp(target, external, { recursive: true });
    await rm(target, { recursive: true });
    await symlink(external, target);
    await expect(buildKimiPluginArchive({ outputPath: join(root, "bad.zip"), repoRoot: source })).rejects.toThrow("symlink");
  });

  it("fails if a required command is missing", async () => {
    const { root, source } = await fixture();
    await rm(join(source, "integrations/kimi-code/commands/recall.md"));
    await expect(buildKimiPluginArchive({ outputPath: join(root, "bad.zip"), repoRoot: source })).rejects.toThrow();
  });
});
