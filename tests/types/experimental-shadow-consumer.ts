import {
  createMemoryDecisionSnapshot,
  evaluateMemoryDecisionShadow,
  type MemoryDecisionSnapshotInput,
  type MemoryShadowProvider,
  type MemoryShadowReport,
} from "goodmemory/experimental/shadow";

const provider: MemoryShadowProvider = { name: "type-consumer", async advise(request) {
  const digest: string = request.digest;
  void digest;
  // @ts-expect-error The comparison label must not enter the provider contract.
  void request.baseline;
  return { choice: "abstain", evidenceSourceRecordIds: [] };
} };
export async function checkExperimentalShadowTypes(input: MemoryDecisionSnapshotInput): Promise<MemoryShadowReport> {
  const snapshot = createMemoryDecisionSnapshot(input);
  const report = await evaluateMemoryDecisionShadow(snapshot, { provider, enabled: false,
    async readCurrentVersion() { return snapshot.previousVersion; } });
  const authorized: false = report.authorized;
  const mutated: false = report.memoryMutated;
  void authorized; void mutated;
  return report;
}
