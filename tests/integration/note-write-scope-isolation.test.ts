import { describe, expect, it } from "bun:test";

import { createGoodMemory } from "../../src";
import type { NoteMemory } from "../../src/domain/records";
import { isSameDurableScope } from "../../src/domain/scope";
import type { MemoryScope } from "../../src/domain/scope";
import { buildNoteRememberInput } from "../../src/remember/noteInput";
import {
  createInMemoryDocumentStore,
  createInMemorySessionStore,
  createInMemoryVectorStore,
} from "../../src/storage/memory";
import { createFakeEmbeddingAdapter } from "../../src/testing/fakes";

const TITLE = "Release checklist";
const BODY = "Run the package smoke tests before releasing.";
const REWRITE = "Run the package smoke tests and check the signed manifest.";
const USER_SCOPE = { userId: "note-scope-user" };
const DIMENSIONS = ["tenantId", "workspaceId", "agentId"] as const;

function harness() {
  const documentStore = createInMemoryDocumentStore();
  const vectorStore = createInMemoryVectorStore();
  const memory = createGoodMemory({
    storage: { provider: "memory" },
    adapters: {
      documentStore,
      sessionStore: createInMemorySessionStore(),
      vectorStore,
      embeddingAdapter: createFakeEmbeddingAdapter(),
    },
    testing: { now: () => new Date("2026-09-30T00:00:00.000Z") },
  });
  async function write(kind: "remember" | "import", scope: MemoryScope, body: string) {
    if (kind === "remember") {
      const result = await memory.remember(buildNoteRememberInput({ body, scope, title: TITLE }));
      return result.events[0]?.memoryId;
    }
    const result = await memory.importMemory({
      scope,
      source: { kind: "pages", pages: [{ path: "release.md", content: `---\ntitle: ${TITLE}\n---\n${body}` }] },
    });
    return result.pages[0]?.memoryId;
  }
  return { documentStore, memory, vectorStore, write };
}

describe.each(["remember", "import"] as const)("%s note write scope isolation", (kind) => {
  for (const dimension of DIMENSIONS) {
    it.each([BODY, REWRITE])(`does not merge or supersede a ${dimension}-specific note from a user-wide write: %s`, async (body) => {
      const { documentStore, vectorStore, write } = harness();
      const privateScope = { ...USER_SCOPE, [dimension]: "private" };
      const originalId = await write(kind, privateScope, BODY);
      const before = await documentStore.get<NoteMemory>("notes", originalId!);
      const previousVector = await vectorStore.get("notes", originalId!);

      const writtenId = await write(kind, USER_SCOPE, body);

      expect(writtenId).not.toBe(originalId);
      expect(await documentStore.get("notes", originalId!)).toEqual(before);
      expect(await vectorStore.get("notes", originalId!)).toEqual(previousVector);
      const notes = await documentStore.query<NoteMemory>("notes");
      expect(notes).toHaveLength(2);
      expect(notes.every((note) => note.lifecycle === "active")).toBe(true);
      expect(notes.find((note) => note.id === writtenId)).toMatchObject({ body, ...USER_SCOPE });
      expect(isSameDurableScope(notes.find((note) => note.id === writtenId)!, USER_SCOPE)).toBe(true);
      expect(await vectorStore.get("notes", writtenId!)).not.toBeNull();
    });

    it(`keeps a user-wide note when writing into a specific ${dimension}`, async () => {
      const { documentStore, write } = harness();
      const originalId = await write(kind, USER_SCOPE, BODY);
      const writtenId = await write(kind, { ...USER_SCOPE, [dimension]: "private" }, REWRITE);
      expect(writtenId).not.toBe(originalId);
      expect((await documentStore.query<NoteMemory>("notes")).every((note) => note.lifecycle === "active")).toBe(true);
    });
  }

  it("keeps different users' same-title notes isolated", async () => {
    const { documentStore, write } = harness();
    const originalId = await write(kind, USER_SCOPE, BODY);
    const writtenId = await write(kind, { userId: "another-user" }, REWRITE);
    expect(writtenId).not.toBe(originalId);
    expect((await documentStore.query<NoteMemory>("notes")).every((note) => note.lifecycle === "active")).toBe(true);
  });

  it("recalls each scope's own note after a formerly cross-scope duplicate write", async () => {
    const { memory, write } = harness();
    const workspaceScope = { ...USER_SCOPE, workspaceId: "private-project" };
    const originalId = await write(kind, workspaceScope, BODY);
    const query = "What are the release checklist package smoke tests?";
    const before = await memory.recall({ scope: workspaceScope, query });
    expect(before.notes.map((note) => note.id)).toEqual([originalId!]);

    const writtenId = await write(kind, USER_SCOPE, BODY);
    const sharedRecall = await memory.recall({ scope: USER_SCOPE, query });
    const workspaceRecall = await memory.recall({ scope: workspaceScope, query });

    expect(writtenId).not.toBe(originalId);
    expect(sharedRecall.notes.map((note) => note.id)).toEqual([writtenId!]);
    expect(workspaceRecall.notes).toEqual(before.notes);
    const context = await memory.buildContext({ recall: sharedRecall, output: "markdown" });
    expect(context.content).toContain(BODY);
  });

  it.each([BODY, REWRITE])("retains same-durable-scope note identity across sessions: %s", async (body) => {
    const { documentStore, vectorStore, write } = harness();
    const durableScope = { ...USER_SCOPE, tenantId: "tenant", workspaceId: "workspace", agentId: "agent" };
    const originalId = await write(kind, { ...durableScope, sessionId: "earlier" }, BODY);

    const writtenId = await write(kind, { ...durableScope, sessionId: "later" }, body);

    const notes = await documentStore.query<NoteMemory>("notes");
    const active = notes.filter((note) => note.lifecycle === "active");
    expect(active).toHaveLength(1);
    expect(active[0]?.body).toBe(body);
    if (body === BODY) {
      expect(writtenId).toBe(originalId);
      expect(notes).toHaveLength(1);
      expect(await vectorStore.get("notes", originalId!)).not.toBeNull();
    } else {
      expect(writtenId).not.toBe(originalId);
      expect(await documentStore.get("notes", originalId!)).toMatchObject({ lifecycle: "superseded", supersededBy: writtenId });
      expect(await vectorStore.get("notes", originalId!)).toBeNull();
      expect(await vectorStore.get("notes", writtenId!)).not.toBeNull();
    }
  });
});

describe("page import scope preflight", () => {
  it.each([...DIMENSIONS])("does not report a %s-specific note as unchanged in a user-wide dry run", async (dimension) => {
    const { documentStore, memory, write } = harness();
    await write("import", { ...USER_SCOPE, [dimension]: "private" }, BODY);
    const before = await documentStore.query<NoteMemory>("notes");
    const result = await memory.importMemory({
      scope: USER_SCOPE,
      dryRun: true,
      source: { kind: "pages", pages: [{ path: "release.md", content: `---\ntitle: ${TITLE}\n---\n${BODY}` }] },
    });
    expect(result.counts).toMatchObject({ imported: 1, superseded: 0, unchanged: 0 });
    expect(result.pages[0]?.memoryId).not.toBe(before[0]?.id);
    expect(await documentStore.query("notes")).toEqual(before);
  });
});
