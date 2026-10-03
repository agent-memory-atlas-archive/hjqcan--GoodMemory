import { describe, expect, it } from "bun:test";
import { createFeedbackMemory, type FeedbackMemory } from "../../src/domain/records";
import { createLanguageService } from "../../src/language";
import { selectFeedback, selectFeedbackForProfile, selectFeedbackForQuery } from "../../src/recall/selectors/recordSelection";

const language = createLanguageService();
const query = "Evaluate database migrations.";
function record(id: string, rule: string, second: number, extra: Partial<FeedbackMemory> = {}): FeedbackMemory {
  return createFeedbackMemory({
    id, userId: "synthetic", rule, kind: "validated_pattern", appliesTo: "general_response",
    source: { method: "explicit", extractedAt: "2026-10-03T00:00:00.000Z" },
    updatedAt: `2026-10-03T00:00:${String(second).padStart(2, "0")}.000Z`, ...extra,
  });
}
const target = record("target", "Use a checklist for database migrations.", 0);
const distractors = [
  record("botany", "Use diagrams for botanical studies.", 1),
  record("astronomy", "Use sketches for astronomy observations.", 2),
  record("cooking", "Use tables for culinary measurements.", 3),
];
const selected = (records: FeedbackMemory[]) => selectFeedbackForQuery(records, query, language, "en", "general_chat").map(({ id }) => id);

describe("feedback query filtering before final capacity", () => {
  it("does not lose a matching rule when unrelated rules fill the prior cap", () => {
    for (let count = 0; count <= distractors.length; count++) {
      expect(selected([target, ...distractors.slice(0, count)])).toEqual(["target"]);
    }
  });

  it("retains the final cap and deterministic relevance-eligible ordering", () => {
    const matches = Array.from({ length: 5 }, (_, index) => record(`match-${index}`, `Database migrations checklist step ${index}.`, index + 4));
    expect(selected([target, ...distractors, ...matches])).toEqual(["match-4", "match-3", "match-2"]);
    expect(selected([...matches].reverse().concat(distractors, [target]))).toEqual(["match-4", "match-3", "match-2"]);
  });

  it("keeps lifecycle filtering, deduplication, and no-match abstention", () => {
    const duplicate = record("duplicate", target.rule, 5);
    const inactive = record("inactive", "Database migrations safety checklist.", 6, { lifecycle: "superseded" });
    expect(selected([target, ...distractors, duplicate, inactive])).toEqual(["duplicate"]);
    expect(selected(distractors)).toEqual([]);
  });

  it("does not change query-free profile selection or broad guidance selection", () => {
    const rows = [target, ...distractors];
    const expected = ["cooking", "astronomy", "botany"];
    expect(selectFeedback(rows).map(({ id }) => id)).toEqual(expected);
    expect(selectFeedbackForProfile(rows, "general_chat").map(({ id }) => id)).toEqual(expected);
    for (const broad of ["Summarize my work.", "Continue the task.", "What rules should you follow?"]) {
      expect(selectFeedbackForQuery(rows, broad, language, "en", "general_chat").map(({ id }) => id)).toEqual(expected);
    }
  });

  it("keeps the highest-priority duplicate even when only an older duplicate has matching tags", () => {
    const older = record("older", "Use a checklist.", 0, { why: "database migrations" });
    const newer = record("newer", "Use a checklist.", 1, { why: "astronomy observations" });
    expect(selected([older, newer])).toEqual([]);
  });

  it("does not pass inactive records or duplicate losers to the language predicate", () => {
    let calls = 0;
    const service = Object.create(language) as typeof language;
    service.tokenOverlap = (...args) => {
      calls += 1;
      return language.tokenOverlap(...args);
    };
    const analysis = language.analyzeQuery(query, "en");
    const choose = (rows: FeedbackMemory[]) => selectFeedbackForQuery(rows, query, service, "en", "general_chat", analysis).map(({ id }) => id);
    expect(choose([record("inactive", target.rule, 9, { lifecycle: "superseded" })])).toEqual([]);
    expect(calls).toBe(0);
    expect(choose([target, record("newer", target.rule, 1)])).toEqual(["newer"]);
    expect(calls).toBe(2);
  });

  it("stops evaluating language predicates once the final eligible cap is filled", () => {
    let calls = 0;
    const service = Object.create(language) as typeof language;
    service.tokenOverlap = (...args) => {
      calls += 1;
      return language.tokenOverlap(...args);
    };
    const matches = Array.from({ length: 5 }, (_, index) => record(`match-${index}`, `Database migrations checklist step ${index}.`, index));
    expect(selectFeedbackForQuery(matches, query, service, "en", "general_chat").map(({ id }) => id)).toEqual(["match-4", "match-3", "match-2"]);
    expect(calls).toBe(6);
  });
});
