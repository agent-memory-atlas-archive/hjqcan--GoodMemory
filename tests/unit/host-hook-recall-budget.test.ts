import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executeInstalledHostHook } from "../../src/install/hostHookRuntime";
import { executeInstalledHostWriteback } from "../../src/install/hostWritebackRuntime";

const HOST_DISPLAY_POLICY =
  'Establish and implement the host-display policy for this fork. Project policy: hosts render through one shared display form: an IPv6 literal is wrapped in square brackets, a trailing dot on any host is removed before rendering, hostnames are lower-cased but percent-encoded octets keep their original case, an explicit default port (80 for http, 443 for https) is dropped while any other port is kept after a single colon, an empty host renders as the literal string "(no host)", and a host longer than 253 characters is truncated to 250 characters followed by "...". Apply this policy to renderHostDisplay in src/host.ts and keep the exported signature unchanged.';

const QUERY_POLICY =
  "Add a query-string normalizer to src/query.ts. Project policy: query keys sort by code point, repeated keys keep their first value only, keys with an empty value serialize without an equals sign, spaces encode as %20 never as plus, and a leading question mark in the input is ignored. Export it as normalizeQuery and keep it dependency-free.";

const JOIN_POLICY =
  "Implement joinSegments in src/path.ts. Project policy: segments join with exactly one slash, empty segments are skipped, a leading slash is kept only when the first segment has one, a trailing slash is never kept, and duplicate slashes inside a segment collapse to one. Keep the exported signature unchanged.";

const LATER_PROMPT =
  "Apply the accepted host-display policy to renderEndpointDisplay in src/endpoint.ts. Keep the exported signature unchanged.";

// Stage prompts in the coding-effect harness carry a task header and a closing
// instruction; the writeback stores the whole message, so the record sizes
// (and therefore the budget overflow) depend on that shape.
function taskPrompt(body: string): string {
  return `# TypeScript utility task\n\n${body}\n\nKeep the implementation dependency-free and run the visible test.`;
}

async function writeSelectiveConfig(homeRoot: string): Promise<void> {
  await mkdir(join(homeRoot, ".goodmemory"), { recursive: true });
  await writeFile(
    join(homeRoot, ".goodmemory/codex.json"),
    `${JSON.stringify({
      activationMode: "global",
      contextMode: "fragment",
      debug: false,
      host: "codex",
      maintenance: { auto: true },
      maxTokens: 512,
      promptInjection: "relevance_gated",
      retrieval: { bm25Ranking: true },
      retrievalProfile: "coding_agent",
      sessionStartMaxTokens: 1024,
      storage: {
        path: join(homeRoot, ".goodmemory/memory.sqlite"),
        provider: "sqlite",
      },
      userId: "budget-user",
      version: 1,
      writeback: {
        allowAssistantOutput: "confirmed_or_verified",
        dryRun: false,
        maxChars: 12_000,
        maxMessages: 12,
        minConfidence: 0.7,
        mode: "selective",
        persistRawTranscript: false,
      },
    })}\n`,
    "utf8",
  );
}

describe("installed host prompt injection under the per-prompt budget", () => {
  // Reproduced native-host defect: after three sessions each declaring a
  // project policy, the per-prompt 512-token fragment dropped the whole Facts
  // section and injected only previews, so the policy the fourth prompt asked
  // for never reached the agent even though it ranked first.
  it("keeps the top-ranked policy intact when three prior sessions exceed the budget", async () => {
    const homeRoot = await mkdtemp(join(tmpdir(), "goodmemory-budget-home-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "goodmemory-budget-ws-"));
    try {
      await writeSelectiveConfig(homeRoot);
      const sessions: ReadonlyArray<readonly [string, string, string]> = [
        ["host-display", taskPrompt(HOST_DISPLAY_POLICY), "Implemented renderHostDisplay per the host-display policy."],
        ["query", taskPrompt(QUERY_POLICY), "Added normalizeQuery per the query policy."],
        ["join", taskPrompt(JOIN_POLICY), "Implemented joinSegments per the join policy."],
      ];
      for (const [id, prompt, reply] of sessions) {
        const written = await executeInstalledHostWriteback({
          command: "session-end",
          homeRoot,
          host: "codex",
          payload: {
            cwd: workspaceRoot,
            messages: [
              { content: prompt, role: "user" },
              { content: reply, role: "assistant" },
            ],
            session_id: `${id}-session`,
          },
        });
        expect(written).toMatchObject({ reason: "written", wrote: true });
      }

      const submit = await executeInstalledHostHook({
        command: "user-prompt-submit",
        homeRoot,
        host: "codex",
        payload: {
          cwd: workspaceRoot,
          prompt: taskPrompt(LATER_PROMPT),
          session_id: "later-session",
        },
      });

      expect(submit.reason).toBe("applied");
      expect(submit.maxTokens).toBe(512);
      expect(submit.context).toContain(
        'truncated to 250 characters followed by "..."',
      );
      expect(submit.context).not.toContain("Omitted sections: Facts");
      // Previews of the injected facts are dropped rather than spending budget.
      expect(submit.context).not.toContain("hosts render...");
    } finally {
      await rm(homeRoot, { force: true, recursive: true });
      await rm(workspaceRoot, { force: true, recursive: true });
    }
  });
});
