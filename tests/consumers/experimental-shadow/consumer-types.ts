import { createMemoryDecisionSnapshot, evaluateMemoryDecisionShadow, type MemoryDecisionSnapshotInput, type MemoryShadowProvider, type MemoryDecisionRequest } from 'goodmemory/experimental/shadow';
import { createGoodMemoryShadowAdvisor, type GoodMemoryShadowAdvisor, type GoodMemoryShadowRequest } from '@cognitive-hub/core/goodmemory-shadow';
const bridge: GoodMemoryShadowAdvisor = createGoodMemoryShadowAdvisor({ decision: { name: 'type-fixture', async decide() { return { kind: 'wait', reason: 'Fixture abstention' }; } } });
const provider: MemoryShadowProvider = bridge;
export function compatibleRequest(request: MemoryDecisionRequest): GoodMemoryShadowRequest { return request; }
export async function consume(input: MemoryDecisionSnapshotInput) {
  const snapshot = createMemoryDecisionSnapshot(input);
  const report = await evaluateMemoryDecisionShadow(snapshot, { enabled: true, provider, async readCurrentVersion() { return snapshot.previousVersion; } });
  const noAuthority: false = report.authorized;
  const noMutation: false = report.memoryMutated;
  void noAuthority; void noMutation;
  // @ts-expect-error Baseline remains outside the provider input contract.
  void ({} as MemoryDecisionRequest).baseline;
  // @ts-expect-error Diagnostics are readonly.
  bridge.history.push({});
  return report;
}
