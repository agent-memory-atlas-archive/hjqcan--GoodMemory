import { createHash } from "node:crypto";
import { checkPreferenceChronology } from "./preferenceChronology";
import { candidateSourceMessageIndexes } from "./sourceMessages";
import { preferenceOppositionIds, preferenceSupersessionIds, sourcePreferenceStatement } from "../language/personalPreferences";
import {
  buildFeedbackIdentityKey,
  createFactMemory,
  createFeedbackMemory,
  createNoteMemory,
  createPreferenceMemory,
  createReferenceMemory,
  isActiveMemoryLifecycle,
  normalizeFeedbackAppliesTo,
} from "../domain/records";
import type { MemorySource } from "../domain/provenance";
import { isSameDurableScope } from "../domain/scope";
import { isIanaTimezone } from "../domain/temporal";
import type { TemporalInterval } from "../domain/temporal";
import {
  buildFactEmbeddingWrite,
  buildNoteEmbeddingWrite,
  buildReferenceEmbeddingWrite,
} from "../embedding/vectorWrites";
import { EVIDENCE_COLLECTION } from "../evidence/contracts";
import type { EvidenceRecord, SourceMessageRecord } from "../evidence/contracts";
import {
  resolvePolicyConflict,
  toPolicyMemoryRecord,
} from "../policy/hooks";
import {
  buildCandidateEvidence,
  buildFact,
  buildFeedback,
  buildNote,
  buildPreference,
  buildProfile,
  buildReference,
  deriveNoteTitle,
  enrichDuplicateFact,
  enrichDuplicateFeedback,
  enrichDuplicatePreference,
  enrichDuplicateReference,
  getProfileWriteReason,
  resolveCandidateObservedAt,
  resolveCandidateOccurrence,
  resolveReferenceSubject,
} from "./builders";
import { resolveFeedbackKind } from "./durableOptOut";
import type { SourceLanguageMetadata } from "./builders";
import { buildRememberEventTrace } from "./classification";
import type {
  ClassifiedCandidate,
  RememberWriteContext,
  RememberWriteState,
} from "./contracts";
import { storedTextLanguageKey } from "./languageAnalysis";
import { extractCanonicalReferencePointer } from "./normalization";
import { createPreferenceCategoryFence } from "./writeOwnership";

function preferenceWriteTimestamp(
  requestedTimestamp: string,
  preferences: readonly {
    source: MemorySource;
    updatedAt: string;
  }[],
): string {
  return new Date(Math.max(
    Date.parse(requestedTimestamp),
    ...preferences.flatMap((preference) => [
      Date.parse(preference.source.extractedAt),
      Date.parse(preference.updatedAt),
    ]),
  )).toISOString();
}

function sameOccurrence(
  left: TemporalInterval | undefined,
  right: TemporalInterval | undefined,
): boolean {
  if (!left || !right) {
    return left === right;
  }
  return left.start === right.start &&
    left.endExclusive === right.endExclusive &&
    left.precision === right.precision &&
    left.timezone === right.timezone;
}

function languageMetadata(
  resolved: ReturnType<RememberWriteContext["language"]["resolveFromText"]>,
): SourceLanguageMetadata {
  return {
    locale: resolved.locale,
    localeSource: resolved.localeSource,
    languagePackId: resolved.languagePackId,
    languagePackVersion: resolved.languagePackVersion,
  };
}

function resolveStoredTextLanguage(
  context: RememberWriteContext,
  text: string,
  source: MemorySource,
) {
  const key = storedTextLanguageKey(text, source.locale);
  const cached = context.storedLanguageContexts.get(key);
  if (cached) {
    return cached;
  }
  const resolved = context.language.resolveFromText({
    locale: source.locale,
    text,
  });
  context.storedLanguageContexts.set(key, resolved);
  return resolved;
}

function storedSourceLanguage(
  context: RememberWriteContext,
  text: string,
  source: MemorySource,
): SourceLanguageMetadata {
  const resolved = resolveStoredTextLanguage(context, text, source);
  return {
    locale: source.locale ?? resolved.locale,
    localeSource: source.localeSource ?? resolved.localeSource,
    languagePackId: source.languagePackId ?? resolved.languagePackId,
    languagePackVersion:
      source.languagePackVersion ?? resolved.languagePackVersion,
  };
}

function pushAcceptedEvent(
  state: RememberWriteState,
  event: RememberWriteState["events"][number],
): void {
  state.accepted += 1;
  state.events.push(event);
}

async function persistCandidateEvidence(input: {
  candidate: ClassifiedCandidate;
  context: RememberWriteContext;
  evidenceId: string;
  memoryId: string;
  timestamp: string;
}): Promise<SourceMessageRecord[]> {
  const sourceIndexes = [
    ...new Set(
      input.candidate.sourceMessageIndexes ?? [input.candidate.sourceMessageIndex],
    ),
  ];
  const sourceMessages = sourceIndexes.flatMap((messageIndex) => {
    const sourceMessage = input.context.sourceMessagesByIndex.get(messageIndex);
    return sourceMessage ? [sourceMessage] : [];
  });
  await input.context.setDocumentWithRollback(
    EVIDENCE_COLLECTION,
    input.evidenceId,
    buildCandidateEvidence(
      input.context.input.scope,
      input.candidate,
      input.memoryId,
      input.evidenceId,
      input.timestamp,
      languageMetadata(input.context.candidateLanguage),
      sourceMessages,
    ),
  );
  return sourceMessages;
}

async function preparePreferenceEvidence(
  context: RememberWriteContext,
  candidate: ClassifiedCandidate,
  memoryId: string,
  timestamp: string,
) {
  const sourceMessages = [...new Map(candidateSourceMessageIndexes(candidate).flatMap((index) => {
    const source = context.sourceMessagesByIndex.get(index);
    return source ? [[source.id, source] as const] : [];
  })).values()];
  // Some policy transformations cannot safely preserve the raw source. Keep
  // that existing admission behavior without manufacturing source evidence.
  if (sourceMessages.length === 0) return null;
  // Bind confirmations to immutable source records, not ingestion time or a
  // caller's reusable message ID. Replaying the same source keeps its evidence.
  const sourceIds = [...new Set(sourceMessages.map(({ id }) => id))].sort();
  const id = `preference-evidence:v1:${createHash("sha256")
    .update(JSON.stringify([memoryId, sourceIds])).digest("hex")}`;
  const existing = await context.getDocument<EvidenceRecord>(EVIDENCE_COLLECTION, id);
  if (existing && (
    !isSameDurableScope(existing, context.input.scope) ||
    existing.sessionId !== context.input.scope.sessionId ||
    existing.linkedMemoryIds.length !== 1 ||
    existing.linkedMemoryIds[0] !== memoryId ||
    JSON.stringify([...(existing.sourceRecordIds ?? [])].sort()) !== JSON.stringify(sourceIds)
  )) {
    throw new Error(`Preference evidence identity conflict: ${id}`);
  }
  return {
    id,
    constraint: { collection: EVIDENCE_COLLECTION, id, document: existing },
    writes: existing ? [] : [{
      collection: EVIDENCE_COLLECTION,
      id,
      document: buildCandidateEvidence(
        context.input.scope, candidate, memoryId, id, timestamp,
        languageMetadata(context.candidateLanguage), sourceMessages,
      ),
    }],
  };
}

function queueClaimProjection(input: {
  candidate: ClassifiedCandidate;
  evidenceId: string;
  memoryId: string;
  sourceMessages: readonly SourceMessageRecord[];
  state: RememberWriteState;
  timestamp: string;
  context: RememberWriteContext;
}): void {
  const claim = input.candidate.metadata?.claim;
  if (!claim) {
    return;
  }
  const observedAt = input.sourceMessages
    .map(({ observedAt }) => observedAt)
    .filter((value): value is string => value !== undefined)
    .sort()[0] ?? claim.validFrom ?? input.timestamp;
  input.state.pendingClaimProjections.push({
    ...input.context.input.scope,
    sourceMemoryId: input.memoryId,
    subject: input.candidate.metadata?.subject ?? input.context.input.scope.userId,
    claim,
    contextualDescriptor: input.candidate.metadata?.contextualDescriptor,
    observedAt,
    ingestedAt: input.timestamp,
    evidenceIds: [input.evidenceId],
    sourceMessageIds: input.sourceMessages.map(
      (message) => message.sourceMessageId ?? message.id,
    ),
    extractorVersion:
      input.candidate.extractorIds?.join("+") ??
      input.candidate.extractionSources?.join("+") ??
      "remember-candidate-v1",
  });
}

export async function writeRememberCandidate(input: {
  candidateId: string;
  candidate: ClassifiedCandidate;
  context: RememberWriteContext;
  state: RememberWriteState;
}): Promise<void> {
  const { candidateId, candidate, context, state } = input;
  const timestamp = context.now();
  const candidateLanguage = context.candidateLanguage;
  const candidateSourceLanguage = languageMetadata(candidateLanguage);

  if (candidate.memoryType === "profile") {
    const profileField = candidate.metadata?.profileField ?? "name";
    if (profileField === "timezone" && !isIanaTimezone(candidate.content)) {
      state.rejected += 1;
      state.events.push({
        candidateId,
        outcome: "rejected",
        memoryType: "profile",
        reason: "invalid_payload",
        ...buildRememberEventTrace(candidate),
      });
      return;
    }
    const existing = await context.repositories.profiles.get(context.input.scope.userId);

    if (profileField === "currentProject") {
      const currentProjects = existing?.activeContext.currentProjects ?? [];
      if (currentProjects.includes(candidate.content)) {
        pushAcceptedEvent(state, {
          candidateId,
          outcome: "merged",
          memoryType: "profile",
          memoryId: context.input.scope.userId,
          reason: "duplicate_profile",
          ...buildRememberEventTrace(candidate),
        });
        return;
      }
    } else if (existing?.identity[profileField] === candidate.content) {
      pushAcceptedEvent(state, {
        candidateId,
        outcome: "merged",
        memoryType: "profile",
        memoryId: context.input.scope.userId,
        reason: "duplicate_profile",
        ...buildRememberEventTrace(candidate),
      });
      return;
    }

    const profile = buildProfile(
      context.input.scope.userId,
      existing,
      candidate,
      timestamp,
    );
    await context.setDocumentWithRollback("profiles", profile.userId, profile);
    pushAcceptedEvent(state, {
      candidateId,
      outcome: "written",
      memoryType: "profile",
      memoryId: profile.userId,
      reason: getProfileWriteReason(candidate),
      ...buildRememberEventTrace(candidate),
    });
    return;
  }

  if (candidate.memoryType === "preference") {
    const category =
      candidate.metadata?.preferenceCategory ?? "general_preference";
    const candidateValue = String(
      candidate.metadata?.preferenceValue ?? candidate.content,
    ).trim();
    const userSources = candidateSourceMessageIndexes(candidate)
      .map((index) => context.sourceMessagesByIndex.get(index))
      .filter((message) => message?.role === "user")
      .map((message) => message!.content);
    const preferenceStatement = sourcePreferenceStatement(candidateValue, userSources);
    const value = candidateValue;
    const normalizedValue = context.language.normalizeForEquality(
      value,
      candidateLanguage,
    );
    const preferenceWrite = await context.writeDocumentBatchWithRollback<{
      memoryId: string;
      outcome: "merged" | "superseded" | "written" | "rejected";
      reason: string;
      evidenceId?: string;
    }>(
      createPreferenceCategoryFence(context.input.scope, category),
      async () => {
        const categoryPreferences = (
          await context.repositories.preferences.listByScope(context.input.scope)
        )
          .filter(
            (preference) =>
              isSameDurableScope(preference, context.input.scope) &&
              (preference.lifecycle ?? "active") === "active" &&
              preference.category === category,
          )
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
        const retirementIds = preferenceSupersessionIds(categoryPreferences, preferenceStatement);
        const retiredPreferences = categoryPreferences.filter((preference) => retirementIds.has(preference.id));
        const updatedAt = preferenceWriteTimestamp(
          timestamp,
          categoryPreferences,
        );
        const duplicate = categoryPreferences.find((preference) => {
          const preferenceValue = String(preference.value).trim();
          const preferenceLanguage = resolveStoredTextLanguage(
            context,
            preferenceValue,
            preference.source,
          );
          return context.language.normalizeForEquality(
            preferenceValue,
            preferenceLanguage,
          ) === normalizedValue;
        });

        const chronologicalTargets = retiredPreferences.filter((preference) => preference.id !== duplicate?.id);
        const oppositionIds = preferenceOppositionIds(categoryPreferences, preferenceStatement);
        const admissionTargets = categoryPreferences.filter((preference) => preference.id !== duplicate?.id && oppositionIds.has(preference.id));
        const firstChronologyTarget = chronologicalTargets[0] ?? admissionTargets[0];
        const chronology = await checkPreferenceChronology({
          scope: context.input.scope, value, active: categoryPreferences, targets: chronologicalTargets, admissionTargets,
          incomingSources: candidateSourceMessageIndexes(candidate).flatMap((index) => {
            const source = context.sourceMessagesByIndex.get(index);
            return source ? [source] : [];
          }),
          preparedSources: new Map([...context.sourceMessagesByIndex.values()].map((source) => [source.id, source])),
          get: context.getDocument, query: context.queryDocuments,
        });
        if (chronology.reason && !duplicate) {
          return {
            batch: {
              expected: { collection: "preferences", id: firstChronologyTarget!.id, document: firstChronologyTarget! },
              unchanged: [...chronology.unchanged, ...categoryPreferences.slice(0).map((document) => ({ collection: "preferences", id: document.id, document }))],
              set: [],
            },
            result: { memoryId: firstChronologyTarget!.id, outcome: "rejected" as const, reason: chronology.reason },
          };
        }

        if (duplicate) {
          const evidence = await preparePreferenceEvidence(context, candidate, duplicate.id, timestamp);
          const enrichedDuplicate = enrichDuplicatePreference(
            duplicate,
            candidate,
            timestamp,
            storedSourceLanguage(
              context,
              String(duplicate.value),
              duplicate.source,
            ),
          );
          const updatedDuplicate = enrichedDuplicate
            ? createPreferenceMemory({
                ...enrichedDuplicate,
                updatedAt,
              })
            : null;
          const explicitCorrection = preferenceStatement?.polarity === "withdrawn" ||
            preferenceStatement?.explicitUpdate === true;
          const stalePreferences = retiredPreferences.filter(
            (preference) => !chronology.reason && explicitCorrection && preference.id !== duplicate.id,
          );
          return {
            batch: {
              expected: {
                collection: "preferences",
                document: duplicate,
                id: duplicate.id,
              },
              unchanged: [...chronology.unchanged, ...(evidence ? [evidence.constraint] : []), ...stalePreferences.map((preference) => ({
                collection: "preferences",
                document: preference,
                id: preference.id,
              }))],
              set: [
                ...(evidence?.writes ?? []),
                ...(updatedDuplicate
                  ? [{
                      collection: "preferences",
                      document: updatedDuplicate,
                      id: duplicate.id,
                    }]
                  : []),
                ...stalePreferences.map((preference) => ({
                  collection: "preferences",
                  document: createPreferenceMemory({
                    ...preference,
                    lifecycle: "superseded",
                    supersededBy: duplicate.id,
                    updatedAt,
                  }),
                  id: preference.id,
                })),
              ],
            },
            result: {
              memoryId: duplicate.id,
              outcome: "merged" as const,
              reason: "duplicate_preference",
              evidenceId: evidence?.id,
            },
          };
        }

        const preference = createPreferenceMemory({
          ...buildPreference(
            context.input.scope,
            { ...candidate, metadata: { ...candidate.metadata, preferenceValue: value } },
            context.createId(),
            timestamp,
            candidateSourceLanguage,
          ),
          updatedAt,
        });
        const evidence = await preparePreferenceEvidence(context, candidate, preference.id, timestamp);
        return {
          batch: {
            expected: {
              collection: "preferences",
              document: null,
              id: preference.id,
            },
            unchanged: [...chronology.unchanged, ...(evidence ? [evidence.constraint] : []), ...categoryPreferences.map((existing) => ({
              collection: "preferences",
              document: existing,
              id: existing.id,
            }))],
            set: [
              ...(evidence?.writes ?? []),
              {
                collection: "preferences",
                document: preference,
                id: preference.id,
              },
              ...retiredPreferences.map((existing) => ({
                collection: "preferences",
                document: createPreferenceMemory({
                  ...existing,
                  lifecycle: "superseded",
                  supersededBy: preference.id,
                  updatedAt,
                }),
                id: existing.id,
              })),
            ],
          },
          result: retiredPreferences.length > 0
            ? {
                memoryId: preference.id,
                outcome: "superseded" as const,
                reason: "superseded_preference",
                evidenceId: evidence?.id,
              }
            : {
                memoryId: preference.id,
                outcome: "written" as const,
                reason: "explicit_preference",
                evidenceId: evidence?.id,
              },
        };
      },
    );
    if (preferenceWrite.outcome === "rejected") {
      state.rejected += 1;
      state.events.push({ candidateId, outcome: "rejected", memoryType: "preference", reason: preferenceWrite.reason,
        ...buildRememberEventTrace(candidate) });
      return;
    }
    pushAcceptedEvent(state, {
      candidateId,
      outcome: preferenceWrite.outcome,
      memoryType: "preference",
      memoryId: preferenceWrite.memoryId,
      reason: preferenceWrite.reason,
      ...(preferenceWrite.evidenceId ? { evidenceIds: [preferenceWrite.evidenceId] } : {}),
      ...buildRememberEventTrace(candidate),
    });
    return;
  }

  if (candidate.memoryType === "reference") {
    const scopedReferences = (
      await context.repositories.references.listByScope(context.input.scope)
    ).filter((reference) => isSameDurableScope(reference, context.input.scope));
    const resolvedSubject = resolveReferenceSubject(
      candidate,
      scopedReferences,
    );
    const referenceCandidate =
      resolvedSubject === candidate.metadata?.subject
        ? candidate
        : {
            ...candidate,
            metadata: {
              ...candidate.metadata,
              subject: resolvedSubject,
            },
          };
    const pointer =
      extractCanonicalReferencePointer(referenceCandidate.metadata?.referencePointer) ??
      extractCanonicalReferencePointer(referenceCandidate.content) ??
      referenceCandidate.metadata?.referencePointer ??
      referenceCandidate.content;
    const duplicate = scopedReferences.find(
      (reference) =>
        isActiveMemoryLifecycle(reference) &&
        (extractCanonicalReferencePointer(reference.pointer) ?? reference.pointer) ===
          pointer,
    );

    if (duplicate) {
      const enrichedDuplicate = enrichDuplicateReference(
        duplicate,
        referenceCandidate,
        timestamp,
        storedSourceLanguage(context, duplicate.pointer, duplicate.source),
      );
      if (enrichedDuplicate) {
        await context.setDocumentWithRollback(
          "references",
          duplicate.id,
          enrichedDuplicate,
        );
      }
      const evidenceId = context.createId();
      await persistCandidateEvidence({
        candidate: referenceCandidate,
        context,
        evidenceId,
        memoryId: duplicate.id,
        timestamp,
      });
      pushAcceptedEvent(state, {
        candidateId,
        outcome: "merged",
        memoryType: "reference",
        memoryId: duplicate.id,
        reason: "duplicate_reference",
        ...buildRememberEventTrace(candidate),
        evidenceIds: [evidenceId],
      });
      return;
    }

    const superseded = scopedReferences.find(
      (reference) =>
        isActiveMemoryLifecycle(reference) &&
        (extractCanonicalReferencePointer(reference.pointer) ?? reference.pointer) ===
          (
            extractCanonicalReferencePointer(
              referenceCandidate.metadata?.supersedesPointer,
            ) ?? referenceCandidate.metadata?.supersedesPointer
          ),
    );
    if (superseded && context.policy?.resolveConflict) {
      const resolution = await resolvePolicyConflict(
        context.policy,
        toPolicyMemoryRecord(superseded, "reference"),
        referenceCandidate,
        context.policyContext,
      );

      if (resolution?.action === "keep_existing") {
        state.rejected += 1;
        state.events.push({
          candidateId,
          outcome: "rejected",
          memoryType: "reference",
          memoryId: superseded.id,
          reason: resolution.reason ?? "policy_keep_existing",
          ...buildRememberEventTrace(candidate),
        });
        return;
      }
    }
    const reference = buildReference(
      context.input.scope,
      referenceCandidate,
      context.createId(),
      timestamp,
      candidateSourceLanguage,
    );
    const referenceEmbeddingWrite = buildReferenceEmbeddingWrite(reference);
    const supersededReferenceVector =
      superseded && context.vectorIndex
        ? await context.vectorIndex.getReferenceEmbedding(superseded.id)
        : null;

    if (superseded) {
      await context.setDocumentWithRollback(
        "references",
        superseded.id,
        createReferenceMemory({
          ...superseded,
          lifecycle: "superseded",
          updatedAt: timestamp,
        }),
      );
      state.pendingVectorDeletes.push({
        id: superseded.id,
        memoryType: "reference",
        restoreRecord: supersededReferenceVector
          ? {
              ...supersededReferenceVector,
              memoryType: "reference",
            }
          : null,
      });
    }

    await context.setDocumentWithRollback("references", reference.id, reference);
    state.pendingEmbeddingWrites.push(referenceEmbeddingWrite);
    const evidenceId = context.createId();
    await persistCandidateEvidence({
      candidate: referenceCandidate,
      context,
      evidenceId,
      memoryId: reference.id,
      timestamp,
    });
    pushAcceptedEvent(state, {
      candidateId,
      outcome: superseded ? "superseded" : "written",
      memoryType: "reference",
      memoryId: reference.id,
      reason: superseded ? "superseded_reference" : "explicit_reference",
      ...buildRememberEventTrace(candidate),
      evidenceIds: [evidenceId],
    });
    return;
  }

  if (candidate.memoryType === "note") {
    // Notes are authored pages: the body is stored verbatim and the title is
    // the identity key within a scope. A same-title rewrite supersedes with
    // lineage; an identical page merges; policy may keep the existing page.
    const body = candidate.content;
    const title =
      candidate.metadata?.noteTitle?.trim() || deriveNoteTitle(body);
    const normalizedTitle = context.language.normalizeForEquality(
      title,
      candidateLanguage,
    );
    const scopedNotes = await context.repositories.notes.listByScope(
      context.input.scope,
    );
    const existing = scopedNotes.find(
      (note) =>
        isSameDurableScope(note, context.input.scope) &&
        isActiveMemoryLifecycle(note) &&
        context.language.normalizeForEquality(
          note.title,
          resolveStoredTextLanguage(context, note.title, note.source),
        ) === normalizedTitle,
    );

    if (existing && existing.body.trim() === body.trim()) {
      const evidenceId = context.createId();
      await persistCandidateEvidence({
        candidate,
        context,
        evidenceId,
        memoryId: existing.id,
        timestamp,
      });
      pushAcceptedEvent(state, {
        candidateId,
        outcome: "merged",
        memoryType: "note",
        memoryId: existing.id,
        reason: "duplicate_note",
        ...buildRememberEventTrace(candidate),
        evidenceIds: [evidenceId],
      });
      return;
    }

    if (existing && context.policy?.resolveConflict) {
      const resolution = await resolvePolicyConflict(
        context.policy,
        toPolicyMemoryRecord(existing, "note"),
        candidate,
        context.policyContext,
      );

      if (resolution?.action === "keep_existing") {
        state.rejected += 1;
        state.events.push({
          candidateId,
          outcome: "rejected",
          memoryType: "note",
          memoryId: existing.id,
          reason: resolution.reason ?? "policy_keep_existing",
          ...buildRememberEventTrace(candidate),
        });
        return;
      }
    }

    const note = buildNote(
      context.input.scope,
      candidate,
      title,
      context.createId(),
      timestamp,
      candidateSourceLanguage,
      context.input.messages,
    );
    const supersededNoteVector =
      existing && context.vectorIndex
        ? await context.vectorIndex.getNoteEmbedding(existing.id)
        : null;

    if (existing) {
      await context.setDocumentWithRollback(
        "notes",
        existing.id,
        createNoteMemory({
          ...existing,
          lifecycle: "superseded",
          supersededBy: note.id,
          updatedAt: timestamp,
        }),
      );
      state.pendingVectorDeletes.push({
        id: existing.id,
        memoryType: "note",
        restoreRecord: supersededNoteVector
          ? {
              ...supersededNoteVector,
              memoryType: "note",
            }
          : null,
      });
    }

    await context.setDocumentWithRollback("notes", note.id, note);
    state.pendingEmbeddingWrites.push(buildNoteEmbeddingWrite(note));
    const evidenceId = context.createId();
    await persistCandidateEvidence({
      candidate,
      context,
      evidenceId,
      memoryId: note.id,
      timestamp,
    });
    pushAcceptedEvent(state, {
      candidateId,
      outcome: existing ? "superseded" : "written",
      memoryType: "note",
      memoryId: note.id,
      reason: existing ? "superseded_note" : "explicit_note",
      ...buildRememberEventTrace(candidate),
      evidenceIds: [evidenceId],
    });
    return;
  }

  if (candidate.memoryType === "fact") {
    const facts = (
      await context.repositories.facts.listByScope(context.input.scope)
    ).filter((fact) => isSameDurableScope(fact, context.input.scope));
    const occurrence = resolveCandidateOccurrence(
      candidate,
      context.input.messages,
      candidateLanguage.locale,
    );
    const normalizedContent = context.language.normalizeForEquality(
      candidate.content,
      candidateLanguage,
    );
    const duplicate = facts.find(
      (fact) => {
        const factLanguage = resolveStoredTextLanguage(
          context,
          fact.content,
          fact.source,
        );
        return (
          fact.lifecycle === "active" &&
          context.language.normalizeForEquality(fact.content, factLanguage) ===
            normalizedContent &&
          sameOccurrence(fact.occurrence, occurrence)
        );
      },
    );

    if (duplicate) {
      const enrichedDuplicate = enrichDuplicateFact(
        duplicate,
        candidate,
        timestamp,
        storedSourceLanguage(context, duplicate.content, duplicate.source),
      );
      const evidenceId = context.createId();
      const sourceMessages = await persistCandidateEvidence({
        candidate,
        context,
        evidenceId,
        memoryId: duplicate.id,
        timestamp,
      });
      await context.setDocumentWithRollback(
        "facts",
        duplicate.id,
        enrichedDuplicate ?? duplicate,
      );
      queueClaimProjection({
        candidate,
        context,
        evidenceId,
        memoryId: duplicate.id,
        sourceMessages,
        state,
        timestamp,
      });
      pushAcceptedEvent(state, {
        candidateId,
        outcome: "merged",
        memoryType: "fact",
        memoryId: duplicate.id,
        reason: "duplicate_fact",
        ...buildRememberEventTrace(candidate),
        evidenceIds: [evidenceId],
      });
      return;
    }

    const superseded = candidate.metadata?.category === "event"
      ? undefined
      : facts.find((fact) => {
      const factLanguage = resolveStoredTextLanguage(
        context,
        fact.content,
        fact.source,
      );
      return (
        fact.lifecycle === "active" &&
        fact.source.method !== "explicit" &&
        candidate.explicitness === "explicit" &&
        context.language.localesCompatible(
          factLanguage.locale,
          candidateLanguage.locale,
        ) &&
        context.language.tokenOverlap(
          fact.content,
          candidate.content,
          candidateLanguage,
        ) >= 0.4
      );
        });

    if (superseded && context.policy?.resolveConflict) {
      const resolution = await resolvePolicyConflict(
        context.policy,
        toPolicyMemoryRecord(superseded, "fact"),
        candidate,
        context.policyContext,
      );

      if (resolution?.action === "keep_existing") {
        state.rejected += 1;
        state.events.push({
          candidateId,
          outcome: "rejected",
          memoryType: "fact",
          memoryId: superseded.id,
          reason: resolution.reason ?? "policy_keep_existing",
          ...buildRememberEventTrace(candidate),
        });
        return;
      }
    }

    const fact = buildFact(
      context.input.scope,
      candidate,
      context.createId(),
      timestamp,
      candidateSourceLanguage,
      resolveCandidateObservedAt(candidate, context.input.messages),
      occurrence,
    );
    const factEmbeddingWrite = buildFactEmbeddingWrite(fact);
    const supersededFactVector =
      superseded && context.vectorIndex
        ? await context.vectorIndex.getFactEmbedding(superseded.id)
        : null;

    if (superseded) {
      await context.setDocumentWithRollback(
        "facts",
        superseded.id,
        createFactMemory({
          ...superseded,
          lifecycle: "superseded",
          isActive: false,
          supersededBy: fact.id,
          updatedAt: timestamp,
        }),
      );
      state.pendingVectorDeletes.push({
        id: superseded.id,
        memoryType: "fact",
        restoreRecord: supersededFactVector
          ? {
              ...supersededFactVector,
              memoryType: "fact",
            }
          : null,
      });
    }

    const evidenceId = context.createId();
    const sourceMessages = await persistCandidateEvidence({
      candidate,
      context,
      evidenceId,
      memoryId: fact.id,
      timestamp,
    });
    await context.setDocumentWithRollback("facts", fact.id, fact);
    state.pendingEmbeddingWrites.push(factEmbeddingWrite);
    queueClaimProjection({
      candidate,
      context,
      evidenceId,
      memoryId: fact.id,
      sourceMessages,
      state,
      timestamp,
    });
    pushAcceptedEvent(state, {
      candidateId,
      outcome: superseded ? "superseded" : "written",
      memoryType: "fact",
      memoryId: fact.id,
      reason: superseded ? "superseded_inferred_fact" : "explicit_fact",
      ...buildRememberEventTrace(candidate),
      evidenceIds: [evidenceId],
    });
    return;
  }

  const scopedFeedback = (
    await context.repositories.feedback.listByScope(context.input.scope)
  ).filter((feedback) => isSameDurableScope(feedback, context.input.scope));
  const normalizedRule = context.language.normalizeForEquality(
    candidate.content,
    candidateLanguage,
  );
  const candidateIdentityKey = buildFeedbackIdentityKey({
    kind: resolveFeedbackKind(candidate),
    normalizedRule,
    appliesTo: candidate.metadata?.appliesTo,
  });
  const duplicate = scopedFeedback.find(
    (feedback) => {
      const feedbackLanguage = resolveStoredTextLanguage(
        context,
        feedback.rule,
        feedback.source,
      );
      return (
        feedback.lifecycle === "active" &&
        buildFeedbackIdentityKey({
          kind: feedback.kind,
          normalizedRule: context.language.normalizeForEquality(
            feedback.rule,
            feedbackLanguage,
          ),
          appliesTo: feedback.appliesTo,
        }) === candidateIdentityKey
      );
    },
  );

  if (duplicate) {
    const enrichedDuplicate = enrichDuplicateFeedback(
      duplicate,
      candidate,
      timestamp,
      storedSourceLanguage(context, duplicate.rule, duplicate.source),
    );
    if (enrichedDuplicate) {
      await context.setDocumentWithRollback(
        "feedback",
        duplicate.id,
        enrichedDuplicate,
      );
    }
    pushAcceptedEvent(state, {
      candidateId,
      outcome: "merged",
      memoryType: "feedback",
      memoryId: duplicate.id,
      reason: "duplicate_feedback",
      ...buildRememberEventTrace(candidate),
    });
    return;
  }

  const superseded = scopedFeedback.find(
    (feedback) =>
      feedback.lifecycle === "active" &&
      feedback.kind === resolveFeedbackKind(candidate) &&
      normalizeFeedbackAppliesTo(feedback.appliesTo) ===
        normalizeFeedbackAppliesTo(candidate.metadata?.appliesTo),
  );
  if (superseded && context.policy?.resolveConflict) {
    const resolution = await resolvePolicyConflict(
      context.policy,
      toPolicyMemoryRecord(superseded, "feedback"),
      candidate,
      context.policyContext,
    );

    if (resolution?.action === "keep_existing") {
      state.rejected += 1;
      state.events.push({
        candidateId,
        outcome: "rejected",
        memoryType: "feedback",
        memoryId: superseded.id,
        reason: resolution.reason ?? "policy_keep_existing",
        ...buildRememberEventTrace(candidate),
      });
      return;
    }
  }
  const feedback = buildFeedback(
    context.input.scope,
    candidate,
    context.createId(),
    timestamp,
    candidateSourceLanguage,
  );

  if (superseded) {
    await context.setDocumentWithRollback(
      "feedback",
      superseded.id,
      createFeedbackMemory({
        ...superseded,
        lifecycle: "superseded",
        supersededBy: feedback.id,
        updatedAt: timestamp,
      }),
    );
  }

  await context.setDocumentWithRollback("feedback", feedback.id, feedback);
  pushAcceptedEvent(state, {
    candidateId,
    outcome: superseded ? "superseded" : "written",
    memoryType: "feedback",
    memoryId: feedback.id,
    reason: superseded ? "superseded_feedback" : "explicit_feedback",
    ...buildRememberEventTrace(candidate),
  });
}
