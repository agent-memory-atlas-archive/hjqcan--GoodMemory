import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkPhase73ReleaseClosure } from "../../scripts/release/phase73";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "goodmemory-phase73-closure-"));
  roots.push(root);
  const report = { runId: "level2-run", planSha256: "a".repeat(64), acceptance: { status: "accepted" }, attempts: { accountedCount: 720, scheduledCount: 720 }, pairs: { scheduledCount: 360, comparableCount: 350, incomparableCount: 10 }, effect: { baselineArm: "flat-summary" }, publicClaimEligible: false, publicCodingEffectProof: false, readmeRowAllowed: false };
  const plan = { datasetId: "codex-level2-controlled-mutation-v1", counts: { episodes: 30, stages: 120, repetitions: 3, stageRuns: 720 } };
  const reportBytes = JSON.stringify(report);
  await writeFile(join(root, "pilot-plan.json"), JSON.stringify(plan));
  await writeFile(join(root, "report.json"), reportBytes);
  return { root, report };
}

describe("Phase 73 release prerequisite", () => {
  const accepted = async () => ({ decision: "accepted", runId: "level2-run", planSha256: "a".repeat(64), publicClaimEligible: false as const, reasons: [] });
  it("accepts an independently verified complete negative as a closed internal experiment", async () => {
    const { root } = await fixture();
    expect(await checkPhase73ReleaseClosure(root, accepted)).toMatchObject({ status: "complete", runId: "level2-run" });
  });
  it("rejects absent or unverified evidence", async () => {
    const { root } = await fixture();
    await expect(checkPhase73ReleaseClosure(root, async () => ({ ...await accepted(), decision: "rejected", reasons: ["review missing"] }))).rejects.toThrow("review missing");
    await rm(join(root, "report.json"));
    await expect(checkPhase73ReleaseClosure(root, accepted)).rejects.toThrow();
  });
  it("rejects partial plans, report drift, and public-claim promotion", async () => {
    const { root, report } = await fixture();
    await writeFile(join(root, "report.json"), JSON.stringify({ ...report, attempts: { accountedCount: 138, scheduledCount: 720 } }));
    await expect(checkPhase73ReleaseClosure(root, accepted)).rejects.toThrow();
    await writeFile(join(root, "report.json"), JSON.stringify({ ...report, publicClaimEligible: true }));
    await expect(checkPhase73ReleaseClosure(root, accepted)).rejects.toThrow();
    await writeFile(join(root, "report.json"), JSON.stringify({ ...report, runId: "another-run" }));
    await expect(checkPhase73ReleaseClosure(root, accepted)).rejects.toThrow();
    await writeFile(join(root, "report.json"), JSON.stringify(report));
    await writeFile(join(root, "pilot-plan.json"), JSON.stringify({ datasetId: "codex-c4-controlled-pilot-v2", counts: { episodes: 6 } }));
    await expect(checkPhase73ReleaseClosure(root, accepted)).rejects.toThrow();
  });
});
