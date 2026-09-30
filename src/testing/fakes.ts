import type {
  GoodMemoryJobsFacade,
  GoodMemoryRuntimeFacade,
} from "../api/contracts";
import type { EmbeddingAdapter } from "../embedding/contracts";
import type { MemoryScope } from "../domain/scope";
import { scopeToKey, scopeToPrefix } from "../domain/scope";
import type { RecallRouterAssistant } from "../recall/assistant";

export interface FakeLLMRequest {
  purpose: string;
  prompt: string;
}

export interface FakeLLMResponse {
  content: string;
}

export function createFakeLLMAdapter(responses: FakeLLMResponse[] = []) {
  const queue = [...responses];

  return {
    async complete(_request: FakeLLMRequest): Promise<FakeLLMResponse> {
      if (queue.length === 0) {
        throw new Error("No fake LLM response configured");
      }

      return queue.shift()!;
    },
  };
}

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
}

export function createFakeEmbeddingAdapter(): EmbeddingAdapter {
  return {
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((text) => {
        const hash = hashString(text);
        return [hash % 997, (hash >> 3) % 997, (hash >> 7) % 997];
      });
    },
  };
}

export function createFakeRecallRouter(): RecallRouterAssistant {
  return {
    async plan(input) {
      const query = input.query.toLowerCase();
      const sourcePriorityOrder = [...input.routingDecision.sourcePriorities];
      const factIndex = sourcePriorityOrder.indexOf("fact");

      if (query.includes("runbook") || query.includes("source of truth")) {
        sourcePriorityOrder.sort((left, right) => {
          if (left === "fact") {
            return 1;
          }
          if (right === "fact") {
            return -1;
          }
          return 0;
        });
      } else if (factIndex > 0) {
        sourcePriorityOrder.splice(factIndex, 1);
        sourcePriorityOrder.unshift("fact");
      }

      return {
        querySummary: input.query,
        rationale: "fake recall router applied deterministic query alignment hints",
        requestedSlotAdditions:
          query.includes("source of truth") && !input.routingDecision.requestedSlots.includes("reference")
            ? ["reference"]
            : undefined,
        sourcePriorityOrder,
        supportSlotAdditions:
          query.includes("next") && !input.routingDecision.supportSlots.includes("project_state_support")
            ? ["project_state_support"]
            : undefined,
      };
    },

    async rerank(input) {
      const orderedCandidateIds = [...input.candidates]
        .sort((left, right) => {
          const leftScore = left.summary.toLowerCase().includes("runbook") ? 1 : 0;
          const rightScore = right.summary.toLowerCase().includes("runbook") ? 1 : 0;
          if (leftScore !== rightScore) {
            return rightScore - leftScore;
          }
          return left.id.localeCompare(right.id);
        })
        .map((candidate) => candidate.id);

      return {
        orderedCandidateIds,
        rationale: "fake recall router reordered bounded candidates deterministically",
      };
    },
  };
}

export function createNoopGoodMemoryRuntimeFacade(): GoodMemoryRuntimeFacade {
  async function unavailable(): Promise<never> {
    throw new Error("No fake GoodMemory runtime facade configured");
  }

  return {
    appendMessage: unavailable,
    endSession: unavailable,
    getRecallSnapshot: unavailable,
    getState: unavailable,
    setSessionSummary: unavailable,
    startSession: unavailable,
    updateSessionJournal: unavailable,
    updateWorkingMemory: unavailable,
  };
}

export function createNoopGoodMemoryJobsFacade(): GoodMemoryJobsFacade {
  async function unavailable(): Promise<never> {
    throw new Error("No fake GoodMemory jobs facade configured");
  }

  return {
    drain: unavailable,
    enqueueRemember: unavailable,
    getJob: unavailable,
    retryJob: unavailable,
  };
}

export function createFakeDocumentStore() {
  const collections = new Map<string, Map<string, unknown>>();

  const getCollection = (name: string): Map<string, unknown> => {
    let collection = collections.get(name);
    if (!collection) {
      collection = new Map<string, unknown>();
      collections.set(name, collection);
    }
    return collection;
  };

  return {
    async get<T>(collection: string, id: string): Promise<T | null> {
      return (getCollection(collection).get(id) as T | undefined) ?? null;
    },
    async set<T>(collection: string, id: string, doc: T): Promise<void> {
      getCollection(collection).set(id, doc);
    },
    async update<T>(
      collection: string,
      id: string,
      partial: Partial<T>,
    ): Promise<void> {
      const current = (getCollection(collection).get(id) as Record<string, unknown> | undefined) ?? {};
      getCollection(collection).set(id, { ...current, ...partial });
    },
    async writeBatchIfUnchanged(input: {
      expected: { collection: string; id: string; document: object };
      set: Array<{ collection: string; id: string; document: object }>;
    }): Promise<boolean> {
      const current = getCollection(input.expected.collection).get(
        input.expected.id,
      );
      if (JSON.stringify(current) !== JSON.stringify(input.expected.document)) {
        return false;
      }

      for (const operation of input.set) {
        getCollection(operation.collection).set(
          operation.id,
          operation.document,
        );
      }

      return true;
    },
    async delete(collection: string, id: string): Promise<void> {
      getCollection(collection).delete(id);
    },
    async query<T>(collection: string): Promise<T[]> {
      return Array.from(getCollection(collection).values()) as T[];
    },
  };
}

const scopeKey = scopeToKey;

export function createFakeSessionStore() {
  const buffers = new Map<string, unknown>();
  const workingMemory = new Map<string, unknown>();
  const journals = new Map<string, unknown>();
  const deleteByScope = (store: Map<string, unknown>, scope: MemoryScope) => {
    if (scope.sessionId !== undefined) {
      return store.delete(scopeKey(scope)) ? 1 : 0;
    }
    const prefix = scopeToPrefix(scope);
    let deleted = 0;

    for (const key of [...store.keys()]) {
      if (!key.startsWith(prefix)) {
        continue;
      }

      store.delete(key);
      deleted += 1;
    }

    return deleted;
  };

  return {
    async getBuffer<T>(scope: MemoryScope): Promise<T | null> {
      return (buffers.get(scopeKey(scope)) as T | undefined) ?? null;
    },
    async saveBuffer<T>(scope: MemoryScope, buffer: T): Promise<void> {
      buffers.set(scopeKey(scope), buffer);
    },
    async deleteBuffersByScope(scope: MemoryScope): Promise<number> {
      return deleteByScope(buffers, scope);
    },
    async getWorkingMemory<T>(scope: MemoryScope): Promise<T | null> {
      return (workingMemory.get(scopeKey(scope)) as T | undefined) ?? null;
    },
    async saveWorkingMemory<T>(scope: MemoryScope, snapshot: T): Promise<void> {
      workingMemory.set(scopeKey(scope), snapshot);
    },
    async deleteWorkingMemoryByScope(scope: MemoryScope): Promise<number> {
      return deleteByScope(workingMemory, scope);
    },
    async getJournal<T>(scope: MemoryScope): Promise<T | null> {
      return (journals.get(scopeKey(scope)) as T | undefined) ?? null;
    },
    async saveJournal<T>(scope: MemoryScope, journal: T): Promise<void> {
      journals.set(scopeKey(scope), journal);
    },
    async deleteJournalsByScope(scope: MemoryScope): Promise<number> {
      return deleteByScope(journals, scope);
    },
  };
}
