import { Buffer } from "node:buffer";

export interface MemoryScope {
  userId: string;
  tenantId?: string;
  workspaceId?: string;
  agentId?: string;
  sessionId?: string;
}

function normalizeOptional(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeScope(scope: MemoryScope): MemoryScope {
  const userId = scope.userId.trim();

  if (userId.length === 0) {
    throw new Error("MemoryScope requires a non-empty userId");
  }

  return {
    userId,
    tenantId: normalizeOptional(scope.tenantId),
    workspaceId: normalizeOptional(scope.workspaceId),
    agentId: normalizeOptional(scope.agentId),
    sessionId: normalizeOptional(scope.sessionId),
  };
}

const SCOPE_KEY_VERSION = "gm2:";

function scopeComponents(scope: MemoryScope): Array<string | null> {
  const normalized = normalizeScope(scope);
  return [
    normalized.userId,
    normalized.tenantId ?? null,
    normalized.workspaceId ?? null,
    normalized.agentId ?? null,
    normalized.sessionId ?? null,
  ];
}

function encodeComponent(value: string | null): string {
  // JSON escapes lone surrogates before UTF-8 encoding, preserving every JS
  // string. The base64url alphabet cannot contain the field separator.
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function scopeToKey(scope: MemoryScope): string {
  // No v2 key contains "::". Every legacy key contains at least four such
  // separators, so an arbitrary legacy user ID cannot impersonate a v2 key.
  return SCOPE_KEY_VERSION + scopeComponents(scope).map(encodeComponent).join(":");
}

export function scopeToPrefix(scope: MemoryScope): string {
  // Preserve an explicitly provided empty/blank session as an exact selector.
  if (scope.sessionId !== undefined) {
    return scopeToKey(scope);
  }
  return SCOPE_KEY_VERSION + scopeComponents(scope).slice(0, 4)
    .map(encodeComponent).join(":") + ":";
}

export function parseScopeKey(key: string): MemoryScope | null {
  if (!key.startsWith(SCOPE_KEY_VERSION)) return null;
  const encoded = key.slice(SCOPE_KEY_VERSION.length).split(":");
  if (encoded.length !== 5 || encoded.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) {
    return null;
  }
  try {
    const values: unknown[] = encoded.map((part) =>
      JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as unknown
    );
    if (typeof values[0] !== "string" || values.slice(1).some((value) =>
      value !== null && typeof value !== "string"
    )) return null;
    const [userId, tenantId, workspaceId, agentId, sessionId] = values as [
      string, string | null, string | null, string | null, string | null,
    ];
    const scope = normalizeScope({
      userId,
      tenantId: tenantId ?? undefined,
      workspaceId: workspaceId ?? undefined,
      agentId: agentId ?? undefined,
      sessionId: sessionId ?? undefined,
    });
    // Reject alternate encodings, whitespace, empty optional strings, invalid
    // UTF-8, and any representation other than the one emitted by this version.
    return scopeToKey(scope) === key ? scope : null;
  } catch {
    return null;
  }
}

/** Compatibility only. Never use this non-injective key for new identity. */
export function legacyScopeToKey(scope: MemoryScope): string {
  return scopeComponents(scope).map((value) => value ?? "").join("::");
}

/** Return an owner only when all four old boundaries are provably unique. */
export function decodeLegacyScopeKey(key: string): MemoryScope | null {
  const parts = key.split("::");
  if (parts.length !== 5 ||
    parts.slice(0, 4).some((part) => part.endsWith(":")) ||
    parts.slice(1).some((part) => part.startsWith(":"))) {
    return null;
  }
  // Four non-overlapping separator pairs exhaust all possible pairs. An odd
  // colon adjacent to a boundary could move between fields, so reject it.
  // Isolated colons inside a field (or at the outer endpoints) are unambiguous.
  try {
    const scope = normalizeScope({
      userId: parts[0]!,
      tenantId: parts[1],
      workspaceId: parts[2],
      agentId: parts[3],
      sessionId: parts[4],
    });
    return legacyScopeToKey(scope) === key ? scope : null;
  } catch {
    return null;
  }
}

export class LegacyScopeKeyError extends Error {
  readonly code = "GOODMEMORY_LEGACY_SCOPE_AMBIGUOUS";
  readonly legacyKey: string;

  constructor(legacyKey: string, message?: string) {
    super(message ?? "Legacy scope ownership is ambiguous. The original data is preserved. " +
      "Confirm ownership from a trusted source, then use recoverLegacyState with the " +
      "original payload and exact scope; do not retry with a guessed owner.");
    this.name = "LegacyScopeKeyError";
    this.legacyKey = legacyKey;
  }
}

export function isSameScope(left: MemoryScope, right: MemoryScope): boolean {
  return scopeToKey(left) === scopeToKey(right);
}

export function isSameDurableScope(
  left: MemoryScope,
  right: MemoryScope,
): boolean {
  const normalizedLeft = normalizeScope(left);
  const normalizedRight = normalizeScope(right);

  return normalizedLeft.userId === normalizedRight.userId &&
    normalizedLeft.tenantId === normalizedRight.tenantId &&
    normalizedLeft.workspaceId === normalizedRight.workspaceId &&
    normalizedLeft.agentId === normalizedRight.agentId;
}
