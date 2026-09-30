import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { createGoodMemory } from "../../src";
import { createNoteMemory, type NoteMemory } from "../../src/domain/records";
import { legacyScopeToKey, scopeToKey, type MemoryScope } from "../../src/domain/scope";
import { derivePageNoteId, normalizePageTitle } from "../../src/interchange/pages";
import { createInMemoryDocumentStore, createInMemorySessionStore } from "../../src/storage/memory";

const NOW = "2026-09-30T00:00:00.000Z";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const legacyNoteId = (scope: MemoryScope, title: string, body: string) => `note_${sha(`${legacyScopeToKey(scope)} title:${normalizePageTitle(title)}`).slice(0, 24)}_${sha(body).slice(0, 8)}`;
function note(scope: MemoryScope, title: string, body: string, id = legacyNoteId(scope, title, body)) {
  return createNoteMemory({ ...scope, id, title, body, format: "markdown", source: { method: "import", extractedAt: NOW }, createdAt: NOW, updatedAt: NOW });
}
function harness() {
  const documentStore = createInMemoryDocumentStore();
  const memory = createGoodMemory({ storage: { provider: "memory" }, adapters: { documentStore, sessionStore: createInMemorySessionStore() } });
  const importPage = (scope: MemoryScope, title: string, body: string) => memory.importMemory({ scope, source: { kind: "pages", pages: [{ path: "page.md", content: `---\ntitle: '${title}'\n---\n${body}` }] } });
  return { documentStore, importPage };
}

describe("legacy imported note identity compatibility", () => {
  it("leaves an identical active legacy note unchanged and supersedes it only for edits", async () => {
    const { documentStore, importPage } = harness();
    const scope = { userId: "reader", workspaceId: "project::a" };
    const original = note(scope, "Runbook", "Original runbook.");
    await documentStore.set("notes", original.id, original);
    const retry = await importPage(scope, original.title, original.body);
    expect(retry.counts.unchanged).toBe(1);
    expect(retry.pages[0]?.memoryId).toBe(original.id);
    const changed = await importPage(scope, original.title, "Edited runbook.");
    expect(changed.counts.superseded).toBe(1);
    expect(changed.pages[0]?.supersededMemoryId).toBe(original.id);
    expect(changed.pages[0]?.memoryId?.startsWith("note_v2_")).toBe(true);
    expect((await documentStore.get<NoteMemory>("notes", original.id))?.supersededBy).toBe(changed.pages[0]?.memoryId);
  });

  it("does not resurrect superseded legacy content when its original page is retried", async () => {
    const { documentStore, importPage } = harness();
    const scope = { userId: "reader", workspaceId: "project" };
    const original = note(scope, "Runbook", "Original runbook.");
    const replacement = note(scope, "Runbook", "Current runbook.");
    await documentStore.set("notes", original.id, createNoteMemory({ ...original, lifecycle: "superseded", supersededBy: replacement.id }));
    await documentStore.set("notes", replacement.id, replacement);
    const retry = await importPage(scope, original.title, original.body);
    expect(retry.counts.unchanged).toBe(1);
    expect(retry.pages[0]?.memoryId).toBe(original.id);
    expect(await documentStore.get("notes", replacement.id)).toEqual(replacement);
    expect(await documentStore.query("notes")).toHaveLength(2);
  });

  it("keeps a colliding legacy full-scope note untouched", async () => {
    const { documentStore, importPage } = harness();
    const left = { userId: "u::team", tenantId: "project" };
    const right = { userId: "u", tenantId: "team::project" };
    expect(legacyScopeToKey(left)).toBe(legacyScopeToKey(right));
    const original = note(left, "Runbook", "Original runbook.");
    await documentStore.set("notes", original.id, original);
    const imported = await importPage(right, original.title, original.body);
    expect(imported.counts.imported).toBe(1);
    expect(imported.pages[0]?.memoryId).not.toBe(original.id);
    expect(await documentStore.get("notes", original.id)).toEqual(original);
  });

  it("separates old and new hash namespaces even when preimages are identical", async () => {
    const { documentStore, importPage } = harness();
    const scope = { userId: "u" };
    const legacyScope = { userId: `${scopeToKey(scope)} title:x` };
    const body = "Stable imported body.";
    const original = note(legacyScope, "y", body);
    await documentStore.set("notes", original.id, original);
    const result = await importPage(scope, "x:::::::: title:y", body);
    expect(result.counts.imported).toBe(1);
    expect(result.pages[0]?.memoryId).not.toBe(original.id);
    expect(await documentStore.get("notes", original.id)).toEqual(original);
  });

  it.each([false, true])("refuses a foreign target ID before any write (dryRun=%s)", async (dryRun) => {
    const documentStore = createInMemoryDocumentStore();
    const memory = createGoodMemory({ storage: { provider: "memory" }, adapters: { documentStore, sessionStore: createInMemorySessionStore() } });
    const scope = { userId: "reader" };
    const title = "Runbook";
    const body = "Imported content.";
    const target = `${derivePageNoteId(scope, { title })}_${sha(body).slice(0, 8)}`;
    const foreign = note({ userId: "another-reader" }, title, body, target);
    await documentStore.set("notes", target, foreign);
    await expect(memory.importMemory({ scope, dryRun, source: { kind: "pages", pages: [{ path: "page.md", content: `---\ntitle: '${title}'\n---\n${body}` }] } })).rejects.toThrow("scope");
    expect(await documentStore.get("notes", target)).toEqual(foreign);
  });
});
