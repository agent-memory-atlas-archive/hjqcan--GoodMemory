import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import type { SourceMessageRecord } from "../../src/evidence/contracts";
import {
  createMemoryDecisionSnapshot,
  evaluateMemoryDecisionShadow,
  memoryShadowContextVersion,
  type MemoryDecisionSnapshotInput,
  type MemoryDecisionSnapshot,
} from "../../src/provider/memoryDecisionShadow";

function source(id: string, content: string, observedAt = "2026-10-01T00:00:00Z"): SourceMessageRecord {
  return { id, schemaVersion: 1, userId: "u", workspaceId: "w", sessionId: "s", role: "user", content,
    observedAt, ingestedAt: "2026-10-01T01:00:00Z", contentSha256: createHash("sha256").update(content).digest("hex") };
}
function fixture(): MemoryDecisionSnapshotInput {
  const current = source("new-source", "I now prefer coffee.");
  const old = source("old-source", "I prefer tea.", "2026-09-30T00:00:00Z");
  return { scope: { userId: "u", workspaceId: "w", sessionId: "s" },
    candidate: { id: "candidate", content: current.content, kindHint: "preference" },
    source: current, span: { start: 0, end: current.content.length, attribution: "direct_user" },
    previous: { record: { id: "memory", userId: "u", workspaceId: "w", category: "beverage", value: "tea",
      confidence: 1, evidenceCount: 1, source: { method: "explicit", extractedAt: old.ingestedAt }, updatedAt: old.ingestedAt },
      sources: [old], evidence: [{ id: "evidence", userId: "u", workspaceId: "w", kind: "conversation_excerpt",
        excerpt: old.content, source: { method: "explicit", extractedAt: old.ingestedAt }, sourceMessageIds: [],
        sourceRecordIds: [old.id], linkedMemoryIds: ["memory"], linkedArchiveIds: [], createdAt: old.ingestedAt }] },
    allowedChoices: ["keep", "supersede", "abstain"], baseline: "supersede" };
}
function run(input = fixture(), response: unknown = { choice: "supersede", evidenceSourceRecordIds: ["new-source", "old-source"], confidence: 1 }) {
  const snapshot = createMemoryDecisionSnapshot(input);
  return evaluateMemoryDecisionShadow(snapshot, { enabled: true, provider: { name: "fake", async advise() { return response; } },
    async readCurrentVersion() { return snapshot.previousVersion; } });
}

describe("memory decision shadow boundary", () => {
  it("is disabled by default and never calls the provider or version reader", async () => {
    const result = await evaluateMemoryDecisionShadow(createMemoryDecisionSnapshot(fixture()), {
      provider: { name: "never", async advise() { throw new Error("called"); } },
      async readCurrentVersion() { throw new Error("called"); },
    });
    expect(result.code).toBe("disabled");
    expect(result.proposedDecision).toBe("abstain");
    expect(result.authorized).toBe(false);
    expect(result.memoryMutated).toBe(false);
  });
  it("does not echo raw fields from malformed replay input in diagnostics", async () => {
    for (const enabled of [false, true]) {
      const input = { digest: "PRIVATE_SOURCE_TEXT", previousVersion: "PRIVATE_SCOPE", baseline: "PRIVATE_REASON" } as unknown as MemoryDecisionSnapshot;
      const report = await evaluateMemoryDecisionShadow(input, { enabled,
        provider: { name: "never", async advise() { throw new Error("must not call"); } },
        async readCurrentVersion() { throw new Error("must not read"); } });
      expect(report.code).toBe(enabled ? "invalid_snapshot" : "disabled");
      expect(report.snapshotDigest).toBeNull(); expect(report.previousVersion).toBeNull();
      expect(report.baseline).toBeNull(); expect(report.agreesWithBaseline).toBeNull();
      expect(JSON.stringify(report)).not.toContain("PRIVATE_");
      expect(report.authorized).toBe(false); expect(report.memoryMutated).toBe(false);
    }
  });
  it("compares grounded advice with the host baseline without granting authority", async () => {
    const result = await run();
    expect(result.code).toBe("advised");
    expect(result.proposedDecision).toBe("supersede");
    expect(result.agreesWithBaseline).toBe(true);
    expect(result.confidence).toBe(1);
    expect(result.authorized).toBe(false);
    expect(result.memoryMutated).toBe(false);
  });
  it("withholds the baseline and baseline-dependent digest from the provider", async () => {
    const observed: unknown[] = [];
    for (const baseline of ["keep", "supersede", "abstain"] as const) {
      const snapshot = createMemoryDecisionSnapshot({ ...fixture(), baseline });
      const report = await evaluateMemoryDecisionShadow(snapshot, { enabled: true,
        async readCurrentVersion() { return snapshot.previousVersion; },
        provider: { name: "blind", async advise(request) {
          observed.push(request);
          return { choice: "abstain", evidenceSourceRecordIds: [] };
        } } });
      expect(report.code).toBe("abstained");
    }
    expect(observed).toHaveLength(3);
    expect(observed.every((request) => !("baseline" in (request as object)))).toBe(true);
    expect(observed[0]).toEqual(observed[1]); expect(observed[1]).toEqual(observed[2]);
  });
  it("detaches and deeply freezes input, with deterministic replay identities", async () => {
    const input = fixture();
    const snapshot = createMemoryDecisionSnapshot(input);
    input.previous.record.value = "poison";
    expect(snapshot.previous.record.value).toBe("tea");
    expect(Object.isFrozen(snapshot.previous.record)).toBe(true);
    expect(createMemoryDecisionSnapshot(fixture()).digest).toBe(snapshot.digest);
    expect(createMemoryDecisionSnapshot(JSON.parse(JSON.stringify(fixture()))).digest).toBe(snapshot.digest);
  });
  it("keeps absent scope dimensions absent in the actual JSON request", () => {
    const snapshot = createMemoryDecisionSnapshot(fixture());
    expect(Object.values(snapshot.scope).every((value) => value !== undefined)).toBe(true);
    expect(Object.keys(snapshot.scope).sort()).toEqual(["sessionId", "userId", "workspaceId"]);
  });
  it.each([null, {}, { choice: "delete" }, { choice: "supersede", evidenceSourceRecordIds: ["new-source"], authorized: true },
    { choice: "supersede", evidenceSourceRecordIds: ["invented"] }, { choice: "supersede", evidenceSourceRecordIds: ["new-source"], confidence: 2 },
    { choice: "supersede", evidenceSourceRecordIds: [] }])("rejects malformed or unsupported model output %#", async (output) => {
    expect((await run(fixture(), output)).code).toBe("invalid_response");
  });
  it("accepts explicit abstention and rejects choices outside the host-bound set", async () => {
    expect((await run(fixture(), { choice: "abstain", evidenceSourceRecordIds: [] })).code).toBe("abstained");
    const input = fixture(); input.allowedChoices = ["keep", "abstain"];
    expect((await run(input)).code).toBe("invalid_response");
  });
  it("never gives quoted third-party text replacement eligibility", async () => {
    const input = fixture(); input.span.attribution = "quoted_third_party";
    expect(createMemoryDecisionSnapshot(input).allowedChoices).toEqual(["keep", "abstain"]);
    expect((await run(input)).proposedDecision).toBe("abstain");
  });
  it("keeps unknown, missing, equal, and older source clocks from suggesting replacement", async () => {
    for (const observedAt of [undefined, "not-a-time", "2026-09-30T00:00:00Z", "2026-09-29T00:00:00Z"]) {
      const input = fixture(); input.source.observedAt = observedAt;
      expect(createMemoryDecisionSnapshot(input).allowedChoices).not.toContain("supersede");
    }
  });
  it("does not normalize invalid dates or unknown offsets into replacement eligibility", () => {
    for (const observedAt of ["2026-02-30T00:00:00Z", "2026-03-01T24:00:00Z", "2026-03-01T00:00:00-00:00"]) {
      const input = fixture(); input.source.observedAt = observedAt;
      input.previous.sources[0]!.observedAt = "2026-02-28T00:00:00Z";
      expect(createMemoryDecisionSnapshot(input).allowedChoices).not.toContain("supersede");
    }
  });
  it("hash binds record content, evidence, and source clocks rather than updatedAt alone", () => {
    const input = fixture(); const before = memoryShadowContextVersion(input.previous);
    input.previous.record.value = "coffee";
    expect(memoryShadowContextVersion(input.previous)).not.toBe(before);
    const next = fixture(); next.previous.sources[0]!.observedAt = "2020-01-01T00:00:00Z";
    expect(memoryShadowContextVersion(next.previous)).not.toBe(before);
  });
  it("does not make version checks depend on storage query ordering", () => {
    const input = fixture();
    input.previous.sources.push(source("old-source-2", "I prefer tea.", "2026-09-28T00:00:00Z"));
    input.previous.evidence.push({ ...input.previous.evidence[0]!, id: "evidence-2", sourceRecordIds: ["old-source-2"] });
    const version = memoryShadowContextVersion(input.previous);
    input.previous.sources.reverse(); input.previous.evidence.reverse();
    expect(memoryShadowContextVersion(input.previous)).toBe(version);
  });
  it("rejects tampered persisted snapshots and freezes the request replay copy", async () => {
    const snapshot = JSON.parse(JSON.stringify(createMemoryDecisionSnapshot(fixture())));
    const originalDigest = snapshot.digest;
    const report = await evaluateMemoryDecisionShadow(snapshot, { enabled: true,
      async readCurrentVersion() { return snapshot.previousVersion; },
      provider: { name: "replay", async advise(request) {
        expect(Object.isFrozen(request.previous.sources)).toBe(true);
        snapshot.digest = "modified-after-validation"; snapshot.baseline = "keep";
        return { choice: "keep", evidenceSourceRecordIds: ["new-source"] };
      } } });
    expect(report.snapshotDigest).toBe(originalDigest); expect(report.baseline).toBe("supersede");
    expect(report.agreesWithBaseline).toBe(false);
    expect((await evaluateMemoryDecisionShadow(snapshot, { enabled: true,
      async readCurrentVersion() { throw new Error("should not read"); },
      provider: { name: "never", async advise() { throw new Error("should not call"); } } })).code).toBe("invalid_snapshot");
  });
  it("rejects stale versions before and after an async decision", async () => {
    const snapshot = createMemoryDecisionSnapshot(fixture()); let calls = 0;
    const provider = { name: "fake", async advise() { calls++; return { choice: "keep", evidenceSourceRecordIds: ["new-source"] }; } };
    expect((await evaluateMemoryDecisionShadow(snapshot, { enabled: true, provider, async readCurrentVersion() { return "stale"; } })).code).toBe("stale_version");
    expect(calls).toBe(0);
    let reads = 0;
    expect((await evaluateMemoryDecisionShadow(snapshot, { enabled: true, provider,
      async readCurrentVersion() { return ++reads === 1 ? snapshot.previousVersion : "changed"; } })).code).toBe("stale_version");
  });
  it("detaches validated provider output before the second async version check", async () => {
    const snapshot = createMemoryDecisionSnapshot(fixture()); let reads = 0;
    const output = { choice: "keep", evidenceSourceRecordIds: ["new-source"], confidence: 1 };
    const report = await evaluateMemoryDecisionShadow(snapshot, { enabled: true,
      provider: { name: "mutable-provider", async advise() { return output; } },
      async readCurrentVersion() {
        if (++reads === 2) {
          output.choice = "delete"; output.evidenceSourceRecordIds.splice(0, 1, "fabricated"); output.confidence = 2;
          await Promise.resolve();
        }
        return snapshot.previousVersion;
      } });
    expect(report.code).toBe("advised"); expect(report.proposedDecision).toBe("keep");
    expect(report.evidenceSourceRecordIds).toEqual(["new-source"]); expect(report.confidence).toBe(1);
    expect(report.authorized).toBe(false); expect(report.memoryMutated).toBe(false);
  });
  it("bounds a provider that ignores cancellation and redacts thrown messages", async () => {
    const snapshot = createMemoryDecisionSnapshot(fixture()); let signal: AbortSignal | undefined;
    const result = await evaluateMemoryDecisionShadow(snapshot, { enabled: true, timeoutMs: 5,
      async readCurrentVersion() { return snapshot.previousVersion; },
      provider: { name: "hung", async advise(_request, supplied) { signal = supplied; return new Promise(() => {}); } } });
    expect(result.code).toBe("timeout"); expect(signal?.aborted).toBe(true);
    const error = await evaluateMemoryDecisionShadow(snapshot, { enabled: true, async readCurrentVersion() { return snapshot.previousVersion; },
      provider: { name: "throws", async advise() { throw new Error("secret-token"); } } });
    expect(error.code).toBe("provider_error"); expect(JSON.stringify(error)).not.toContain("secret-token");
  });
  it("bounds hanging version reads and handles explicit cancellation", async () => {
    const snapshot = createMemoryDecisionSnapshot(fixture()); let calls = 0;
    const provider = { name: "never", async advise() { calls++; return null; } };
    expect((await evaluateMemoryDecisionShadow(snapshot, { enabled: true, timeoutMs: 5, provider,
      async readCurrentVersion() { return new Promise(() => {}); } })).code).toBe("timeout");
    const controller = new AbortController(); controller.abort();
    expect((await evaluateMemoryDecisionShadow(snapshot, { enabled: true, provider, signal: controller.signal,
      async readCurrentVersion() { return snapshot.previousVersion; } })).code).toBe("cancelled");
    expect(calls).toBe(0);
  });
  it("rejects hash, scope, span and old evidence mismatch before any provider call", () => {
    for (const mutate of [
      (x: MemoryDecisionSnapshotInput) => { x.source.contentSha256 = "bad"; },
      (x: MemoryDecisionSnapshotInput) => { x.source.userId = "other"; },
      (x: MemoryDecisionSnapshotInput) => { x.previous.record.workspaceId = "other"; },
      (x: MemoryDecisionSnapshotInput) => { x.candidate.content = "invented"; },
      (x: MemoryDecisionSnapshotInput) => { x.previous.evidence[0]!.sourceRecordIds = ["missing"]; },
    ]) { const input = fixture(); mutate(input); expect(() => createMemoryDecisionSnapshot(input)).toThrow(); }
  });
});
