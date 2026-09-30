import { describe, expect, it } from "bun:test";
import { createGoodMemory, createInMemoryDocumentStore, createInMemorySessionStore, createLanguageService } from "../../src";
import { ingestHostAgentEvent } from "../../src/host";
import { createEvolutionRuntime } from "../../src/api/evolutionRuntime";
import { createMemoryRepositories } from "../../src/storage/repositories";
import { legacyScopeToKey, scopeToKey, type MemoryScope } from "../../src/domain/scope";
import type { DocumentStore } from "../../src/storage/contracts";

async function makeLegacy(store: DocumentStore, scope: MemoryScope, owner = scope) {
  const replacements = new Map<string, string>();
  for (const collection of ["evidence", "experiences"]) {
    const rows = await store.query<{ id: string; linkedEvidenceIds?: string[] }>(collection);
    for (const row of rows) {
      const legacyId = row.id.replace(encodeURIComponent(scopeToKey(scope)), encodeURIComponent(legacyScopeToKey(scope)));
      replacements.set(row.id, legacyId);
      await store.delete(collection, row.id);
      await store.set(collection, legacyId, { ...row, ...owner, id: legacyId,
        ...(row.linkedEvidenceIds ? { linkedEvidenceIds: row.linkedEvidenceIds.map((id) => replacements.get(id) ?? id) } : {}),
      });
    }
  }
}

const scope = { userId: "scope-key-user", tenantId: "tenant", sessionId: "s" };
const event = { surface: "host", kind: "tool_result", eventId: "event-1", runId: "r", turnId: "t", sequence: 0,
  occurredAt: "2026-04-22T00:00:00.000Z", hostKind: "codex", scope, toolName: "check", outcome: "timeout", excerpt: "Endpoint probe timed out." } as const;

function fixture() {
  const documentStore = createInMemoryDocumentStore();
  const sessionStore = createInMemorySessionStore();
  const memory = createGoodMemory({ adapters: { documentStore, sessionStore }, storage: { provider: "memory" } });
  const runtime = createEvolutionRuntime({
    compiler: { async compile() { return { compiledCount: 0 }; } },
    dreamMaintenance: { async run() { throw new Error("unused"); } },
    governanceRepositories: createMemoryRepositories({ documentStore, sessionStore }),
    language: createLanguageService(), now: () => "2026-04-02T00:00:00.000Z",
    proposalGate: { async process() { return []; } }, reviewer: { async review() { return []; } },
  });
  return { documentStore, memory, runtime };
}

describe("scoped event identity upgrades", () => {
  it("recognizes legacy event receipts by verified full scope", async () => {
    const { documentStore, memory } = fixture();
    await ingestHostAgentEvent(memory, event);
    await makeLegacy(documentStore, scope);
    expect(await ingestHostAgentEvent(memory, event)).toMatchObject({ recorded: false, skippedReason: "duplicate_event" });
    expect(await documentStore.query("evidence")).toHaveLength(1);
    expect(await documentStore.query("experiences")).toHaveLength(1);
  });

  it("does not reuse a legacy event receipt owned by another scope", async () => {
    const { documentStore, memory } = fixture();
    await ingestHostAgentEvent(memory, event);
    await makeLegacy(documentStore, scope, { ...scope, userId: "other" });
    expect(await ingestHostAgentEvent(memory, event)).toMatchObject({ recorded: true });
    expect(await documentStore.query("evidence")).toHaveLength(2);
  });

  it("preserves old behavioral trace deduplication and evidence links", async () => {
    const { documentStore, runtime } = fixture();
    const input = { scope, traceId: "trace", result: { cue: "Copy report", evidenceExcerpt: "Copy failed", failureClass: "arg_order", firstAction: { kind: "tool_call", name: "copy" }, modelInfluence: "rules-only" } } as const;
    await runtime.handleBehavioralOutcome(input);
    await makeLegacy(documentStore, scope);
    await runtime.handleBehavioralOutcome(input);
    expect(await documentStore.query("experiences")).toHaveLength(1);
    expect(await documentStore.query("evidence")).toHaveLength(1);
  });

  it("preserves old correction trace identity", async () => {
    const { documentStore, runtime } = fixture();
    const input = { scope, traceId: "correction", appliesTo: "response", kind: "do", signal: "Use concise output", strict: true } as const;
    await runtime.handleAgentCorrection(input);
    await makeLegacy(documentStore, scope);
    await runtime.handleAgentCorrection(input);
    expect(await documentStore.query("experiences")).toHaveLength(1);
  });
  it("links a newly completed event to its preserved legacy evidence", async () => {
    const { documentStore, memory } = fixture();
    await ingestHostAgentEvent(memory, event);
    await makeLegacy(documentStore, scope);
    const experiences = await documentStore.query<{ id: string }>("experiences");
    for (const row of experiences) await documentStore.delete("experiences", row.id);
    const evidence = await documentStore.query<{ id: string }>("evidence");
    expect(await ingestHostAgentEvent(memory, event)).toMatchObject({ recorded: true });
    const completed = await documentStore.query<{ linkedEvidenceIds: string[] }>("experiences");
    expect(completed[0]!.linkedEvidenceIds).toEqual([evidence[0]!.id]);
    expect(await documentStore.query("evidence")).toHaveLength(1);
  });

  it("does not reuse a behavioral legacy receipt with a different owner", async () => {
    const { documentStore, runtime } = fixture();
    const input = { scope, traceId: "trace", result: { cue: "Copy report", evidenceExcerpt: "Copy failed", failureClass: "arg_order", firstAction: { kind: "tool_call", name: "copy" }, modelInfluence: "rules-only" } } as const;
    await runtime.handleBehavioralOutcome(input);
    await makeLegacy(documentStore, scope, { ...scope, userId: "other" });
    await runtime.handleBehavioralOutcome(input);
    expect(await documentStore.query("experiences")).toHaveLength(2);
    expect(await documentStore.query("evidence")).toHaveLength(2);
  });

});
