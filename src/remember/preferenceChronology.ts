import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isRfc3339Instant } from "../domain/temporal";
import type { PreferenceMemory } from "../domain/records";
import { isSameDurableScope, type MemoryScope } from "../domain/scope";
import { EVIDENCE_COLLECTION, SOURCE_MESSAGES_COLLECTION, type SourceMessageRecord } from "../evidence/contracts";
import { evidenceSchema, sourceMessageSchema } from "../interchange/durableEnvelope";
import { normalizePreferenceSurface, parsePersonalPreferenceStatements, preferenceOppositionIds, preferenceSupersessionIds, sourcePreferenceStatement } from "../language/personalPreferences";
import type { ConditionalDocumentWriteBatch, DocumentStore } from "../storage/contracts";

type Snapshot = ConditionalDocumentWriteBatch["expected"];
type SourceClock = { kind: "dated"; time: number } | { kind: "undated" | "unverified" };

function clock(sources: readonly SourceMessageRecord[]): SourceClock {
  if (sources.length === 0) return { kind: "unverified" };
  const times = sources.map((source) => source.observedAt === undefined ? undefined : Date.parse(source.observedAt));
  if (times.every((time) => time === undefined)) return { kind: "undated" };
  if (times.some((time) => time === undefined || !Number.isFinite(time))) return { kind: "unverified" };
  return { kind: "dated", time: Math.max(...times as number[]) };
}

function validSource(source: SourceMessageRecord, scope: MemoryScope): boolean {
  return sourceMessageSchema.safeParse(source).success && isSameDurableScope(source, scope) &&
    (source.observedAt === undefined || isRfc3339Instant(source.observedAt)) &&
    createHash("sha256").update(source.content).digest("hex") === source.contentSha256;
}

function supportsStoredPreference(value: string, content: string): boolean {
  if (sourcePreferenceStatement(value, [content])) return true;
  // Targeted revisions can retain a whole preference sentence as the value.
  // This fallback establishes prior support only; it grants no incoming action.
  const parsed = parsePersonalPreferenceStatements(value);
  if (parsed.length !== 1) return false;
  const target = parsed[0]!;
  if (!/^[\s.!。！]*$/u.test(value.slice(0, target.start) + value.slice(target.end))) return false;
  const normalized = (text: string | null) => text === null ? null : normalizePreferenceSurface(text);
  return parsePersonalPreferenceStatements(content).some((source) =>
    source.polarity === target.polarity && normalized(source.object) === normalized(target.object) &&
    normalized(source.context) === normalized(target.context));
}

/** Observation time belongs to source assertions, never to extraction or ingestion. */
export async function checkPreferenceChronology(input: {
  scope: MemoryScope;
  value: string;
  active: readonly PreferenceMemory[];
  targets: readonly PreferenceMemory[];
  admissionTargets: readonly PreferenceMemory[];
  incomingSources: readonly SourceMessageRecord[];
  preparedSources: ReadonlyMap<string, SourceMessageRecord>;
  get: DocumentStore["get"];
  query: DocumentStore["query"];
}): Promise<{ reason?: "stale_preference_source" | "unordered_preference_source"; unchanged: Snapshot[] }> {
  const retirementIds = new Set(input.targets.map((record) => record.id));
  const targets = [...new Map([...input.targets, ...input.admissionTargets].map((record) => [record.id, record])).values()];
  if (targets.length === 0) return { unchanged: [] };
  const snapshots = new Map<string, Snapshot>();
  const add = (snapshot: Snapshot) => snapshots.set(JSON.stringify([snapshot.collection, snapshot.id]), snapshot);
  const evidence = await input.query<import("../evidence/contracts").EvidenceRecord>(EVIDENCE_COLLECTION, { userId: input.scope.userId });
  let reason: "stale_preference_source" | "unordered_preference_source" | undefined;
  for (const target of targets) {
    // Resolve each source's authority independently. An ordinary recent
    // re-mention cannot supply recency to an older restore/"now" command.
    const incoming = input.incomingSources.filter((source) => {
      if (source.role !== "user" || !validSource(source, input.scope)) return false;
      const statement = sourcePreferenceStatement(input.value, [source.content]);
      // Retirement authority wins when a target belongs to both sets. An
      // ordinary assertion may restrict admission but never authorize a write.
      const ids = retirementIds.has(target.id)
        ? preferenceSupersessionIds(input.active, statement)
        : preferenceOppositionIds(input.active, statement);
      return ids.has(target.id);
    });
    const incomingClock = clock(incoming);
    const links = evidence.filter((record) => Array.isArray(record.linkedMemoryIds) && record.linkedMemoryIds.includes(target.id));
    const support = new Map<string, SourceMessageRecord>();
    let verified = links.length > 0;
    for (const link of links) {
      if (!evidenceSchema.safeParse(link).success || !isSameDurableScope(link, input.scope) || !link.sourceRecordIds?.length) {
        verified = false;
        continue;
      }
      const storedLink = await input.get(EVIDENCE_COLLECTION, link.id);
      add({ collection: EVIDENCE_COLLECTION, id: link.id, document: storedLink });
      if (!isDeepStrictEqual(storedLink, link)) { verified = false; continue; }
      for (const id of link.sourceRecordIds) {
        const stored = await input.get<SourceMessageRecord>(SOURCE_MESSAGES_COLLECTION, id);
        add({ collection: SOURCE_MESSAGES_COLLECTION, id, document: stored });
        // Earlier candidates in the same remember transaction can have
        // prepared sources that will be persisted at transaction completion.
        const source = stored ?? input.preparedSources.get(id);
        if (!source || source.id !== id || !validSource(source, input.scope)) { verified = false; continue; }
        if (source.role === "user" && typeof target.value === "string" && supportsStoredPreference(target.value, source.content)) support.set(id, source);
      }
    }
    const priorClock = verified ? clock([...support.values()]) : { kind: "unverified" as const };
    if (incomingClock.kind === "undated" && priorClock.kind === "undated") continue; // Legacy undated arrival order only.
    if (incomingClock.kind !== "dated" || priorClock.kind !== "dated" || incomingClock.time === priorClock.time) {
      reason ??= "unordered_preference_source";
    } else if (incomingClock.time < priorClock.time) {
      reason = "stale_preference_source";
    }
  }
  return { reason, unchanged: [...snapshots.values()] };
}
