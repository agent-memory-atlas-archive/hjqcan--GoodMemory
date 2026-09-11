import { describe, expect, it } from "bun:test";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import {
  runCodexProcess,
} from "../../scripts/codex-coding-effect/codex-runner";
import {
  createCodexCodingEffectLogger,
} from "../../scripts/codex-coding-effect/logging";
import type {
  CodexCodingEffectLogEvent,
} from "../../scripts/codex-coding-effect/logging";
import { runBoundaryProcess } from "../../scripts/codex-coding-effect/process";

const FAKE_CODEX = fileURLToPath(new URL(
  "../../fixtures/codex-coding-effect/fake-codex.ts",
  import.meta.url,
));

async function withWorkspace(
  run: (workspace: string) => Promise<void>,
): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), "goodmemory-fake-codex-"));
  try {
    await run(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

function request(workspace: string, mode: string, timeoutMs = 2_000) {
  return {
    args: [FAKE_CODEX, mode],
    cwd: workspace,
    executable: process.execPath,
    timeoutMs,
  };
}

describe("Codex coding-effect fake host", () => {
  it("captures a successful patch trajectory and structured boundary logs", async () => {
    await withWorkspace(async (workspace) => {
      const logs: CodexCodingEffectLogEvent[] = [];
      const logger = createCodexCodingEffectLogger({
        arm: "no-memory",
        attemptId: "attempt-001",
        episodeId: "episode-001",
        repetition: 1,
        runId: "run-c1",
        seed: 1,
        stageId: "stage-1",
        traceId: "trace-001",
      }, (event) => logs.push(event), () => "2026-07-15T00:00:00.000Z");

      const result = await runCodexProcess({
        ...request(workspace, "success"),
        logger,
      });

      expect(result.status).toBe("completed");
      expect(result.exitCode).toBe(0);
      expect(result.normalized).toMatchObject({
        commands: [{ command: "write deterministic-result.txt", exitCode: 0 }],
        fileChanges: [{ kind: "add", path: "deterministic-result.txt" }],
        finalMessage: "Implemented the deterministic fixture patch.",
        threadId: "fake-thread-001",
      });
      await access(join(workspace, "deterministic-result.txt"));
      expect(logs.map((event) => event.event)).toEqual([
        "codex_process_started",
        "codex_process_exited",
      ]);
      expect(logs.every((event) =>
        event.runId === "run-c1" &&
        event.episodeId === "episode-001" &&
        event.stageId === "stage-1" &&
        event.arm === "no-memory" &&
        event.attemptId === "attempt-001" &&
        event.timestamp === "2026-07-15T00:00:00.000Z"
      )).toBe(true);
    });
  });

  it("retains non-zero host exits", async () => {
    await withWorkspace(async (workspace) => {
      const result = await runCodexProcess(request(workspace, "non-zero"));

      expect(result.status).toBe("non-zero-exit");
      expect(result.exitCode).toBe(17);
      expect(result.stderr).toContain("fake Codex failed");
    });
  });

  it("retains and logs structured Codex failure events", async () => {
    await withWorkspace(async (workspace) => {
      const logs: CodexCodingEffectLogEvent[] = [];
      const logger = createCodexCodingEffectLogger({
        arm: "no-memory",
        attemptId: "attempt-failed",
        episodeId: "episode-failed",
        repetition: 1,
        runId: "run-failed",
        seed: 1,
        stageId: "stage-2",
        traceId: "trace-failed",
      }, (event) => logs.push(event));
      const result = await runCodexProcess({
        ...request(workspace, "non-zero-turn-failed"),
        logger,
      });

      expect(result.status).toBe("non-zero-exit");
      expect(result.failureEvents).toEqual([{
        message: "synthetic upstream capacity failure",
        sourceEventIndex: 3,
        type: "turn.failed",
      }]);
      expect(logs.at(-1)).toMatchObject({
        details: {
          failureEvents: result.failureEvents,
        },
        event: "codex_process_failure",
      });
    });
  });

  it("does not turn a non-zero host exit into a retryable parser failure", async () => {
    await withWorkspace(async (workspace) => {
      const result = await runCodexProcess(
        request(workspace, "non-zero-malformed"),
      );

      expect(result.status).toBe("non-zero-exit");
      expect(result.exitCode).toBe(17);
      expect(result.eventParseError).toContain("line 4");
    });
  });

  it("kills and classifies a host timeout", async () => {
    await withWorkspace(async (workspace) => {
      const result = await runCodexProcess(request(workspace, "timeout", 30));

      expect(result.status).toBe("timed-out");
      expect(result.timedOut).toBe(true);
    });
  });

  it("terminates nested descendants that ignore the graceful timeout signal", async () => {
    await withWorkspace(async (workspace) => {
      const childPidPath = join(workspace, "child.pid");
      const leakedWritePath = join(workspace, "leaked.txt");
      const nestedShell = [
        "trap '' TERM",
        'printf "%s" "$$" > "$1"',
        "sleep 2",
        'printf leaked > "$2"',
      ].join("; ");
      const result = await runBoundaryProcess({
        args: [
          "-c",
          `sh -c ${JSON.stringify(nestedShell)} nested "$1" "$2" & wait`,
          "outer",
          childPidPath,
          leakedWritePath,
        ],
        cwd: workspace,
        executable: "/bin/sh",
        timeoutMs: 100,
      });

      expect(result.timedOut).toBe(true);
      expect(result.durationMs).toBeLessThan(1_000);
      const childPid = Number(await readFile(childPidPath, "utf8"));
      expect(() => process.kill(childPid, 0)).toThrow();
      await expect(access(leakedWritePath)).rejects.toThrow();
    });
  });

  it("retains empty and nonempty timeout stdout with zero parsed events and exit code zero", async () => {
    await withWorkspace(async (workspace) => {
      for (const stdout of ["", `${JSON.stringify({ type: "thread.started", thread_id: "partial" })}\n`]) {
        const result = await runCodexProcess({
          args: [
            "-c",
            'trap "exit 0" TERM; printf "%s" "$1"; while :; do sleep 1; done',
            "timeout-fixture",
            stdout,
          ],
          cwd: workspace,
          executable: "/bin/sh",
          timeoutMs: 250,
        });
        expect(result.status).toBe("timed-out");
        expect(result.timedOut).toBe(true);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe(stdout);
        expect(result.events).toEqual([]);
        expect(result.normalized).toBeNull();
      }
    });
  });

  it("classifies malformed JSONL without dropping the host attempt", async () => {
    await withWorkspace(async (workspace) => {
      const result = await runCodexProcess(request(workspace, "malformed"));

      expect(result.status).toBe("event-parse-failed");
      expect(result.eventParseError).toContain("line 4");
      expect(result.stdout).not.toBe("");
    });
  });

  it("accepts a valid partial final line", async () => {
    await withWorkspace(async (workspace) => {
      const result = await runCodexProcess(
        request(workspace, "partial-final-line"),
      );

      expect(result.status).toBe("completed");
      expect(result.normalized?.finalMessage).toContain("deterministic fixture");
    });
  });

  it("rejects a zero exit that lacks a final agent message", async () => {
    await withWorkspace(async (workspace) => {
      const result = await runCodexProcess(
        request(workspace, "missing-final-message"),
      );

      expect(result.status).toBe("missing-final-message");
      expect(result.exitCode).toBe(0);
    });
  });
});
