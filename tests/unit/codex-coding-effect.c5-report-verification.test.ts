import { describe, expect, it } from "bun:test";

import { verifyC5ReportMemoryBehavior } from "../../scripts/codex-coding-effect/c5-evidence";

describe("independent C5 memory behavior recomputation", () => {
  it.each([36, 360])("derives %i installed attempts from actual stage rows", count => {
    const installed = Array.from({ length: count }, () => ({ memoryObservation: null }));
    const report = { injectionObservedCount: 0, installedAttemptCount: count, irrelevantInjectionCount: 0, missingObservationCount: count, observedAttemptCount: 0, requiredRecallObservedCount: 0, writebackCommittedCount: 0 };
    expect(() => verifyC5ReportMemoryBehavior({ installed, pairs: [], report })).not.toThrow();
    expect(() => verifyC5ReportMemoryBehavior({ installed, pairs: [], report: { ...report, installedAttemptCount: count + 1 } })).toThrow();
  });
});
