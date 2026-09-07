import { createHash } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

interface ManagedMarker {
  end: string;
  start: string;
}

interface ManagedWriteFileChange {
  action: "created" | "unchanged" | "updated";
  path: string;
  relativePath: string;
}

interface ManagedFileChange {
  action: "created" | "deleted" | "unchanged" | "updated";
  path: string;
  relativePath: string;
}

export function resolveWorkspaceId(
  workspaceRoot: string,
  workspaceId: string | undefined,
): string {
  const normalized = workspaceId?.trim();
  if (normalized && normalized.length > 0) {
    return normalized;
  }

  // Lexical normalization works before a directory exists and keeps symlink
  // and case aliases isolated. Explicit IDs remain the opt-in sharing path.
  const pathFingerprint = createHash("sha256")
    .update(resolve(workspaceRoot), "utf8")
    .digest("hex");
  return `workspace-${pathFingerprint}`;
}

export async function writeManagedFile(
  path: string,
  root: string,
  content: string,
  input?: {
    directoryMode?: number;
    existingContent?: string | null;
    mode?: number;
  },
): Promise<ManagedWriteFileChange> {
  const existing = input?.existingContent ?? await readFileIfPresent(path);
  if (existing === content) {
    await applyManagedFilePermissions(path, input);
    return {
      action: "unchanged",
      path,
      relativePath: relativeToRoot(path, root),
    };
  }

  await mkdir(dirname(path), { recursive: true });
  if (input?.directoryMode !== undefined) {
    await chmod(dirname(path), input.directoryMode);
  }
  await writeFile(path, content, "utf8");
  await applyManagedFilePermissions(path, input);
  return {
    action: existing === null ? "created" : "updated",
    path,
    relativePath: relativeToRoot(path, root),
  };
}

export function buildUnchangedFileChange(
  path: string,
  root: string,
): ManagedFileChange {
  return {
    action: "unchanged",
    path,
    relativePath: relativeToRoot(path, root),
  };
}

export async function writeMarkerManagedFile(
  path: string,
  root: string,
  marker: ManagedMarker,
  section: string,
): Promise<ManagedWriteFileChange> {
  const existing = await readFileIfPresent(path);
  const block = `${marker.start}\n${section.trimEnd()}\n${marker.end}\n`;
  let nextContent = block;

  if (existing !== null) {
    const markerState = detectMarkerState(existing, marker);
    if (markerState === "balanced") {
      const pattern = new RegExp(
        `${escapeRegExp(marker.start)}[\\s\\S]*?${escapeRegExp(marker.end)}\\n?`,
        "m",
      );
      nextContent = existing.replace(pattern, block);
    } else if (markerState === "absent") {
      const separator = existing.endsWith("\n") ? "\n" : "\n\n";
      nextContent = `${existing}${separator}${block}`;
    } else {
      throw buildInvalidManagedConfigError(
        relativeToRoot(path, root),
        "the managed install block is malformed",
      );
    }
  }

  return writeManagedFile(path, root, nextContent, {
    existingContent: existing,
  });
}

export async function removeMarkerManagedFile(
  path: string,
  root: string,
  marker: ManagedMarker,
): Promise<ManagedFileChange> {
  const existing = await readFileIfPresent(path);
  if (existing === null) {
    return buildUnchangedFileChange(path, root);
  }
  const markerState = detectMarkerState(existing, marker);
  if (markerState === "absent") {
    return buildUnchangedFileChange(path, root);
  }
  if (markerState === "malformed") {
    throw buildInvalidManagedConfigError(
      relativeToRoot(path, root),
      "the managed install block is malformed",
    );
  }

  const pattern = new RegExp(
    `${escapeRegExp(marker.start)}[\\s\\S]*?${escapeRegExp(marker.end)}\\n?`,
    "m",
  );
  const stripped = existing
    .replace(pattern, "")
    .replace(/\n{3,}/gu, "\n\n");

  if (stripped.trim().length === 0) {
    await rm(path, { force: true });
    return {
      action: "deleted",
      path,
      relativePath: relativeToRoot(path, root),
    };
  }

  return writeManagedFile(path, root, stripped, {
    existingContent: existing,
  });
}

export function buildInvalidManagedConfigError(path: string, detail: string): Error {
  return new Error(
    `Refusing to overwrite existing ${path}: ${detail}. Remove or fix the managed config, then rerun the GoodMemory command.`,
  );
}

function detectMarkerState(
  content: string,
  marker: ManagedMarker,
): "absent" | "balanced" | "malformed" {
  const startCount = countOccurrences(content, marker.start);
  const endCount = countOccurrences(content, marker.end);

  if (startCount === 0 && endCount === 0) {
    return "absent";
  }
  if (startCount === 1 && endCount === 1) {
    const startIndex = content.indexOf(marker.start);
    const endIndex = content.indexOf(marker.end);
    return startIndex >= 0 && endIndex > startIndex ? "balanced" : "malformed";
  }

  return "malformed";
}

export function relativeToRoot(path: string, root: string): string {
  const normalizedRoot = resolve(root);
  return path.startsWith(`${normalizedRoot}/`)
    ? path.slice(normalizedRoot.length + 1)
    : path;
}

async function readFileIfPresent(path: string): Promise<string | null> {
  try {
    return await Bun.file(path).text();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function applyManagedFilePermissions(
  path: string,
  input:
    | {
        directoryMode?: number;
        mode?: number;
      }
    | undefined,
): Promise<void> {
  if (input?.directoryMode !== undefined) {
    await chmod(dirname(path), input.directoryMode);
  }
  if (input?.mode !== undefined) {
    await chmod(path, input.mode);
  }
}

function countOccurrences(content: string, pattern: string): number {
  return content.match(new RegExp(escapeRegExp(pattern), "gu"))?.length ?? 0;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
