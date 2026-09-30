import { LegacyScopeKeyError } from "../domain/scope";
import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";

import type { GoodMemory } from "../api/contracts";
import { buildWritebackScopeDigest } from "../install/hostWritebackAuditLedger";
import {
  getReviewCandidate,
  listReviewCandidates,
  type InspectorReviewCandidateStatus,
} from "../install/hostReviewQueue";
import { SCOPE_CATALOG_COLLECTION } from "../recall/projections/contracts";
import type { DocumentStore } from "../storage/contracts";
import {
  appendInspectorAuditEvent,
  readInspectorAuditLedger,
} from "./auditLog";
import {
  createEntityTag,
  findAdminMemory,
  findAdminScope,
  InvalidAdminMemoryCursorError,
  isAdminMemoryCollection,
  listAdminMemories,
  listAdminScopes,
  resolveAdminScope,
} from "./adminMemory";
import {
  approveCandidate,
  listReviewCandidateViews,
  releaseApprovedCandidate,
  rejectCandidate,
} from "./candidateReview";
import { sanitizeViewerValue } from "./redaction";

const ADMIN_API_PREFIX = "/admin/v1";
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;
const MAX_JSON_BODY_CHARS = 64 * 1024;
const MAX_IDEMPOTENCY_ENTRIES = 500;

interface AdminOutcome {
  data: unknown;
  etag?: string;
  status: number;
}

interface IdempotencyEntry {
  fingerprint: string;
  outcome: AdminOutcome;
}

class AdminApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export interface AdminApi {
  fetch(request: Request): Promise<Response>;
}

export interface CreateAdminApiInput {
  allowedScopeKey?: string;
  documentStore: DocumentStore;
  memory: GoodMemory;
  token: string;
  homeRoot?: string;
  now?: () => Date;
  newActionId?: () => string;
  newRequestId?: () => string;
  readOnly?: boolean;
}

export function createAdminApi(input: CreateAdminApiInput): AdminApi {
  const now = input.now ?? (() => new Date());
  const newActionId = input.newActionId ?? (() => `insp_${randomBytes(9).toString("hex")}`);
  const newRequestId = input.newRequestId ?? (() => `req_${randomBytes(9).toString("hex")}`);
  const idempotency = new Map<string, IdempotencyEntry>();

  async function route(request: Request, url: URL): Promise<AdminOutcome> {
    const method = request.method.toUpperCase();
    const path = url.pathname;
    if (method === "GET" && path === `${ADMIN_API_PREFIX}/descriptor`) {
      return {
        data: {
          bindHost: "127.0.0.1",
          mutationRoutes: !input.readOnly,
          readOnly: input.readOnly === true,
          tokenRequired: true,
        },
        status: 200,
      };
    }
    if (input.readOnly && isAdminMutationRoute(method, path)) {
      throw new AdminApiError(
        "read_only",
        "This Inspector instance is read-only.",
        405,
      );
    }
    if (method === "GET" && path === `${ADMIN_API_PREFIX}/scopes`) {
      const limit = readLimit(url);
      const cursor = readOptionalQuery(url, "cursor");
      const page = input.allowedScopeKey
        ? await findAdminScope({
            documentStore: input.documentStore,
            now,
            scopeKey: input.allowedScopeKey,
          }).then((scope) => ({
            items:
              scope && (cursor === undefined || scope.scopeKey > cursor)
                ? [scope].slice(0, limit)
                : [],
          }))
        : await listAdminScopes({
            cursor,
            documentStore: input.documentStore,
            limit,
            now,
          });
      return { data: page, status: 200 };
    }

    if (method === "GET" && path === `${ADMIN_API_PREFIX}/candidates`) {
      const scopeKey = readOptionalQuery(url, "scopeKey") ?? input.allowedScopeKey;
      assertAllowedScope(scopeKey);
      const status = readOptionalQuery(url, "status");
      if (status !== undefined && !isCandidateStatus(status)) {
        throw new AdminApiError(
          "invalid_candidate_status",
          "Unsupported candidate status.",
          400,
        );
      }
      const [candidates, views] = await Promise.all([
        listReviewCandidates({
          homeRoot: input.homeRoot,
          ...(scopeKey ? { scopeKey } : {}),
          ...(status ? { status } : {}),
        }),
        listReviewCandidateViews({
          homeRoot: input.homeRoot,
          ...(scopeKey ? { scopeKey } : {}),
          ...(status ? { status } : {}),
        }),
      ]);
      const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
      const cursor = readOptionalQuery(url, "cursor");
      const ordered = views
        .filter((view) => cursor === undefined || view.id > cursor)
        .sort((left, right) => left.id.localeCompare(right.id));
      const limit = readLimit(url);
      const page = ordered.slice(0, limit);
      return {
        data: {
          items: page.map((view) => {
            const candidate = byId.get(view.id)!;
            return {
              ...view,
              etag: createEntityTag(candidate),
              scopeKey: candidate.scopeKey,
            };
          }),
          ...(ordered.length > limit ? { nextCursor: page.at(-1)!.id } : {}),
        },
        status: 200,
      };
    }

    const candidateId = matchCandidateRoute(path);
    if (candidateId && method === "PATCH") {
      const body = await readJsonBody(request);
      return runIdempotentMutation(request, body, async () => {
        const candidate = await getReviewCandidate({
          homeRoot: input.homeRoot,
          id: candidateId,
        });
        if (!candidate) {
          throw new AdminApiError(
            "candidate_not_found",
            "Candidate not found.",
            404,
          );
        }
        const scopeKey = readRequiredString(body, "scopeKey");
        if (candidate.scopeKey !== scopeKey) {
          throw new AdminApiError(
            "candidate_scope_mismatch",
            "Candidate does not belong to this scope.",
            409,
          );
        }
        assertAllowedScope(scopeKey);
        requireEntityTag(request, createEntityTag(candidate));
        const requestedStatus = readRequiredString(body, "status");
        const reviewReason = readOptionalString(body, "reason");
        if (candidate.status === "pending" && requestedStatus === "approved") {
          const result = await approveCandidate({
            candidateId,
            scope: candidate.scope,
            reviewReason,
            deps: {
              homeRoot: input.homeRoot,
              memory: input.memory,
              newActionId,
              now,
            },
          });
          if (result.status !== "approved") {
            throw new AdminApiError(
              "candidate_transition_failed",
              `Candidate approval returned ${result.status}.`,
              409,
            );
          }
          return { data: result, status: 200 };
        }
        if (candidate.status === "pending" && requestedStatus === "rejected") {
          const result = await rejectCandidate({
            candidateId,
            scope: candidate.scope,
            reviewReason,
            deps: {
              homeRoot: input.homeRoot,
              memory: input.memory,
              newActionId,
              now,
            },
          });
          if (result.status !== "rejected") {
            throw new AdminApiError(
              "candidate_transition_failed",
              `Candidate rejection returned ${result.status}.`,
              409,
            );
          }
          return { data: result, status: 200 };
        }
        if (candidate.status === "approved" && requestedStatus === "released") {
          const result = await releaseApprovedCandidate({
            candidateId,
            scope: candidate.scope,
            reviewReason,
            deps: {
              homeRoot: input.homeRoot,
              memory: input.memory,
              newActionId,
              now,
            },
          });
          if (result.status !== "released") {
            throw new AdminApiError(
              "candidate_transition_failed",
              `Candidate release returned ${result.status}.`,
              409,
            );
          }
          return { data: result, status: 200 };
        }
        throw new AdminApiError(
          "invalid_candidate_transition",
          `Candidate cannot transition from ${candidate.status} to ${requestedStatus}.`,
          409,
        );
      });
    }

    if (method === "GET" && path === `${ADMIN_API_PREFIX}/audit-events`) {
      const ledger = await readInspectorAuditLedger(input.homeRoot);
      const cursor = readOptionalQuery(url, "cursor");
      const scopeKey = readOptionalQuery(url, "scopeKey") ?? input.allowedScopeKey;
      assertAllowedScope(scopeKey);
      const scopeDigest = scopeKey
        ? await findAdminScope({
            documentStore: input.documentStore,
            now,
            scopeKey,
          }).then((scope) =>
            scope ? buildWritebackScopeDigest(scope.scope) : undefined,
          )
        : undefined;
      if (scopeKey && !scopeDigest) {
        throw new AdminApiError("scope_not_found", "Scope not found.", 404);
      }
      const ordered = ledger.events
        .filter(
          (event) =>
            scopeDigest === undefined || event.scopeDigest === scopeDigest,
        )
        .sort(
        (left, right) =>
          right.occurredAt.localeCompare(left.occurredAt) ||
          right.actionId.localeCompare(left.actionId),
      );
      const start = cursor
        ? ordered.findIndex((event) => auditCursor(event) === cursor) + 1
        : 0;
      const limit = readLimit(url);
      const page = start > 0 || !cursor
        ? ordered.slice(start, start + limit)
        : [];
      return {
        data: {
          items: page,
          ...(start + limit < ordered.length
            ? { nextCursor: auditCursor(page.at(-1)!) }
            : {}),
        },
        status: 200,
      };
    }

    const scopeRoute = matchScopeRoute(path);
    if (scopeRoute && method === "DELETE") {
      assertAllowedScope(scopeRoute);
      const body = await readJsonBody(request);
      return runIdempotentMutation(request, body, async () => {
        const summary = await findAdminScope({
          documentStore: input.documentStore,
          now,
          scopeKey: scopeRoute,
        });
        if (!summary) {
          throw new AdminApiError("scope_not_found", "Scope not found.", 404);
        }
        requireEntityTag(request, summary.etag);
        if (readRequiredString(body, "confirmScopeKey") !== scopeRoute) {
          throw new AdminApiError(
            "scope_confirmation_mismatch",
            "confirmScopeKey must exactly match the scope being deleted.",
            400,
          );
        }
        if (body.cascadeAware !== true) {
          throw new AdminApiError(
            "cascade_confirmation_required",
            "cascadeAware must be true before deleting a scope.",
            400,
          );
        }
        const result = await input.memory.deleteAllMemory({ scope: summary.scope });
        await input.documentStore.delete(
          SCOPE_CATALOG_COLLECTION,
          `scope:${scopeRoute}`,
        );
        await appendInspectorAuditEvent({
          homeRoot: input.homeRoot,
          event: {
            action: "delete-scope",
            actionId: newActionId(),
            occurredAt: now().toISOString(),
            resultStatus: "ok",
            scopeDigest: buildWritebackScopeDigest(summary.scope),
          },
        });
        return { data: result, status: 200 };
      });
    }

    const memoryRoute = matchMemoryRoute(path);
    if (memoryRoute && method === "GET" && memoryRoute.operation === "list") {
      assertAllowedScope(memoryRoute.scopeKey);
      const scope = await resolveAdminScope(
        input.documentStore,
        memoryRoute.scopeKey,
      );
      if (!scope) {
        throw new AdminApiError("scope_not_found", "Scope not found.", 404);
      }
      const collection = readOptionalQuery(url, "collection");
      if (collection !== undefined && !isAdminMemoryCollection(collection)) {
        throw new AdminApiError(
          "invalid_collection",
          "Unsupported memory collection.",
          400,
        );
      }
      const page = await listAdminMemories({
        ...(collection ? { collection } : {}),
        cursor: readOptionalQuery(url, "cursor"),
        documentStore: input.documentStore,
        limit: readLimit(url),
        scope,
      });
      return { data: page, status: 200 };
    }

    if (memoryRoute && method === "DELETE" && memoryRoute.operation === "memory") {
      assertAllowedScope(memoryRoute.scopeKey);
      return runIdempotentMutation(request, null, async () => {
        const memory = await findAdminMemory({
          documentStore: input.documentStore,
          id: memoryRoute.memoryId,
          scopeKey: memoryRoute.scopeKey,
        });
        if (!memory) {
          throw new AdminApiError("memory_not_found", "Memory not found.", 404);
        }
        requireEntityTag(request, memory.item.etag);
        const result = await input.memory.forget({
          memoryId: memory.id,
          scope: memory.scope,
        });
        await appendInspectorAuditEvent({
          homeRoot: input.homeRoot,
          event: {
            action: "forget",
            actionId: newActionId(),
            occurredAt: now().toISOString(),
            resultStatus: result.forgotten ? "ok" : "error",
            scopeDigest: buildWritebackScopeDigest(memory.scope),
            targetId: memory.id,
            ...(result.forgotten
              ? {}
              : { errorMessage: "no matching memory in exact scope" }),
          },
        });
        return {
          data: { deleted: result.forgotten, memoryId: memory.id },
          status: result.forgotten ? 200 : 409,
        };
      });
    }

    if (memoryRoute && method === "POST" && memoryRoute.operation === "revision") {
      assertAllowedScope(memoryRoute.scopeKey);
      const body = await readJsonBody(request);
      return runIdempotentMutation(request, body, async (idempotencyKey) => {
        const memory = await findAdminMemory({
          documentStore: input.documentStore,
          id: memoryRoute.memoryId,
          scopeKey: memoryRoute.scopeKey,
        });
        if (!memory) {
          throw new AdminApiError("memory_not_found", "Memory not found.", 404);
        }
        if (!memory.item.revisable) {
          throw new AdminApiError(
            "memory_not_revisable",
            "This memory type cannot be revised.",
            409,
          );
        }
        requireEntityTag(request, memory.item.etag);
        const content = readRequiredString(body, "content");
        const reason = readOptionalString(body, "reason") ?? "manual_review";
        const result = await input.memory.reviseMemory({
          idempotencyKey,
          reason,
          revision: { content },
          scope: memory.scope,
          target: { memoryId: memory.id },
        });
        const succeeded = result.outcome === "superseded";
        await appendInspectorAuditEvent({
          homeRoot: input.homeRoot,
          event: {
            action: "revise",
            actionId: newActionId(),
            contentPreview: String(sanitizeViewerValue(content, memory.scope)),
            occurredAt: now().toISOString(),
            resultStatus: succeeded ? "ok" : "error",
            scopeDigest: buildWritebackScopeDigest(memory.scope),
            targetId: memory.id,
            ...(succeeded ? {} : { errorMessage: `revision ${result.outcome}` }),
          },
        });
        return { data: result, status: succeeded ? 200 : 409 };
      });
    }

    if (method === "POST" && path === `${ADMIN_API_PREFIX}/recall-traces`) {
      const body = await readJsonBody(request);
      const scopeKey = readRequiredString(body, "scopeKey");
      assertAllowedScope(scopeKey);
      const scope = await resolveAdminScope(input.documentStore, scopeKey);
      if (!scope) {
        throw new AdminApiError("scope_not_found", "Scope not found.", 404);
      }
      const recall = await input.memory.recall({
        query: readRequiredString(body, "query"),
        retrievalProfile: "coding_agent",
        scope,
      });
      const trace = sanitizeViewerValue(
        {
          candidateTraces: recall.metadata.candidateTraces,
          hits: recall.metadata.hits,
          latencyMs: recall.metadata.latencyMs,
          policyApplied: recall.metadata.policyApplied,
          retrievalTrace: recall.metadata.retrievalTrace,
          routingDecision: recall.metadata.routingDecision,
          tokenCount: recall.metadata.tokenCount,
          verificationHints: recall.metadata.verificationHints,
        },
        scope,
      );
      return { data: trace, status: 200 };
    }

    throw new AdminApiError("not_found", "Admin API route not found.", 404);
  }

  function assertAllowedScope(scopeKey: string | undefined): void {
    if (
      input.allowedScopeKey !== undefined &&
      scopeKey !== input.allowedScopeKey
    ) {
      throw new AdminApiError(
        "scope_not_found",
        "Scope not found in this Inspector instance.",
        404,
      );
    }
  }

  async function runIdempotentMutation(
    request: Request,
    body: Record<string, unknown> | null,
    operation: (idempotencyKey: string) => Promise<AdminOutcome>,
  ): Promise<AdminOutcome> {
    const key = request.headers.get("idempotency-key")?.trim();
    if (!key) {
      throw new AdminApiError(
        "idempotency_key_required",
        "Idempotency-Key is required for mutations.",
        428,
      );
    }
    const cacheKey = `${request.method.toUpperCase()} ${new URL(request.url).pathname} ${key}`;
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(body ?? null))
      .digest("hex");
    const cached = idempotency.get(cacheKey);
    if (cached) {
      if (cached.fingerprint !== fingerprint) {
        throw new AdminApiError(
          "idempotency_conflict",
          "Idempotency-Key was already used with a different request body.",
          409,
        );
      }
      return cached.outcome;
    }
    const outcome = await operation(key);
    idempotency.set(cacheKey, { fingerprint, outcome });
    if (idempotency.size > MAX_IDEMPOTENCY_ENTRIES) {
      idempotency.delete(idempotency.keys().next().value!);
    }
    return outcome;
  }

  return {
    async fetch(request) {
      const requestId = newRequestId();
      const url = new URL(request.url);
      if (request.headers.get("authorization") !== `Bearer ${input.token}`) {
        return errorResponse(
          new AdminApiError(
            "unauthorized",
            "A valid Bearer token is required.",
            401,
          ),
          requestId,
        );
      }
      try {
        return outcomeResponse(await route(request, url), requestId);
      } catch (error) {
        if (error instanceof AdminApiError) {
          return errorResponse(error, requestId);
        }
        if (error instanceof LegacyScopeKeyError) {
          return errorResponse(new AdminApiError(error.code,
            "Legacy scope ownership could not be verified. Original data is preserved. " +
            "Use the migration guide's trusted ownership recovery before retrying.", 409), requestId);
        }
        if (error instanceof InvalidAdminMemoryCursorError) {
          return errorResponse(
            new AdminApiError("invalid_cursor", error.message, 400),
            requestId,
          );
        }
        console.error("[goodmemory:inspector-admin] request failed", {
          error,
          method: request.method,
          path: url.pathname,
          requestId,
        });
        return errorResponse(
          new AdminApiError(
            "internal_error",
            "The Inspector could not complete this request.",
            500,
          ),
          requestId,
        );
      }
    },
  };
}

function matchMemoryRoute(path: string):
  | { operation: "list"; scopeKey: string }
  | { memoryId: string; operation: "memory" | "revision"; scopeKey: string }
  | null {
  const segments = path.split("/").filter(Boolean);
  if (
    segments[0] !== "admin" ||
    segments[1] !== "v1" ||
    segments[2] !== "scopes" ||
    segments[4] !== "memories"
  ) {
    return null;
  }
  const scopeKey = decodePathSegment(segments[3]);
  if (segments.length === 5) {
    return { operation: "list", scopeKey };
  }
  const memoryId = decodePathSegment(segments[5]);
  if (segments.length === 6) {
    return { memoryId, operation: "memory", scopeKey };
  }
  if (segments.length === 7 && segments[6] === "revisions") {
    return { memoryId, operation: "revision", scopeKey };
  }
  return null;
}

function matchCandidateRoute(path: string): string | null {
  const segments = path.split("/").filter(Boolean);
  return segments.length === 4 &&
    segments[0] === "admin" &&
    segments[1] === "v1" &&
    segments[2] === "candidates"
    ? decodePathSegment(segments[3])
    : null;
}

function matchScopeRoute(path: string): string | null {
  const segments = path.split("/").filter(Boolean);
  return segments.length === 4 &&
    segments[0] === "admin" &&
    segments[1] === "v1" &&
    segments[2] === "scopes"
    ? decodePathSegment(segments[3])
    : null;
}

function isCandidateStatus(value: string): value is InspectorReviewCandidateStatus {
  return ["approving", "approved", "pending", "released", "rejected"].includes(
    value,
  );
}

function auditCursor(event: { actionId: string; occurredAt: string }): string {
  return Buffer.from(`${event.occurredAt}\0${event.actionId}`).toString("base64url");
}

function isAdminMutationRoute(method: string, path: string): boolean {
  if (method === "DELETE" || method === "PATCH" || method === "PUT") {
    return true;
  }
  return method === "POST" && path !== `${ADMIN_API_PREFIX}/recall-traces`;
}

function readLimit(url: URL): number {
  const raw = url.searchParams.get("limit");
  if (raw === null) {
    return DEFAULT_PAGE_LIMIT;
  }
  if (!/^[1-9]\d*$/u.test(raw)) {
    throw new AdminApiError("invalid_limit", "limit must be a positive integer.", 400);
  }
  return Math.min(Number(raw), MAX_PAGE_LIMIT);
}

function readOptionalQuery(url: URL, key: string): string | undefined {
  const value = url.searchParams.get(key);
  return value && value.trim() === value ? value : undefined;
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > MAX_JSON_BODY_CHARS) {
    throw new AdminApiError("body_too_large", "Request body is too large.", 413);
  }
  let parsed: unknown;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    throw new AdminApiError("invalid_json", "Request body must be valid JSON.", 400);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AdminApiError("invalid_body", "Request body must be a JSON object.", 400);
  }
  return parsed as Record<string, unknown>;
}

function readRequiredString(body: Record<string, unknown>, key: string): string {
  const value = readOptionalString(body, key);
  if (!value) {
    throw new AdminApiError("invalid_body", `${key} is required.`, 400);
  }
  return value;
}

function readOptionalString(
  body: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = body[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function requireEntityTag(request: Request, current: string): void {
  const supplied = request.headers.get("if-match");
  if (!supplied) {
    throw new AdminApiError(
      "precondition_required",
      "If-Match is required for this mutation.",
      428,
    );
  }
  if (supplied !== current) {
    throw new AdminApiError(
      "etag_mismatch",
      "The resource changed; refresh it before retrying.",
      412,
      { currentEtag: current },
    );
  }
}

function decodePathSegment(value: string | undefined): string {
  if (!value) {
    throw new AdminApiError("invalid_path", "Missing path segment.", 400);
  }
  try {
    return decodeURIComponent(value);
  } catch {
    throw new AdminApiError("invalid_path", "Path segment is not valid UTF-8.", 400);
  }
}

function outcomeResponse(outcome: AdminOutcome, requestId: string): Response {
  const headers = responseHeaders(requestId);
  if (outcome.etag) {
    headers.set("etag", outcome.etag);
  }
  return new Response(`${JSON.stringify({ data: outcome.data })}\n`, {
    headers,
    status: outcome.status,
  });
}

function errorResponse(error: AdminApiError, requestId: string): Response {
  return new Response(
    `${JSON.stringify({
      error: {
        code: error.code,
        message: error.message,
        requestId,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    })}\n`,
    { headers: responseHeaders(requestId), status: error.status },
  );
}

function responseHeaders(requestId: string): Headers {
  return new Headers({
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    "x-request-id": requestId,
  });
}
