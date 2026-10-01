/** Opt-in experimental shadow evaluation; never attached to automatic memory writes. */
export {
  createMemoryDecisionSnapshot,
  evaluateMemoryDecisionShadow,
  memoryShadowContextVersion,
} from "../provider/memoryDecisionShadow";
export type {
  MemoryDecisionRequest,
  MemoryDecisionSnapshot,
  MemoryDecisionSnapshotInput,
  MemoryShadowChoice,
  MemoryShadowCode,
  MemoryShadowContext,
  MemoryShadowOptions,
  MemoryShadowProvider,
  MemoryShadowReport,
} from "../provider/memoryDecisionShadow";
