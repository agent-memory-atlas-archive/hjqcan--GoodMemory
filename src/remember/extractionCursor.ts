import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { assertStorageSafeExternalValue } from "../domain/semanticText";

import {
  decodeLegacyScopeKey,
  isSameScope,
  LegacyScopeKeyError,
  legacyScopeToKey,
  scopeToKey,
} from "../domain/scope";
import type { MemoryScope } from "../domain/scope";
import type { ProjectionCapableDocumentStore } from "../storage/contracts";
import type { ExtractionOutcome } from "./contracts";

export const EXTRACTION_CURSORS_COLLECTION = "extraction_cursors_v1";
const LEGACY_CURSOR_CLAIMS_COLLECTION = "extraction_cursor_legacy_claims_v1";

interface LegacyCursorClaim {
  id: string;
  legacyScopeKey: string;
  scopeKey: string;
  sourceId: string;
  schemaVersion: 1;
}

export interface RecoverLegacyExtractionCursorInput {
  confirmTrustedOwnership: true;
  expectedLegacyCursor: ExtractionCursor;
  scope: MemoryScope;
  sourceId: string;
}

export interface ExtractionCursorAttempt {
  attempts: number;
  errorCode?: string;
  outcome: ExtractionOutcome;
  through: number;
  updatedAt: string;
}

export interface ExtractionCursor {
  committedThrough: number;
  id: string;
  lastAttempt: ExtractionCursorAttempt;
  schemaVersion: 1;
  scopeKey: string;
  sourceId: string;
}

export interface ExtractionCursorStore {
  recoverLegacyCursor?(input: RecoverLegacyExtractionCursorInput): Promise<boolean>;
  get(scope: MemoryScope, sourceId: string): Promise<ExtractionCursor | null>;
  record(input: {
    errorCode?: string;
    outcome: ExtractionOutcome;
    scope: MemoryScope;
    sourceId: string;
    through: number;
  }): Promise<ExtractionCursor>;
}

export interface RecoveryCapableExtractionCursorStore extends ExtractionCursorStore {
  recoverLegacyCursor(input: RecoverLegacyExtractionCursorInput): Promise<boolean>;
}

function cursorId(scopeKey: string, sourceId: string): string {
  return createHash("sha256")
    .update(scopeKey)
    .update("\0")
    .update(sourceId)
    .digest("hex");
}

function assertSourceId(sourceId: string): string {
  assertStorageSafeExternalValue(sourceId, "sourceId");
  const normalized = sourceId.trim();
  if (normalized.length === 0) {
    throw new Error("Extraction cursor sourceId must be non-empty.");
  }
  return normalized;
}

function assertThrough(through: number): void {
  if (!Number.isSafeInteger(through) || through < 0) {
    throw new Error("Extraction cursor offset must be a non-negative integer.");
  }
}

function isTerminal(outcome: ExtractionOutcome): boolean {
  return outcome === "committed" || outcome === "no_admissible_candidate";
}

export function createExtractionCursorStore(input: {
  documentStore: ProjectionCapableDocumentStore;
  now: () => string;
}): RecoveryCapableExtractionCursorStore {
  const { documentStore, now } = input;

  async function readLegacy(
    scope: MemoryScope,
    sourceId: string,
  ): Promise<ExtractionCursor | null> {
    const scopeKey = legacyScopeToKey(scope);
    const id = cursorId(scopeKey, sourceId);
    const claim = await documentStore.get<LegacyCursorClaim>(LEGACY_CURSOR_CLAIMS_COLLECTION, id);
    if (claim) {
      // A durable ownership claim suppresses old-row fallback, even after the
      // recovered target is removed. Never resurrect an archived cursor.
      return null;
    }
    const cursor = await documentStore.get<ExtractionCursor>(
      EXTRACTION_CURSORS_COLLECTION,
      id,
    );
    if (!cursor) {
      return null;
    }
    const owner = decodeLegacyScopeKey(scopeKey);
    if (
      !owner || !isSameScope(owner, scope) ||
      cursor.id !== id || cursor.scopeKey !== scopeKey ||
      cursor.sourceId !== sourceId
    ) {
      throw new LegacyScopeKeyError(
        scopeKey,
        "Extraction cursor ownership cannot be verified. The legacy cursor " +
          "is preserved; after verifying its owner, call recoverLegacyCursor with " +
          "the exact scope and expected legacy cursor.",
      );
    }
    return cursor;
  }

  function validateCurrent(
    cursor: ExtractionCursor | null,
    scopeKey: string,
    sourceId: string,
  ): ExtractionCursor | null {
    if (cursor && (
      cursor.id !== cursorId(scopeKey, sourceId) ||
      cursor.scopeKey !== scopeKey || cursor.sourceId !== sourceId
    )) {
      throw new Error("Extraction cursor identity does not match its storage key.");
    }
    return cursor;
  }

  async function get(
    scope: MemoryScope,
    sourceId: string,
  ): Promise<ExtractionCursor | null> {
    assertStorageSafeExternalValue(scope, "scope");
    const scopeKey = scopeToKey(scope);
    const normalizedSourceId = assertSourceId(sourceId);
    const current = validateCurrent(await documentStore.get<ExtractionCursor>(
      EXTRACTION_CURSORS_COLLECTION,
      cursorId(scopeKey, normalizedSourceId),
    ), scopeKey, normalizedSourceId);
    return current ?? readLegacy(scope, normalizedSourceId);
  }

  return {
    get,
    async recoverLegacyCursor(recovery) {
      assertStorageSafeExternalValue(recovery.scope, "scope");
      assertStorageSafeExternalValue(recovery.sourceId, "sourceId");
      if (recovery.confirmTrustedOwnership !== true) {
        throw new Error("Legacy cursor recovery requires confirmed trustworthy ownership.");
      }
      const sourceId = assertSourceId(recovery.sourceId);
      const legacyScopeKey = legacyScopeToKey(recovery.scope);
      const legacyId = cursorId(legacyScopeKey, sourceId);
      const scopeKey = scopeToKey(recovery.scope);
      const id = cursorId(scopeKey, sourceId);
      const expected = recovery.expectedLegacyCursor;
      if (expected.id !== legacyId || expected.scopeKey !== legacyScopeKey ||
        expected.sourceId !== sourceId || expected.schemaVersion !== 1) {
        return false;
      }
      assertThrough(expected.committedThrough);
      assertThrough(expected.lastAttempt.through);
      const [legacy, stored, claim] = await Promise.all([
        documentStore.get<ExtractionCursor>(EXTRACTION_CURSORS_COLLECTION, legacyId),
        documentStore.get<ExtractionCursor>(EXTRACTION_CURSORS_COLLECTION, id),
        documentStore.get<LegacyCursorClaim>(LEGACY_CURSOR_CLAIMS_COLLECTION, legacyId),
      ]);
      if (!isDeepStrictEqual(legacy, expected)) {
        return false;
      }
      const current = validateCurrent(stored, scopeKey, sourceId);
      if (claim) {
        return claim.schemaVersion === 1 && claim.id === legacyId &&
          claim.scopeKey === scopeKey && claim.legacyScopeKey === legacyScopeKey &&
          claim.sourceId === sourceId && current !== null;
      }
      const recovered = { ...expected, id, scopeKey };
      if (current && !isDeepStrictEqual(current, recovered)) {
        return false;
      }
      return documentStore.writeBatchIfUnchanged({
        expected: { collection: LEGACY_CURSOR_CLAIMS_COLLECTION, id: legacyId, document: null },
        unchanged: [
          { collection: EXTRACTION_CURSORS_COLLECTION, id: legacyId, document: legacy },
          { collection: EXTRACTION_CURSORS_COLLECTION, id, document: current },
        ],
        set: [
          { collection: EXTRACTION_CURSORS_COLLECTION, id, document: recovered },
          { collection: LEGACY_CURSOR_CLAIMS_COLLECTION, id: legacyId,
            document: { id: legacyId, legacyScopeKey, scopeKey, sourceId, schemaVersion: 1 } },
        ],
      });
    },
    async record(recordInput) {
      assertStorageSafeExternalValue(recordInput, "cursor");
      assertThrough(recordInput.through);
      const scopeKey = scopeToKey(recordInput.scope);
      const sourceId = assertSourceId(recordInput.sourceId);
      const id = cursorId(scopeKey, sourceId);

      for (let writeAttempt = 0; writeAttempt < 8; writeAttempt += 1) {
        const stored = validateCurrent(await documentStore.get<ExtractionCursor>(
          EXTRACTION_CURSORS_COLLECTION,
          id,
        ), scopeKey, sourceId);
        const legacy = stored ? null : await readLegacy(recordInput.scope, sourceId);
        const current = stored ?? legacy;
        if (current && recordInput.through <= current.committedThrough) {
          return current;
        }
        let newerAttempt: ExtractionCursorAttempt | undefined;
        if (current && recordInput.through < current.lastAttempt.through) {
          if (!isTerminal(recordInput.outcome)) {
            return current;
          }
          newerAttempt = current.lastAttempt;
        }
        const attempts = current?.lastAttempt.through === recordInput.through
          ? current.lastAttempt.attempts + 1
          : 1;
        const next: ExtractionCursor = {
          committedThrough: isTerminal(recordInput.outcome)
            ? Math.max(current?.committedThrough ?? 0, recordInput.through)
            : current?.committedThrough ?? 0,
          id,
          lastAttempt: newerAttempt
            ? newerAttempt
            : {
                attempts,
                ...(recordInput.errorCode === undefined
                  ? {}
                  : { errorCode: recordInput.errorCode }),
                outcome: recordInput.outcome,
                through: recordInput.through,
                updatedAt: now(),
              },
          schemaVersion: 1,
          scopeKey,
          sourceId,
        };
        const committed = await documentStore.writeBatchIfUnchanged({
          expected: {
            collection: EXTRACTION_CURSORS_COLLECTION,
            document: stored,
            id,
          },
          ...(legacy ? {
            unchanged: [{
              collection: EXTRACTION_CURSORS_COLLECTION,
              document: legacy,
              id: legacy.id,
            }, {
              collection: LEGACY_CURSOR_CLAIMS_COLLECTION,
              document: null,
              id: legacy.id,
            }],
          } : {}),
          set: [...(legacy ? [{
            collection: LEGACY_CURSOR_CLAIMS_COLLECTION,
            id: legacy.id,
            document: { id: legacy.id, legacyScopeKey: legacy.scopeKey, scopeKey, sourceId, schemaVersion: 1 },
          }] : []), {
            collection: EXTRACTION_CURSORS_COLLECTION,
            document: next,
            id,
          }],
        });
        if (committed) {
          return next;
        }
      }
      throw new Error("Extraction cursor could not be committed after retries.");
    },
  };
}
