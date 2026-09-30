import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  decodeLegacyScopeKey,
  legacyScopeToKey,
  LegacyScopeKeyError,
  parseScopeKey,
  scopeToKey,
  scopeToPrefix,
} from "../domain/scope";
import type { MemoryScope } from "../domain/scope";
import type { LegacySessionScope, SessionStateKind } from "./contracts";

/** Raw JSON snapshots keep preserved legacy rows byte-for-byte intact. */
export type SessionStateSnapshot = ReadonlyMap<string, string>;
export interface SessionStatePlan<T> {
  result: T;
  set: Array<[string, string]>;
  delete: string[];
}
export interface CompatibleSessionStateStore<T> {
  set(scope: MemoryScope, value: T): Promise<void>;
  setIfUnchanged(scope: MemoryScope, expected: T | null, next: T): Promise<boolean>;
  get(scope: MemoryScope): Promise<T | null>;
  deleteIfUnchanged(scope: MemoryScope, expected: T): Promise<boolean>;
  deleteByScope(scope: MemoryScope): Promise<number>;
  listLegacyScopes(kind: SessionStateKind): Promise<LegacySessionScope[]>;
  recoverLegacyState(scope: MemoryScope, legacyKey: string, expected: T): Promise<boolean>;
}

export function legacyResolutionKey(legacyKey: string): string {
  // Legacy keys contain at least four "::" delimiters; v2 and marker keys never
  // contain "::". Prefix-looking legacy user IDs cannot enter either namespace.
  return `gm2r:${Buffer.from(JSON.stringify(legacyKey), "utf8").toString("base64url")}`;
}

export function sessionScopeKeys(scope: MemoryScope): [string, string, string] {
  const legacyKey = legacyScopeToKey(scope);
  return [scopeToKey(scope), legacyKey, legacyResolutionKey(legacyKey)];
}

function isLegacyKey(key: string): boolean {
  return key.includes("::");
}

function emptyPlan<T>(result: T): SessionStatePlan<T> {
  return { result, set: [], delete: [] };
}

function payloadMatches(json: string | undefined, expected: unknown): boolean {
  return json !== undefined && isDeepStrictEqual(JSON.parse(json), JSON.parse(JSON.stringify(expected)));
}

interface ResolutionMarker {
  version: 2;
  ownerKey: string;
  sourceDigest: string;
}

function readResolution(snapshot: SessionStateSnapshot, legacyKey: string): ResolutionMarker | null {
  const json = snapshot.get(legacyResolutionKey(legacyKey));
  if (json === undefined) return null;
  try {
    const value: unknown = JSON.parse(json);
    if (typeof value === "object" && value !== null) {
      const marker = value as Partial<ResolutionMarker>;
      const owner = typeof marker.ownerKey === "string" ? parseScopeKey(marker.ownerKey) : null;
      if (marker.version === 2 && owner !== null && legacyScopeToKey(owner) === legacyKey &&
        typeof marker.sourceDigest === "string" && /^[a-f0-9]{64}$/.test(marker.sourceDigest)) {
        return marker as ResolutionMarker;
      }
    }
  } catch {
    // A corrupt resolution is not proof that the original has a known owner.
  }
  throw new LegacyScopeKeyError(legacyKey,
    "Legacy ownership resolution metadata is invalid. The original data is preserved. " +
    "Stop legacy writers and restore an intact ownership claim from a trusted backup; do not guess or overwrite the owner.");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sourceDigest(json: string): string {
  return createHash("sha256").update(canonicalJson(JSON.parse(json))).digest("hex");
}

function resolutionJson(scope: MemoryScope, originalJson: string): string {
  return JSON.stringify({ version: 2, ownerKey: scopeToKey(scope), sourceDigest: sourceDigest(originalJson) });
}

function assertResolvedOriginalUnchanged(snapshot: SessionStateSnapshot, legacyKey: string): void {
  const original = snapshot.get(legacyKey);
  if (original === undefined) return;
  const marker = readResolution(snapshot, legacyKey);
  if (marker?.sourceDigest !== sourceDigest(original)) {
    throw new LegacyScopeKeyError(legacyKey,
      "Preserved legacy state changed after ownership was resolved. No data was deleted. " +
      "Stop legacy writers and verify the changed original against a trusted backup before retrying deletion.");
  }
}

/** Only a valid durable ownership claim may suppress legacy fallback. */
function unresolvedLegacy(snapshot: SessionStateSnapshot, legacyKey: string): boolean {
  const marker = readResolution(snapshot, legacyKey);
  return snapshot.has(legacyKey) && marker === null;
}

function getSessionJson(snapshot: SessionStateSnapshot, scope: MemoryScope): string | undefined {
  const [key, legacyKey] = sessionScopeKeys(scope);
  if (unresolvedLegacy(snapshot, legacyKey)) {
    const owner = decodeLegacyScopeKey(legacyKey);
    if (owner === null || scopeToKey(owner) !== key) {
      throw new LegacyScopeKeyError(legacyKey);
    }
    return snapshot.get(key) ?? snapshot.get(legacyKey);
  }
  return snapshot.get(key);
}

export function readSessionValue<T>(snapshot: SessionStateSnapshot, scope: MemoryScope): T | null {
  const json = getSessionJson(snapshot, scope);
  return json === undefined ? null : JSON.parse(json) as T;
}

function claimSafeLegacy<T>(plan: SessionStatePlan<T>, snapshot: SessionStateSnapshot, scope: MemoryScope): void {
  const [, legacyKey, markerKey] = sessionScopeKeys(scope);
  if (unresolvedLegacy(snapshot, legacyKey)) {
    plan.set.push([markerKey, resolutionJson(scope, snapshot.get(legacyKey)!)]);
  }
}

export function planSessionSet<T>(snapshot: SessionStateSnapshot, scope: MemoryScope, next: T,
  expected?: { value: T | null }): SessionStatePlan<boolean> {
  const current = getSessionJson(snapshot, scope);
  if (expected && (expected.value === null
    ? current !== undefined
    : !payloadMatches(current, expected.value))) {
    return emptyPlan(false);
  }
  const plan = emptyPlan(true);
  plan.set.push([scopeToKey(scope), JSON.stringify(next)]);
  claimSafeLegacy(plan, snapshot, scope);
  return plan;
}

export function planSessionDelete<T>(snapshot: SessionStateSnapshot, scope: MemoryScope, expected: T): SessionStatePlan<boolean> {
  const current = getSessionJson(snapshot, scope);
  if (!payloadMatches(current, expected)) return emptyPlan(false);
  const plan = emptyPlan(true);
  const [key, legacyKey] = sessionScopeKeys(scope);
  plan.delete.push(key);
  claimSafeLegacy(plan, snapshot, scope);
  if (unresolvedLegacy(snapshot, legacyKey)) {
    plan.delete.push(legacyKey);
  } else if (readResolution(snapshot, legacyKey)?.ownerKey === key) {
    assertResolvedOriginalUnchanged(snapshot, legacyKey);
    plan.delete.push(legacyKey);
  }
  return plan;
}

export function planSessionDeleteByScope(snapshot: SessionStateSnapshot, scope: MemoryScope): SessionStatePlan<number> {
  const exact = scope.sessionId !== undefined;
  const key = scopeToKey(scope);
  const prefix = scopeToPrefix(scope);
  const legacyPrefix = legacyScopeToKey({ ...scope, sessionId: undefined });
  const legacyExact = legacyScopeToKey(scope);
  const removed = new Set<string>();
  const plan = emptyPlan(0);
  // Plan all changes before returning. An ambiguous candidate aborts without
  // partial deletion of either modern or uniquely owned legacy state.
  for (const candidate of snapshot.keys()) {
    if (!isLegacyKey(candidate)) {
      if (candidate === key || (!exact && candidate.startsWith(prefix))) {
        const owner = parseScopeKey(candidate);
        if (owner === null) continue;
        readResolution(snapshot, legacyScopeToKey(owner));
        removed.add(candidate);
        plan.delete.push(candidate);
      }
      continue;
    }
    if (!(exact ? candidate === legacyExact : candidate.startsWith(legacyPrefix))) continue;
    const resolvedOwner = readResolution(snapshot, candidate)?.ownerKey ?? null;
    if (resolvedOwner !== null) {
      // Once ownership is trusted, normal deletion erases the preserved payload
      // too. Keep its payload-free claim marker so old imports cannot reclaim it.
      if (exact ? resolvedOwner === key : resolvedOwner.startsWith(prefix)) {
        assertResolvedOriginalUnchanged(snapshot, candidate);
        plan.delete.push(candidate);
      }
      continue;
    }
    if (!unresolvedLegacy(snapshot, candidate)) continue;
    const owner = decodeLegacyScopeKey(candidate);
    if (owner === null) throw new LegacyScopeKeyError(candidate);
    const ownerKey = scopeToKey(owner);
    if (exact ? ownerKey !== key : !ownerKey.startsWith(prefix)) {
      throw new LegacyScopeKeyError(candidate);
    }
    removed.add(ownerKey);
    plan.set.push([legacyResolutionKey(candidate), resolutionJson(owner, snapshot.get(candidate)!)]);
    plan.delete.push(candidate);
  }
  plan.result = removed.size;
  return plan;
}

export function listLegacySessionScopes(snapshot: SessionStateSnapshot, kind: SessionStateKind): LegacySessionScope[] {
  return [...snapshot.keys()].filter(isLegacyKey).sort().map((legacyKey) => {
    const owner = readResolution(snapshot, legacyKey)?.ownerKey ?? null;
    return {
      kind,
      legacyKey,
      scope: decodeLegacyScopeKey(legacyKey),
      resolvedTo: owner === null ? null : parseScopeKey(owner),
    };
  });
}

export function planLegacySessionRecovery<T>(snapshot: SessionStateSnapshot, scope: MemoryScope,
  legacyKey: string, expected: T): SessionStatePlan<boolean> {
  const key = scopeToKey(scope);
  const marker = readResolution(snapshot, legacyKey);
  if (legacyScopeToKey(scope) !== legacyKey || !payloadMatches(snapshot.get(legacyKey), expected)) {
    return emptyPlan(false);
  }
  const markerKey = legacyResolutionKey(legacyKey);
  const target = snapshot.get(key);
  if (marker !== null) {
    // Idempotent only for an unchanged, still-present target. Never resurrect
    // a target deleted after recovery, even for the same trusted owner.
    return emptyPlan(marker.ownerKey === key &&
      marker.sourceDigest === sourceDigest(snapshot.get(legacyKey)!) && payloadMatches(target, expected));
  }
  if (target !== undefined && !payloadMatches(target, expected)) return emptyPlan(false);
  const plan = emptyPlan(true);
  if (target === undefined) plan.set.push([key, JSON.stringify(expected)]);
  plan.set.push([markerKey, resolutionJson(scope, snapshot.get(legacyKey)!)]);
  return plan;
}
