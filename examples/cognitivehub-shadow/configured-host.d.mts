import type { MemoryShadowProvider } from 'goodmemory/experimental/shadow';

export type ConfiguredMemoryShadow = Readonly<{ enabled: false }> |
  Readonly<{ enabled: true; provider: MemoryShadowProvider }>;
export interface ShadowConfigurationDependencies {
  readEnv(name: string): unknown;
  fetch?: typeof globalThis.fetch;
}
export interface ConfiguredShadowModule {
  createConfiguredGoodMemoryShadowAdvisor(config: unknown, dependencies: ShadowConfigurationDependencies): ConfiguredMemoryShadow;
}
export function loadConfiguredMemoryShadow(options: {
  configPath: string;
  hubModule?: string;
  readEnv?: (name: string) => unknown;
  fetch?: typeof globalThis.fetch;
  loadHub?: (specifier: string) => Promise<Partial<ConfiguredShadowModule>>;
}): Promise<ConfiguredMemoryShadow>;
export function evaluateConfiguredMemoryShadow<Snapshot, Report>(options: {
  configured: ConfiguredMemoryShadow;
  createSnapshot(): Snapshot | Promise<Snapshot>;
  readCurrentVersion(signal: AbortSignal): Promise<string | null>;
  evaluate(snapshot: Snapshot, options: {
    enabled: true;
    provider: MemoryShadowProvider;
    readCurrentVersion(signal: AbortSignal): Promise<string | null>;
  }): Report | Promise<Report>;
}): Promise<Report | Readonly<{ code: 'disabled'; authorized: false; memoryMutated: false }>>;
