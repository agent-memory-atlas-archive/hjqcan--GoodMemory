import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";

import { runC5EvidenceGate } from "../codex-coding-effect/c5-evidence";

export const PHASE73_RELEASE_EVIDENCE_PATH =
  "reports/quality-gates/phase-73/level2-native-comparator-flat-summary-v1";

const planSchema = z.object({
  datasetId: z.literal("codex-level2-controlled-mutation-v1"),
  counts: z.object({
    episodes: z.literal(30),
    stages: z.literal(120),
    repetitions: z.literal(3),
    stageRuns: z.literal(720),
  }),
});
const reportSchema = z.object({
  runId: z.string().min(1),
  planSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  acceptance: z.object({ status: z.literal("accepted") }),
  attempts: z.object({ accountedCount: z.literal(720), scheduledCount: z.literal(720) }),
  pairs: z.object({
    scheduledCount: z.literal(360),
    comparableCount: z.number().int().nonnegative(),
    incomparableCount: z.number().int().nonnegative(),
  }),
  effect: z.object({ baselineArm: z.literal("flat-summary") }),
  publicClaimEligible: z.literal(false),
  publicCodingEffectProof: z.literal(false),
  readmeRowAllowed: z.literal(false),
});

interface EvidenceGate {
  decision: string;
  runId: string | null;
  planSha256: string | null;
  publicClaimEligible: false;
  reasons: string[];
}

// Replays the full existing evidence gate, including independent review.
// Evidence acceptance is not a positive scientific result. A negative result
// can close this internal lane too; missing attempts or a partial run cannot.
// Scientific interpretation belongs in the Phase 73 board, not in a second
// hand-authored JSON decision that could disagree with the verified report.
export async function checkPhase73ReleaseClosure(
  projectionDirectory: string,
  verify: (input: { projectionDirectory: string }) => Promise<EvidenceGate> = runC5EvidenceGate,
) {
  const gate = await verify({ projectionDirectory });
  if (gate.decision !== "accepted") {
    throw new Error(`Phase 73 evidence not accepted: ${gate.reasons.join("; ")}`);
  }
  const [planBytes, reportBytes] = await Promise.all(
    ["pilot-plan.json", "report.json"].map((name) =>
      readFile(join(projectionDirectory, name), "utf8")
    ),
  );
  planSchema.parse(JSON.parse(planBytes!));
  const report = reportSchema.parse(JSON.parse(reportBytes!));
  if (gate.runId !== report.runId || gate.planSha256 !== report.planSha256 ||
      report.pairs.comparableCount + report.pairs.incomparableCount !== 360) {
    throw new Error("Phase 73 closure identity or attempt accounting mismatch");
  }
  return { status: "complete" as const, runId: report.runId, publicClaimEligible: false as const };
}

if (import.meta.main) {
  try {
    const root = resolve(import.meta.dir, "../..");
    console.log(JSON.stringify(await checkPhase73ReleaseClosure(join(root, PHASE73_RELEASE_EVIDENCE_PATH))));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
