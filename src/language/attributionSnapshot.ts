import { createHash } from "node:crypto";

export interface AttributionSourceBinding {
  readonly sourceMessageIndex: number;
  readonly phase: "original" | "safe";
}

export interface AttributionSnapshot {
  readonly version: "attribution-mask-v1";
  readonly digestEncoding: "sha256-utf16le";
  readonly sourceDigest: string;
  readonly sourceLength: number;
  readonly binding?: AttributionSourceBinding;
  readonly spans: readonly Readonly<{ start: number; end: number; kind: "masked-code-units" }>[];
  readonly authorText: string;
  readonly withheldText: string;
  readonly hasRestrictions: boolean;
}

const snapshots = new WeakSet<AttributionSnapshot>();
const digest = (text: string): string => createHash("sha256").update(text, "utf16le").digest("hex");

function splitsSurrogatePair(text: string, offset: number): boolean {
  const left = text.charCodeAt(offset - 1);
  const right = text.charCodeAt(offset);
  return left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff;
}

/** Private restriction evidence, never an authenticated origin or author label. */
export function createAttributionSnapshot(
  source: string,
  masked: string,
  binding?: AttributionSourceBinding,
): AttributionSnapshot {
  if (binding && (!Number.isSafeInteger(binding.sourceMessageIndex) || binding.sourceMessageIndex < 0 ||
    (binding.phase !== "original" && binding.phase !== "safe"))) {
    throw new Error("Invalid attribution source binding");
  }
  if (source.length !== masked.length) throw new Error("Attribution mask changed source length");
  const spans: Array<Readonly<{ start: number; end: number; kind: "masked-code-units" }>> = [];
  let start: number | undefined;
  for (let index = 0; index <= source.length; index += 1) {
    const changed = index < source.length && source[index] !== masked[index];
    if (changed) {
      if (masked[index] !== " " || source[index] === "\r" || source[index] === "\n") {
        throw new Error("Attribution mask must only replace text with spaces");
      }
      start ??= index;
    } else if (start !== undefined) {
      if (splitsSurrogatePair(source, start) || splitsSurrogatePair(source, index)) {
        throw new Error("Attribution mask split a Unicode character");
      }
      spans.push(Object.freeze({ start, end: index, kind: "masked-code-units" as const }));
      start = undefined;
    }
  }
  // These intervals contain only changed positions. Unchanged punctuation and
  // whitespace inside an external document are not origin evidence either.
  const authorParts: string[] = [];
  const withheldParts: string[] = [];
  let previous = 0;
  for (const span of spans) {
    authorParts.push(source.slice(previous, span.start), " ".repeat(span.end - span.start));
    withheldParts.push(" ".repeat(span.start - previous), source.slice(span.start, span.end));
    previous = span.end;
  }
  authorParts.push(source.slice(previous));
  withheldParts.push(" ".repeat(source.length - previous));
  const snapshot: AttributionSnapshot = Object.freeze({
    version: "attribution-mask-v1",
    digestEncoding: "sha256-utf16le",
    sourceDigest: digest(source),
    sourceLength: source.length,
    ...(binding ? { binding: Object.freeze({ sourceMessageIndex: binding.sourceMessageIndex, phase: binding.phase }) } : {}),
    spans: Object.freeze(spans),
    authorText: authorParts.join(""),
    withheldText: spans.length ? withheldParts.join("") : "",
    hasRestrictions: spans.length > 0,
  });
  snapshots.add(snapshot);
  return snapshot;
}

export function matchesAttributionSnapshot(
  snapshot: AttributionSnapshot,
  source: string,
  binding?: AttributionSourceBinding,
): boolean {
  return snapshots.has(snapshot) && snapshot.sourceLength === source.length &&
    snapshot.sourceDigest === digest(source) &&
    snapshot.binding?.sourceMessageIndex === binding?.sourceMessageIndex &&
    snapshot.binding?.phase === binding?.phase;
}
