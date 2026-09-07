import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { resolveRepoRootFromScriptUrl } from "../script-paths";

export const KIMI_PLUGIN_FILES = [
  "LICENSE",
  "integrations/kimi-code/commands/recall.md",
  "integrations/kimi-code/commands/remember.md",
  "integrations/kimi-code/commands/status.md",
  "integrations/kimi-code/commands/trace.md",
  "integrations/kimi-code/skills/using-goodmemory/SKILL.md",
  "kimi.plugin.json",
] as const;

async function readSourceFile(repoRoot: string, path: string): Promise<Buffer> {
  const parts = path.split("/");
  for (let count = 1; count <= parts.length; count += 1) {
    const current = parts.slice(0, count).join("/");
    const entry = await lstat(join(repoRoot, current));
    if (entry.isSymbolicLink()) throw new Error(`Kimi plugin source contains a symlink: ${current}`);
    if (count === parts.length ? !entry.isFile() : !entry.isDirectory()) {
      throw new Error(`Kimi plugin source has an invalid entry: ${current}`);
    }
  }
  return readFile(join(repoRoot, path));
}

/** A small plugin-only ZIP; the separately verified npm tarball owns the runtime. */
export async function buildKimiPluginArchive(input: { outputPath: string; repoRoot: string }) {
  const repoRoot = resolve(input.repoRoot);
  const packageJson = JSON.parse((await readSourceFile(repoRoot, "package.json")).toString("utf8"));
  const material = new Map(await Promise.all(KIMI_PLUGIN_FILES.map(async path =>
    [path, await readSourceFile(repoRoot, path)] as const)));
  const manifest = JSON.parse(material.get("kimi.plugin.json")!.toString("utf8"));
  const server = manifest.mcpServers?.goodmemory;
  if (packageJson.name !== "goodmemory" || !/^0\.(7|8)\.\d+$/u.test(packageJson.version) ||
      manifest.name !== "goodmemory" || manifest.version !== packageJson.version ||
      server?.command !== "npx" || server.args?.[0] !== "-y" ||
      server.args?.[1] !== `goodmemory@${packageJson.version}`) {
    throw new Error("Kimi plugin and npm runtime must match the exact package release identity");
  }
  if (manifest.commands !== "./integrations/kimi-code/commands/" ||
      manifest.skills !== "./integrations/kimi-code/skills/" ||
      manifest.sessionStart?.skill !== "using-goodmemory") {
    throw new Error("Kimi plugin declared paths do not match the release file allowlist");
  }
  const staging = await mkdtemp(join(tmpdir(), "goodmemory-kimi-release-"));
  try {
    const sourceDir = join(staging, "plugin");
    const fixedTime = new Date("1980-01-01T00:00:00Z");
    for (const [path, bytes] of material) {
      const destination = join(sourceDir, path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, bytes, { flag: "wx", mode: 0o644 });
      await chmod(destination, 0o644);
      await utimes(destination, fixedTime, fixedTime);
    }
    const archive = join(staging, "plugin.zip");
    const child = Bun.spawn(["zip", "-X", "-9", archive, ...[...KIMI_PLUGIN_FILES].sort()], {
      cwd: sourceDir,
      env: { ...process.env, TZ: "UTC", ZIPOPT: "" },
      stderr: "pipe",
      stdout: "pipe",
    });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]);
    if (code !== 0) throw new Error(`Kimi plugin ZIP failed (${code}): ${stderr.trim()}`);
    const bytes = await readFile(archive);
    if (bytes.length > 64 * 1024) throw new Error("Kimi plugin ZIP exceeds its 64 KiB file-closure budget");
    const outputPath = resolve(input.outputPath);
    await writeFile(outputPath, bytes, { flag: "wx" });
    return { bytes: bytes.length, outputPath, sha256: createHash("sha256").update(bytes).digest("hex"), version: packageJson.version as string };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    const args = Bun.argv.slice(2);
    if (args.length !== 2 || args[0] !== "--output" || !args[1]?.trim()) {
      throw new Error("Usage: bun scripts/release/kimiPlugin.ts --output <archive.zip>");
    }
    const result = await buildKimiPluginArchive({
      outputPath: args[1],
      repoRoot: resolveRepoRootFromScriptUrl(new URL("../release.ts", import.meta.url).href),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
