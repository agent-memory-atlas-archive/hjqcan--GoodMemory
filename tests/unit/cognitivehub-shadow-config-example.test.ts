import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadConfiguredMemoryShadow,
  evaluateConfiguredMemoryShadow,
} from "../../examples/cognitivehub-shadow/configured-host.mjs";

async function withConfig(value: string, run: (path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "shadow-config-example-"));
  try {
    const path = join(dir, "config.json");
    await writeFile(path, value);
    await run(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("explicit CognitiveHub shadow configuration host", () => {
  it("disables omitted/false configuration before module, key or snapshot work", async () => {
    for (const config of [{}, { memory: false }, { memory: {} }, { memory: { shadow: { enabled: false, apiKeyEnv: "PRIVATE_NAME" } } }]) {
      await withConfig(JSON.stringify(config), async (configPath) => {
        let calls = 0;
        const forbidden = () => { calls++; throw new Error("must not run"); };
        const configured = await loadConfiguredMemoryShadow({ configPath, loadHub: forbidden, readEnv: forbidden });
        const report = await evaluateConfiguredMemoryShadow({ configured, createSnapshot: forbidden, readCurrentVersion: forbidden, evaluate: forbidden });
        expect(report).toEqual({ code: "disabled", authorized: false, memoryMutated: false });
        expect(calls).toBe(0);
        expect(Object.isFrozen(configured)).toBe(true);
      });
    }
  });

  it("forwards only the explicit subsection to the actual factory", async () => {
    const shadow = { enabled: true, apiKeyEnv: "JEV_API_KEY", model: "fixture-model" };
    await withConfig(JSON.stringify({ memory: { shadow }, unrelated: "never forward" }), async (configPath) => {
      const provider = { name: "fixture-provider", advise: async () => ({ choice: "abstain" }) };
      const readEnv = () => "fake-key";
      const fetch = Object.assign(() => { throw new Error("never called here"); }, { preconnect: () => {} });
      const configured = await loadConfiguredMemoryShadow({ configPath, readEnv, fetch, loadHub: async () => ({
        createConfiguredGoodMemoryShadowAdvisor: (config: unknown, deps: unknown) => {
          expect(config).toEqual(shadow);
          expect(deps).toEqual({ readEnv, fetch });
          return Object.freeze({ enabled: true, provider });
        },
      }) });
      const snapshot = Object.freeze({ digest: "fixture" });
      const readCurrentVersion = async () => "version";
      const report = { authorized: false, memoryMutated: false, code: "advised" };
      expect(await evaluateConfiguredMemoryShadow({ configured, createSnapshot: () => snapshot, readCurrentVersion,
        evaluate: async (input: unknown, options: unknown) => {
          expect(input).toBe(snapshot);
          expect(options).toEqual({ enabled: true, provider, readCurrentVersion });
          return report;
        },
      })).toBe(report);
    });
  });

  it("does not echo malformed file contents or raw loader errors", async () => {
    const secret = "fake-private-string-that-must-not-appear";
    await withConfig(`{"apiKey":"${secret}",`, async (configPath) => {
      const error = await loadConfiguredMemoryShadow({ configPath }).catch((error: Error) => error);
      expect(String(error)).toBe("Error: Shadow configuration file must contain valid JSON.");
      expect(JSON.stringify(error)).not.toContain(secret);
      expect((error as Error).cause).toBeUndefined();
    });
    await withConfig('{"memory":{"shadow":{"enabled":true}}}', async (configPath) => {
      const error = await loadConfiguredMemoryShadow({ configPath, loadHub: async () => { throw new Error(secret); } }).catch((error: Error) => error);
      expect(String(error)).toBe("Error: CognitiveHub shadow configuration module is unavailable.");
      expect((error as Error).cause).toBeUndefined();
    });
  });

  it("rejects invalid structural switches without loading optional packages", async () => {
    for (const config of [null, [], { memory: 1 }, { memory: { shadow: null } }, { memory: { shadow: { enabled: "false" } } }]) {
      await withConfig(JSON.stringify(config), async (configPath) => {
        let calls = 0;
        const error = await loadConfiguredMemoryShadow({ configPath, loadHub: async () => { calls++; return {}; } }).catch((error: Error) => error);
        expect(String(error)).toContain("Shadow configuration");
        expect(calls).toBe(0);
      });
    }
  });
});
