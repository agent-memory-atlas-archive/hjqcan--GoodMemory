import { describe, expect, it } from "bun:test";

import { createGoodMemory } from "../../src";
import type { MemoryCandidateMetadata } from "../../src/domain/memoryCandidate";
import type { FactMemory, FeedbackMemory, ReferenceMemory } from "../../src/domain/records";
import { isSameDurableScope } from "../../src/domain/scope";
import type { MemoryScope } from "../../src/domain/scope";
import type { EvidenceRecord } from "../../src/evidence/contracts";
import {
  createInMemoryDocumentStore,
  createInMemorySessionStore,
  createInMemoryVectorStore,
} from "../../src/storage/memory";
import { createFakeEmbeddingAdapter } from "../../src/testing/fakes";

type Kind = "fact" | "reference" | "feedback";
type DurableRecord = FactMemory | FeedbackMemory | ReferenceMemory;
const USER_SCOPE = { userId: "durable-scope-user" };
const DIMENSIONS = ["tenantId", "workspaceId", "agentId"] as const;
const CONTENT = {
  fact: "The runtime migration is blocked on a schema rollout.",
  reference: "docs/runtime-runbook.md",
  feedback: "Always keep answers concise and action-oriented.",
};
const REWRITE = {
  fact: "The runtime migration is now complete after the schema rollout.",
  reference: "docs/new-runtime-runbook.md",
  feedback: "Always keep answers detailed and action-oriented.",
};
const COLLECTION = { fact: "facts", reference: "references", feedback: "feedback" };

function harness(kind: Kind) {
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
    testing: {
      now: () => new Date("2026-09-30T00:00:00.000Z"),
      extractor: {
        async extract(input) {
          const content = input.messages[0]!.content;
          const metadata: MemoryCandidateMetadata = kind === "reference"
            ? { referencePointer: content, supersedesPointer: CONTENT.reference }
            : kind === "feedback"
              ? { feedbackKind: "do", appliesTo: "answers" }
              : { category: "project", factKind: "project_state", subject: "runtime migration" };
          return {
            candidates: [{
              id: "candidate",
              content,
              explicitness: "explicit" as const,
              kindHint: kind,
              metadata,
              sourceMessageIndex: 0,
              sourceRole: "user" as const,
            }],
            ignoredMessageCount: 0,
          };
        },
      },
    },
  });
  async function write(scope: MemoryScope, content: string) {
    const message = kind === "reference"
      ? content === CONTENT.reference
        ? `Use ${content} as the source of truth for runtime work.`
        : `Correction: ${content} is now the source of truth, not ${CONTENT.reference}. Please update that.`
      : content;
    const result = await memory.remember({
      scope,
      messages: [{ role: "user", content: message }],
      extractionStrategy: "rules-only",
    });
    const event = result.events.find((event) => event.memoryType === kind);
    expect(event?.memoryId, JSON.stringify(result)).toBeDefined();
    return event!;
  }
  return { documentStore, memory, vectorStore, write };
}

describe.each(["fact", "reference", "feedback"] as const)("%s write identity", (kind) => {
  for (const dimension of DIMENSIONS) {
    it.each(["duplicate", "replacement"] as const)(`does not borrow a ${dimension}-specific record for a user-wide %s`, async (operation) => {
      const { documentStore, vectorStore, write } = harness(kind);
      const collection = COLLECTION[kind];
      const previous = await write({ ...USER_SCOPE, [dimension]: "private" }, CONTENT[kind]);
      const original = (await documentStore.get<DurableRecord>(collection, previous.memoryId!))!;
      if (kind === "fact" && operation === "replacement") {
        await documentStore.set(collection, original.id, {
          ...original,
          source: { ...original.source, method: "inferred" },
        });
      }
      const before = await documentStore.get(collection, original.id);
      const vectorBefore = await vectorStore.get(collection, original.id);

      const next = await write(USER_SCOPE, operation === "duplicate" ? CONTENT[kind] : REWRITE[kind]);

      expect(next.outcome).toBe("written");
      expect(next.memoryId).not.toBe(original.id);
      expect(await documentStore.get(collection, original.id)).toEqual(before);
      expect(await vectorStore.get(collection, original.id)).toEqual(vectorBefore);
      const records = await documentStore.query<DurableRecord>(collection);
      expect(records).toHaveLength(2);
      expect(records.every((record) => record.lifecycle === "active")).toBe(true);
      const written = records.find((record) => record.id === next.memoryId)!;
      expect(isSameDurableScope(written, USER_SCOPE)).toBe(true);
      const evidence = await documentStore.query<EvidenceRecord>("evidence");
      for (const record of evidence) {
        for (const memoryId of record.linkedMemoryIds) {
          const target = records.find((candidate) => candidate.id === memoryId);
          if (target) expect(isSameDurableScope(record, target)).toBe(true);
        }
      }
    });
  }

  it("still merges duplicates across sessions in the same durable scope", async () => {
    const { documentStore, write } = harness(kind);
    const scope = { ...USER_SCOPE, tenantId: "tenant", workspaceId: "workspace", agentId: "agent" };
    const first = await write({ ...scope, sessionId: "first" }, CONTENT[kind]);
    const repeated = await write({ ...scope, sessionId: "second" }, CONTENT[kind]);
    expect(repeated.outcome).toBe("merged");
    expect(repeated.memoryId).toBe(first.memoryId);
    expect(await documentStore.query(COLLECTION[kind])).toHaveLength(1);
  });

  it("still supersedes an eligible record in the same durable scope", async () => {
    const { documentStore, write } = harness(kind);
    const first = await write(USER_SCOPE, CONTENT[kind]);
    const original = (await documentStore.get<DurableRecord>(COLLECTION[kind], first.memoryId!))!;
    if (kind === "fact") {
      await documentStore.set(COLLECTION[kind], original.id, {
        ...original,
        source: { ...original.source, method: "inferred" },
      });
    }
    const replacement = await write(USER_SCOPE, REWRITE[kind]);
    expect(replacement.outcome).toBe("superseded");
    expect(await documentStore.get(COLLECTION[kind], original.id)).toMatchObject({
      lifecycle: "superseded",
      ...(kind !== "reference" ? { supersededBy: replacement.memoryId } : {}),
    });
  });
});

describe("feedback API write identity", () => {
  for (const dimension of DIMENSIONS) {
    it.each([CONTENT.feedback, REWRITE.feedback])(`does not merge or supersede a ${dimension}-specific rule: %s`, async (signal) => {
      const { documentStore, memory } = harness("feedback");
      const original = await memory.feedback({ scope: { ...USER_SCOPE, [dimension]: "private" }, signal: CONTENT.feedback });
      const before = await documentStore.get("feedback", original.memoryId!);

      const next = await memory.feedback({ scope: USER_SCOPE, signal });

      expect(next.outcome).toBe("written");
      expect(next.memoryId).not.toBe(original.memoryId);
      expect(await documentStore.get("feedback", original.memoryId!)).toEqual(before);
      const records = await documentStore.query<FeedbackMemory>("feedback");
      expect(records).toHaveLength(2);
      expect(records.every((record) => record.lifecycle === "active")).toBe(true);
      expect(isSameDurableScope(records.find((record) => record.id === next.memoryId)!, USER_SCOPE)).toBe(true);
    });
  }
});
