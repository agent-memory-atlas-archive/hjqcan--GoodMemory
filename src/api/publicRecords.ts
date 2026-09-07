import type { ExperienceRecord } from "../domain/evolutionRecords";
import { EXPERIENCES_COLLECTION } from "../domain/evolutionRecords";
import type { FactMemory, FeedbackMemory } from "../domain/records";
import type { RecallResult } from "./contracts";

function omitFields<T extends object>(record: T, fields: readonly string[]): T {
  const projected = { ...record };
  for (const field of fields) {
    delete (projected as Record<string, unknown>)[field];
  }
  return projected;
}

// Historical JSON stays untouched in storage. The public 0.8 shape no longer
// exposes retrieval-exposure telemetry, including on records written by 0.7.
export function publicFact(record: FactMemory): FactMemory {
  return omitFields(record, ["accessCount", "lastAccessedAt"]);
}

export function publicFeedback(record: FeedbackMemory): FeedbackMemory {
  return omitFields(record, ["lastUsedAt"]);
}

export function publicExperience(record: ExperienceRecord): ExperienceRecord {
  return {
    ...record,
    metrics: omitFields(record.metrics, ["touchedFactCount", "reinforcedFeedbackCount"]),
  };
}

export function publicRecall(result: RecallResult): RecallResult {
  return {
    ...result,
    facts: result.facts.map(publicFact),
    feedback: result.feedback.map(publicFeedback),
  };
}

export function publicDurableRecord(collection: string, record: object): object {
  if (collection === "facts") return publicFact(record as FactMemory);
  if (collection === "feedback") return publicFeedback(record as FeedbackMemory);
  if (collection === EXPERIENCES_COLLECTION) return publicExperience(record as ExperienceRecord);
  return record;
}
