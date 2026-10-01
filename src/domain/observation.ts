import { createHash } from "node:crypto";
import { isFactExpired, type FactMemory } from "./records";
import { isSameDurableScope, scopeToKey } from "./scope";

export const OBSERVATION_PROOF_ATTRIBUTE = "observationSupportV1";
export const MAX_OBSERVATION_SOURCES = 1024;
export interface ObservationSupport {
  version: 1;
  subject: string;
  inputs: Array<{ id: string; fingerprint: string }>;
}

export function isObservation(fact: FactMemory): boolean {
  return ["observationOf", "observationMemberIds", OBSERVATION_PROOF_ATTRIBUTE]
    .some((key) => Object.prototype.hasOwnProperty.call(fact.attributes ?? {}, key));
}

export function isUsableObservationSource(fact: FactMemory, referenceTime: string): boolean {
  return !isObservation(fact) && fact.lifecycle === "active" && fact.isActive !== false &&
    !isFactExpired(fact, referenceTime) &&
    (fact.validFrom === undefined || Date.parse(fact.validFrom) <= Date.parse(referenceTime));
}

export function observationInputFingerprint(fact: FactMemory): string {
  return createHash("sha256").update(JSON.stringify([
    fact.id, scopeToKey({ ...fact, sessionId: undefined }), fact.subject ?? null, fact.category, fact.content,
  ])).digest("hex");
}

export function buildObservationSupport(subject: string, facts: readonly FactMemory[]): string {
  return JSON.stringify({ version: 1, subject, inputs: facts.map((fact) => ({
    id: fact.id, fingerprint: observationInputFingerprint(fact),
  })) } satisfies ObservationSupport);
}

export function readObservationSupport(fact: FactMemory): ObservationSupport | null {
  const text = fact.attributes?.[OBSERVATION_PROOF_ATTRIBUTE];
  if (typeof text !== "string" || text.length > 512_000) return null;
  try {
    const value = JSON.parse(text) as ObservationSupport;
    if (value?.version !== 1 || typeof value.subject !== "string" ||
      value.subject !== fact.subject || value.subject !== fact.attributes?.observationOf ||
      !Array.isArray(value.inputs) || value.inputs.length < 2 || value.inputs.length > MAX_OBSERVATION_SOURCES) return null;
    const ids = new Set<string>();
    for (const input of value.inputs) {
      if (!input || typeof input.id !== "string" || input.id.length === 0 || input.id.length > 8192 ||
        input.id === fact.id || ids.has(input.id) || typeof input.fingerprint !== "string" ||
        !/^[0-9a-f]{64}$/.test(input.fingerprint)) return null;
      ids.add(input.id);
    }
    return value;
  } catch { return null; }
}

export function observationSourceMatches(observation: FactMemory, source: FactMemory,
  input: ObservationSupport["inputs"][number], referenceTime: string): boolean {
  return source.id === input.id && isSameDurableScope(observation, source) &&
    source.subject?.trim() === observation.subject && isUsableObservationSource(source, referenceTime) &&
    observationInputFingerprint(source) === input.fingerprint;
}

/** Validate before each outbound-use boundary; do not cache across user callbacks. */
export async function filterSupportedObservations(
  facts: readonly FactMemory[],
  loadFact: ((id: string) => Promise<FactMemory | null>) | undefined,
  referenceTime: string | (() => string),
  verifySnapshots?: (facts: readonly FactMemory[]) => Promise<boolean>,
): Promise<{ facts: FactMemory[]; rejectedIds: Set<string> }> {
  const readTime = () => typeof referenceTime === "function" ? referenceTime() : referenceTime;
  const referenceAtStart = readTime();
  let budgetExceeded = false;
  const cache = new Map<string, Promise<FactMemory | null>>();
  const load = (id: string) => {
    let pending = cache.get(id);
    if (!pending) {
      if (cache.size >= 4096) { budgetExceeded = true; return Promise.resolve(null); }
      pending = loadFact
        ? loadFact(id).then((record) => record ? structuredClone(record) : null)
        : Promise.resolve(null);
      cache.set(id, pending);
    }
    return pending;
  };
  const accepted: FactMemory[] = [];
  const rejectedIds = new Set<string>();
  const jointSnapshots = new Map<string, FactMemory>();
  const supportedObservations = new Set<string>();
  for (const inputFact of facts) {
    if (!isObservation(inputFact)) { accepted.push(inputFact); continue; }
    const fact = structuredClone(inputFact);
    if (budgetExceeded) { rejectedIds.add(fact.id); continue; }
    const current = await load(fact.id);
    const proof = readObservationSupport(fact);
    const snapshots = current ? [current] : [];
    let valid = Boolean(verifySnapshots && current && proof && readObservationSupport(current) && current.lifecycle === "active" && current.isActive !== false &&
      observationInputFingerprint(current) === observationInputFingerprint(fact) &&
      current.attributes?.[OBSERVATION_PROOF_ATTRIBUTE] === fact.attributes?.[OBSERVATION_PROOF_ATTRIBUTE] &&
      !isFactExpired(current, referenceAtStart) &&
      (current.validFrom === undefined || Date.parse(current.validFrom) <= Date.parse(referenceAtStart)));
    if (valid && proof) {
      for (const input of proof.inputs) {
        const source = await load(input.id);
        // Nested, cyclic and self-referential imported derivations fail closed.
        if (!source || !observationSourceMatches(fact, source, input, referenceAtStart)) { valid = false; break; }
        snapshots.push(source);
      }
    }
    if (valid) {
      for (const snapshot of snapshots) jointSnapshots.set(snapshot.id, snapshot);
      supportedObservations.add(fact.id);
      accepted.push(fact);
    } else rejectedIds.add(fact.id);
  }
  if (supportedObservations.size > 0) {
    let jointlyCurrent = false;
    if (!budgetExceeded && jointSnapshots.size <= 4096) {
      try { jointlyCurrent = await verifySnapshots!([...jointSnapshots.values()]); } catch { /* Withhold unsupported snapshots. */ }
    }
    const referenceAtEnd = readTime();
    jointlyCurrent = jointlyCurrent && [...jointSnapshots.values()].every((record) =>
      !isFactExpired(record, referenceAtEnd) &&
      (record.validFrom === undefined || Date.parse(record.validFrom) <= Date.parse(referenceAtEnd)));
    if (!jointlyCurrent) {
      for (const id of supportedObservations) rejectedIds.add(id);
    }
  }
  return { facts: accepted.filter((fact) => !rejectedIds.has(fact.id)), rejectedIds };
}
