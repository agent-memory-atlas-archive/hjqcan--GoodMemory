import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import type { ArtifactSpillRecord } from "../domain/records";
import type { MemoryScope } from "../domain/scope";
import { isSameScope, legacyScopeToKey, scopeToKey } from "../domain/scope";
import type { DocumentStore } from "../storage/contracts";

export const ARTIFACT_SPILL_COLLECTION = "artifact_spills";
export const ARTIFACT_SPILL_PAYLOAD_COLLECTION = "artifact_spill_payloads_v1";
const MAX_SPILL_COMMIT_ATTEMPTS = 4;

export interface ArtifactSpillPayloadRecord {
  content: string;
  contentHash: string;
  createdAt: string;
  id: string;
  originalBytes: number;
  scope: MemoryScope;
}

export interface SpillInput {
  kind: ArtifactSpillRecord["kind"];
  sourceId: string;
  content: string;
  storageUri?: string;
}

export interface ArtifactSpilloverServiceConfig {
  documentStore: DocumentStore;
  previewChars?: number;
}

function buildStableHandle(scope: MemoryScope, sourceId: string): string {
  const value = `${scopeToKey(scope)}::${sourceId}`;
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }

  return hash.toString(36);
}

function buildPreview(content: string, previewChars: number): string {
  if (content.length <= previewChars) {
    return content;
  }

  return `${content.slice(0, previewChars).trimEnd()}...`;
}

function buildRecordId(scope: MemoryScope, sourceId: string): string {
  const identity = JSON.stringify([scopeToKey(scope), sourceId]);
  return `gm2spill:${Buffer.from(identity, "utf8").toString("base64url")}`;
}

function buildContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function buildPayloadId(scope: MemoryScope, contentHash: string): string {
  const identity = JSON.stringify([scopeToKey(scope), contentHash]);
  return `gm2payload:${Buffer.from(identity, "utf8").toString("base64url")}`;
}

function buildPayloadUri(payloadId: string): string {
  return `memory://artifact-spill-payloads/${encodeURIComponent(payloadId)}`;
}

function parsePayloadUri(storageUri: string): string | undefined {
  const prefix = "memory://artifact-spill-payloads/";
  if (!storageUri.startsWith(prefix)) {
    return undefined;
  }
  try {
    return decodeURIComponent(storageUri.slice(prefix.length));
  } catch {
    return undefined;
  }
}

export function createArtifactSpilloverService(
  config: ArtifactSpilloverServiceConfig,
) {
  const previewChars = Math.max(config.previewChars ?? 280, 8);
  const writeBatchIfUnchanged =
    config.documentStore.writeBatchIfUnchanged?.bind(config.documentStore);

  function ownsScope(value: { scope?: MemoryScope }, scope: MemoryScope): boolean {
    try {
      return value.scope !== undefined && isSameScope(value.scope, scope);
    } catch {
      return false;
    }
  }

  async function readLegacyRecord(scope: MemoryScope, sourceId: string) {
    const id = `${legacyScopeToKey(scope)}::${sourceId}`;
    const record = await config.documentStore.get<ArtifactSpillRecord>(
      ARTIFACT_SPILL_COLLECTION,
      id,
    );
    return record && record.id === id && record.sourceId === sourceId &&
        ownsScope(record, scope)
      ? record
      : null;
  }

  return {
    async spill(scope: MemoryScope, input: SpillInput): Promise<ArtifactSpillRecord> {
      const recordId = buildRecordId(scope, input.sourceId);
      const contentHash = buildContentHash(input.content);
      const payloadId = buildPayloadId(scope, contentHash);
      const originalBytes = new TextEncoder().encode(input.content).length;
      if (!writeBatchIfUnchanged) {
        throw new Error("Artifact spillover requires atomic document batches.");
      }

      for (let attempt = 0; attempt < MAX_SPILL_COMMIT_ATTEMPTS; attempt += 1) {
        const existing = await config.documentStore.get<ArtifactSpillRecord>(
          ARTIFACT_SPILL_COLLECTION,
          recordId,
        );
        if (existing && (
          !ownsScope(existing, scope) || existing.id !== recordId ||
          existing.sourceId !== input.sourceId
        )) {
          throw new Error(
            "Artifact spill identity does not match its versioned storage key; " +
              "the existing record is preserved for integrity investigation.",
          );
        }
        const legacy = existing ? null : await readLegacyRecord(scope, input.sourceId);
        const previous = existing ?? legacy;
        const createdAt = previous?.createdAt ?? new Date(0).toISOString();
        const payload: ArtifactSpillPayloadRecord = {
          content: input.content,
          contentHash,
          createdAt,
          id: payloadId,
          originalBytes,
          scope,
        };
        const record: ArtifactSpillRecord = {
          id: recordId,
          scope,
          kind: input.kind,
          sourceId: input.sourceId,
          preview: buildPreview(input.content, previewChars),
          replacementText:
            previous?.replacementText ??
            `[[spill:${input.kind}:${buildStableHandle(scope, input.sourceId)}]]`,
          storageUri: input.storageUri ?? buildPayloadUri(payloadId),
          originalBytes,
          contentHash,
          createdAt,
        };
        const committed = await writeBatchIfUnchanged({
          expected: {
            collection: ARTIFACT_SPILL_COLLECTION,
            document: existing,
            id: recordId,
          },
          ...(legacy ? {
            unchanged: [{
              collection: ARTIFACT_SPILL_COLLECTION,
              document: legacy,
              id: legacy.id,
            }],
          } : {}),
          set: [
            {
              collection: ARTIFACT_SPILL_PAYLOAD_COLLECTION,
              document: payload,
              id: payloadId,
            },
            {
              collection: ARTIFACT_SPILL_COLLECTION,
              document: record,
              id: recordId,
            },
          ],
        });
        if (committed) {
          return record;
        }
      }

      throw new Error(
        `Artifact spill commit conflicted ${MAX_SPILL_COMMIT_ATTEMPTS} times.`,
      );
    },

    async getBySource(
      scope: MemoryScope,
      sourceId: string,
    ): Promise<ArtifactSpillRecord | null> {
      const id = buildRecordId(scope, sourceId);
      const current = await config.documentStore.get<ArtifactSpillRecord>(
        ARTIFACT_SPILL_COLLECTION,
        id,
      );
      if (current) {
        return current.id === id && current.sourceId === sourceId && ownsScope(current, scope)
          ? current
          : null;
      }
      return readLegacyRecord(scope, sourceId);
    },

    async resolve(
      scope: MemoryScope,
      value: ArtifactSpillRecord | string,
    ): Promise<string | null> {
      if (typeof value !== "string" && !ownsScope(value, scope)) {
        return null;
      }
      const payloadIds = typeof value === "string"
        ? [parsePayloadUri(value)]
        : [
            buildPayloadId(scope, value.contentHash ?? ""),
            `${legacyScopeToKey(scope)}::${value.contentHash ?? ""}`,
          ];
      for (const payloadId of payloadIds) {
        if (!payloadId || ![
          "gm2payload:",
          `${legacyScopeToKey(scope)}::`,
        ].some((prefix) => payloadId.startsWith(prefix))) {
          continue;
        }
        const payload = await config.documentStore.get<ArtifactSpillPayloadRecord>(
          ARTIFACT_SPILL_PAYLOAD_COLLECTION,
          payloadId,
        );
        if (!payload || !ownsScope(payload, scope)) {
          continue;
        }
        if (
          payload.id !== payloadId ||
          ![
            buildPayloadId(scope, payload.contentHash),
            `${legacyScopeToKey(scope)}::${payload.contentHash}`,
          ].includes(payloadId) ||
          buildContentHash(payload.content) !== payload.contentHash
        ) {
          console.error("[goodmemory:spillover] payload integrity check failed", {
            payloadId,
          });
          return null;
        }
        return payload.content;
      }
      return null;
    },
  };
}
