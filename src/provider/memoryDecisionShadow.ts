import { createHash } from "node:crypto";
import type { MemoryCandidate } from "../domain/memoryCandidate";
import type { PreferenceMemory } from "../domain/records";
import { normalizeScope, scopeToKey, type MemoryScope } from "../domain/scope";
import { isRfc3339Instant } from "../domain/temporal";
import type { EvidenceRecord, SourceMessageRecord } from "../evidence/contracts";

/** Experimental, explicitly invoked shadow seam. Not installed in remember or write policy. */
export type MemoryShadowChoice = "keep" | "supersede" | "abstain";
type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;
export interface MemoryShadowContext {
  record: PreferenceMemory;
  evidence: EvidenceRecord[];
  sources: SourceMessageRecord[];
}
export interface MemoryDecisionSnapshotInput {
  scope: MemoryScope;
  candidate: Pick<MemoryCandidate, "id" | "content" | "kindHint">;
  /** Already admitted and redacted by the host, never raw unfiltered extraction. */
  source: SourceMessageRecord;
  /** UTF-16 offsets. Attribution is supplied by trusted host code, not a model. */
  span: { start: number; end: number; attribution: "direct_user" | "quoted_third_party" | "unknown" };
  previous: MemoryShadowContext;
  /** Host-computed eligibility, NOT permission to perform any of these operations. */
  allowedChoices: MemoryShadowChoice[];
  baseline: MemoryShadowChoice;
}
export type MemoryDecisionSnapshot = Immutable<MemoryDecisionSnapshotInput & {
  schemaVersion: 1;
  previousVersion: string;
  digest: string;
}>;
/** Baseline is evaluator-only; this digest binds only the provider-visible input. */
export type MemoryDecisionRequest = Omit<MemoryDecisionSnapshot, "baseline">;
export interface MemoryShadowProvider {
  readonly name: string;
  advise(snapshot: MemoryDecisionRequest, signal: AbortSignal): Promise<unknown>;
}
export interface MemoryShadowOptions {
  enabled?: boolean;
  provider: MemoryShadowProvider;
  /** Hash of the currently stored full record AND its supporting evidence/sources, or null if removed. Read only. */
  readCurrentVersion(signal: AbortSignal): Promise<string | null>;
  timeoutMs?: number;
  signal?: AbortSignal;
}
export type MemoryShadowCode = "disabled" | "advised" | "abstained" | "invalid_snapshot" |
  "invalid_response" | "stale_version" | "timeout" | "cancelled" | "provider_error";
export interface MemoryShadowReport {
  schemaVersion: 1;
  mode: "shadow";
  snapshotDigest: string | null;
  providerRequestDigest: string | null;
  previousVersion: string | null;
  provider: string;
  code: MemoryShadowCode;
  proposedDecision: MemoryShadowChoice;
  baseline: MemoryShadowChoice | null;
  agreesWithBaseline: boolean | null;
  evidenceSourceRecordIds: readonly string[];
  confidence: number | null;
  /** Literal false even when a provider reports confidence 1. */
  authorized: false;
  memoryMutated: false;
}

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid memory shadow input: ${message}`);
}
function stable(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") { ensure(Number.isFinite(value), "non-finite number"); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  ensure(typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype, "expected plain JSON");
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
}
const hash = (value: unknown): string => createHash("sha256").update(stable(value)).digest("hex");
function frozen<T>(value: T): Immutable<T> {
  if (value && typeof value === "object") { for (const child of Object.values(value)) frozen(child); Object.freeze(value); }
  return value as Immutable<T>;
}
const choices: readonly MemoryShadowChoice[] = ["keep", "supersede", "abstain"];
const isChoice = (value: unknown): value is MemoryShadowChoice => choices.includes(value as MemoryShadowChoice);
const durableKey = (scope: MemoryScope): string => scopeToKey({ ...scope, sessionId: undefined });
const dated = (value: string | undefined): number | null => {
  // Require an explicit timezone; do not let local runtime timezone invent an ordering.
  if (!value || !isRfc3339Instant(value)) return null;
  const time = Date.parse(value); return Number.isFinite(time) ? time : null;
};
function validateSource(source: SourceMessageRecord, scope: MemoryScope): void {
  ensure(source.schemaVersion === 1 && typeof source.id === "string" && source.id.length > 0, "source identity");
  ensure(typeof source.content === "string" && source.content.length <= 32768, "source size");
  ensure(createHash("sha256").update(source.content).digest("hex") === source.contentSha256, "source hash");
  ensure(durableKey(source) === durableKey(scope), "source durable scope");
}

/** Content-addressed version, not updatedAt and not a storage CAS token. Also binds supporting evidence and clocks. */
export function memoryShadowContextVersion(context: Immutable<MemoryShadowContext>): string {
  // Storage query order is not a semantic change. Preserve order inside each record.
  const byId = <T extends { readonly id: string }>(items: readonly T[]): T[] =>
    [...items].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  return hash({ record: context.record, evidence: byId(context.evidence), sources: byId(context.sources) });
}

export function createMemoryDecisionSnapshot(input: MemoryDecisionSnapshotInput): MemoryDecisionSnapshot {
  // JSON-only clone rejects functions, class instances and non-finite numbers; byte cap bounds transport/replay.
  const json = stable(input);
  ensure(Buffer.byteLength(json, "utf8") <= 131072, "snapshot size");
  const copy = JSON.parse(json) as MemoryDecisionSnapshotInput;
  // normalizeScope uses explicit undefined for missing dimensions. Keep the
  // actual provider envelope JSON-safe, not just its serialized/hash form.
  copy.scope = JSON.parse(stable(normalizeScope(copy.scope))) as MemoryScope;
  ensure(copy.candidate && copy.candidate.kindHint === "preference", "only preference candidates are supported");
  ensure(typeof copy.candidate.id === "string" && copy.candidate.id.length > 0, "candidate identity");
  validateSource(copy.source, copy.scope);
  ensure(scopeToKey(copy.source) === scopeToKey(copy.scope), "candidate source full scope");
  const span = copy.span;
  ensure(span && Number.isInteger(span.start) && Number.isInteger(span.end) && span.start >= 0 &&
    span.end > span.start && span.end <= copy.source.content.length, "source span");
  ensure(["direct_user", "quoted_third_party", "unknown"].includes(span.attribution), "attribution");
  ensure(copy.source.content.slice(span.start, span.end) === copy.candidate.content, "candidate must exactly match its source span");
  const previous = copy.previous;
  ensure(previous && previous.record && typeof previous.record.id === "string" && previous.record.id.length > 0, "previous identity");
  ensure(durableKey(previous.record) === durableKey(copy.scope), "previous durable scope");
  ensure(Array.isArray(previous.sources) && previous.sources.length > 0 && previous.sources.length <= 32, "previous source count");
  ensure(Array.isArray(previous.evidence) && previous.evidence.length > 0 && previous.evidence.length <= 32, "previous evidence count");
  const ids = new Set<string>();
  for (const source of previous.sources) { validateSource(source, copy.scope); ensure(!ids.has(source.id), "duplicate source"); ids.add(source.id); }
  ensure(!ids.has(copy.source.id), "candidate source must differ from previous source");
  const linked = new Set<string>();
  const evidenceIds = new Set<string>();
  for (const evidence of previous.evidence) {
    ensure(typeof evidence.id === "string" && evidence.id.length > 0, "evidence identity");
    ensure(!evidenceIds.has(evidence.id), "duplicate evidence"); evidenceIds.add(evidence.id);
    ensure(durableKey(evidence) === durableKey(copy.scope), "evidence durable scope");
    ensure(evidence.linkedMemoryIds.includes(previous.record.id), "evidence target");
    ensure(evidence.sourceRecordIds && evidence.sourceRecordIds.length > 0, "evidence source links");
    for (const id of evidence.sourceRecordIds) { ensure(ids.has(id), "unresolved evidence source"); linked.add(id); }
    ensure(evidence.sourceRecordIds.some((id) => previous.sources.find((source) => source.id === id)!.content.includes(evidence.excerpt)) &&
      evidence.excerpt.length > 0, "ungrounded previous evidence excerpt");
  }
  ensure(linked.size === ids.size, "unlinked previous source");
  ensure(Array.isArray(copy.allowedChoices) && copy.allowedChoices.every(isChoice) &&
    new Set(copy.allowedChoices).size === copy.allowedChoices.length && copy.allowedChoices.includes("abstain"), "bounded choices require abstention");
  ensure(isChoice(copy.baseline), "baseline choice");
  const nextTime = dated(copy.source.observedAt);
  const oldTimes = previous.sources.map((source) => dated(source.observedAt));
  const canCompare = copy.source.role === "user" && span.attribution === "direct_user" && nextTime !== null &&
    oldTimes.every((time) => time !== null && time < nextTime) &&
    previous.record.lifecycle !== "inactive" && previous.record.lifecycle !== "superseded" && !previous.record.supersededBy;
  if (!canCompare) copy.allowedChoices = copy.allowedChoices.filter((choice) => choice !== "supersede");
  const body = { ...copy, schemaVersion: 1 as const, previousVersion: memoryShadowContextVersion(previous) };
  return frozen({ ...body, digest: hash(body) });
}

interface Response { readonly choice: MemoryShadowChoice; readonly evidenceSourceRecordIds: readonly string[]; readonly confidence?: number }
function response(value: unknown, snapshot: MemoryDecisionSnapshot): Response | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  // Providers may keep aliases to their answer. Detach before validating, and
  // never let a later version-read await expose a mutable validated response.
  let object: Record<string, unknown>;
  try { object = structuredClone(value) as Record<string, unknown>; } catch { return null; }
  if (Object.keys(object).some((key) => !["choice", "evidenceSourceRecordIds", "confidence", "reason"].includes(key))) return null;
  if (!isChoice(object.choice) || !snapshot.allowedChoices.includes(object.choice)) return null;
  const ids = object.evidenceSourceRecordIds;
  if (!Array.isArray(ids) || new Set(ids).size !== ids.length) return null;
  const known = new Set([snapshot.source.id, ...snapshot.previous.sources.map((source) => source.id)]);
  if (ids.some((id) => typeof id !== "string" || !known.has(id))) return null;
  if (object.choice !== "abstain" && !ids.includes(snapshot.source.id)) return null;
  if (object.choice === "supersede" && !snapshot.previous.sources.every((source) => ids.includes(source.id))) return null;
  if (object.confidence !== undefined && (typeof object.confidence !== "number" || !Number.isFinite(object.confidence) || object.confidence < 0 || object.confidence > 1)) return null;
  if (object.reason !== undefined && (typeof object.reason !== "string" || object.reason.length > 2048)) return null;
  return Object.freeze({ choice: object.choice, evidenceSourceRecordIds: Object.freeze([...ids] as string[]),
    ...(object.confidence === undefined ? {} : { confidence: object.confidence as number }) });
}

/** No store or mutation hooks. A result is never suitable as authorization for write, retirement or deletion. */
export async function evaluateMemoryDecisionShadow(snapshot: MemoryDecisionSnapshot, options: MemoryShadowOptions): Promise<MemoryShadowReport> {
  // Capture report identity before any callback; callers may pass a mutable deserialized replay.
  const identity = snapshot && typeof snapshot === "object" ? snapshot : {};
  const safeHash = (value: unknown): string | null => typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : null;
  const snapshotDigest = safeHash((identity as Partial<MemoryDecisionSnapshot>).digest);
  const previousVersion = safeHash((identity as Partial<MemoryDecisionSnapshot>).previousVersion);
  const label = (identity as Partial<MemoryDecisionSnapshot>).baseline;
  const baseline = isChoice(label) ? label : null;
  const providerName = options.provider.name;
  let providerRequestDigest: string | null = null;
  const report = (code: MemoryShadowCode, advice?: Response): MemoryShadowReport => Object.freeze({
    schemaVersion: 1, mode: "shadow", snapshotDigest, providerRequestDigest, previousVersion,
    provider: providerName, code, proposedDecision: advice?.choice ?? "abstain", baseline,
    agreesWithBaseline: baseline === null ? null : (advice?.choice ?? "abstain") === baseline,
    evidenceSourceRecordIds: Object.freeze([...(advice?.evidenceSourceRecordIds ?? [])]), confidence: advice?.confidence ?? null,
    authorized: false, memoryMutated: false,
  });
  if (options.enabled !== true) return report("disabled");
  let checked: MemoryDecisionSnapshot;
  try {
    const { digest, previousVersion, schemaVersion, ...input } = snapshot;
    checked = createMemoryDecisionSnapshot(input as MemoryDecisionSnapshotInput);
    ensure(schemaVersion === 1 && checked.digest === digest && checked.previousVersion === previousVersion, "snapshot digest");
    ensure(typeof options.provider.name === "string" && options.provider.name.length > 0 && options.provider.name.length <= 256, "provider name");
  } catch { return report("invalid_snapshot"); }
  const { baseline: _baseline, digest: _digest, ...requestBody } = checked;
  const request: MemoryDecisionRequest = frozen({ ...requestBody, digest: hash(requestBody) });
  providerRequestDigest = request.digest;
  const timeoutMs = options.timeoutMs ?? 1000;
  ensure(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60000, "timeout");
  if (options.signal?.aborted) return report("cancelled");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  const interrupted = new Promise<MemoryShadowReport>((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve(report("timeout")); }, timeoutMs);
    cancel = () => { controller.abort(); resolve(report("cancelled")); };
    options.signal?.addEventListener("abort", cancel, { once: true });
  });
  const work = async (): Promise<MemoryShadowReport> => {
    try {
      if (await options.readCurrentVersion(controller.signal) !== checked.previousVersion) return report("stale_version");
      controller.signal.throwIfAborted();
      const advice = response(await options.provider.advise(request, controller.signal), checked);
      controller.signal.throwIfAborted();
      if (!advice) return report("invalid_response");
      if (await options.readCurrentVersion(controller.signal) !== checked.previousVersion) return report("stale_version");
      controller.signal.throwIfAborted();
      return report(advice.choice === "abstain" ? "abstained" : "advised", advice);
    } catch { return report(options.signal?.aborted ? "cancelled" : "provider_error"); }
  };
  try { return await Promise.race([work(), interrupted]); }
  finally { clearTimeout(timer); if (cancel) options.signal?.removeEventListener("abort", cancel); }
}
