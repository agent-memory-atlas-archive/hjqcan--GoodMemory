import { describe, expect, it } from "bun:test";
import { createGoodMemory, createInMemoryDocumentStore, type FeedbackMemory } from "../../src";

const query = "Evaluate database migrations.";
const target = "Use a checklist for database migrations.";
const rules = [target, "Use diagrams for botanical studies.", "Use sketches for astronomy observations.", "Use tables for culinary measurements."];

describe("public feedback recall capacity", () => {
  it("recalls an older matching confirmation while preserving user and workspace scope", async () => {
    const documentStore = createInMemoryDocumentStore();
    const memory = createGoodMemory({ storage: { provider: "memory" }, adapters: { documentStore } });
    const scopes = [
      { userId: "owner", workspaceId: "project-a" },
      { userId: "other", workspaceId: "project-a" },
      { userId: "owner", workspaceId: "project-b" },
    ];
    for (const scope of scopes) {
      for (const signal of rules) {
        expect((await memory.feedback({ scope, signal, locale: "en" })).accepted).toBe(true);
        expect((await memory.feedback({ scope, signal, locale: "en" })).accepted).toBe(true);
      }
      const active = (await documentStore.query<FeedbackMemory>("feedback", scope)).filter(({ lifecycle }) => lifecycle === "active");
      expect(active).toHaveLength(4);
      expect(active.every(({ kind }) => kind === "validated_pattern")).toBe(true);
    }
    for (const scope of scopes) {
      const recall = await memory.recall({ scope: { ...scope, sessionId: "fresh-session" }, query, locale: "en" });
      expect(recall.feedback.map(({ rule }) => rule)).toEqual([target]);
      expect(recall.feedback.every(record => record.userId === scope.userId && record.workspaceId === scope.workspaceId)).toBe(true);
    }
    const empty = await memory.recall({ scope: { userId: "unseeded", workspaceId: "project-a" }, query, locale: "en" });
    expect(empty.feedback).toEqual([]);
  });
});
