import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";

import {
  createReleaseConsumerEnvironment,
  runReleaseCommand,
} from "../../scripts/release/runner";

describe("offline release consumer environment", () => {
  it("removes ambient GoodMemory configuration without changing the parent or data paths", () => {
    const parent = {
      GOODMEMORY_ASSISTED_EXTRACTOR_MODEL: "incomplete-provider-fixture",
      GOODMEMORY_EMBEDDING_API_KEY: "not-a-real-key",
      GOODMEMORY_STORAGE_URL: "postgres://fixture",
      GOODMEMORY_TEST_POSTGRES_URL: "postgres://release-gate-fixture",
      GOODMEMORY_HOME: "/unused-parent-home",
      PATH: "/usr/bin",
      TMPDIR: "/data/test-tmp",
      npm_config_cache: "/data/test-npm-cache",
    };
    const snapshot = { ...parent };
    const consumer = createReleaseConsumerEnvironment(parent);
    for (const name of Object.keys(parent).filter(name => name.startsWith("GOODMEMORY_"))) {
      expect(consumer).toHaveProperty(name, undefined);
    }
    expect(consumer.PATH).toBe(parent.PATH);
    expect(consumer.TMPDIR).toBe(parent.TMPDIR);
    expect(consumer.npm_config_cache).toBe(parent.npm_config_cache);
    expect(parent).toEqual(snapshot);
  });

  it("clears merged parent configuration in real Node and Bun subprocesses", async () => {
    const previous = process.env.GOODMEMORY_RELEASE_CONSUMER_TEST;
    process.env.GOODMEMORY_RELEASE_CONSUMER_TEST = "must-not-reach-consumer";
    try {
      for (const command of ["node", "bun"]) {
        const result = await runReleaseCommand({
          command,
          args: ["-e", 'if (process.env.GOODMEMORY_RELEASE_CONSUMER_TEST !== undefined) process.exit(1); console.log("ISOLATED_CONSUMER_ENV_OK")'],
          cwd: tmpdir(),
          environment: createReleaseConsumerEnvironment(),
        });
        expect(result.code).toBe(0);
        expect(result.stdout.trim()).toBe("ISOLATED_CONSUMER_ENV_OK");
      }
      expect(process.env.GOODMEMORY_RELEASE_CONSUMER_TEST).toBe("must-not-reach-consumer");
    } finally {
      if (previous === undefined) delete process.env.GOODMEMORY_RELEASE_CONSUMER_TEST;
      else process.env.GOODMEMORY_RELEASE_CONSUMER_TEST = previous;
    }
  });
});
