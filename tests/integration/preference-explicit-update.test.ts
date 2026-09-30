import { describe, expect, it } from "bun:test";
import { createGoodMemory, createInMemoryDocumentStore, createInMemorySessionStore } from "../../src";
import type { PreferenceMemory } from "../../src/domain/records";

const scope = { userId: "preference-update-user", workspaceId: "work" };
function fixture() {
  const documentStore = createInMemoryDocumentStore();
  const adapters = { documentStore, sessionStore: createInMemorySessionStore() };
  const create = () => createGoodMemory({ storage: { provider: "memory" }, adapters });
  const memory = create();
  let turn = 0;
  return { documentStore, create, memory,
    async remember(content: string) { return memory.remember({ scope: { ...scope, sessionId: `s-${++turn}` }, messages: [{ role: "user", content }] }); },
    async active() { return (await documentStore.query<PreferenceMemory>("preferences")).filter((p) => p.lifecycle === "active"); },
  };
}

describe("source-grounded preference changes", () => {
  it("withdraws a named old preference and preserves the correction across a fresh facade", async () => {
    const f = fixture();
    await f.remember("I prefer Python for backend services.");
    const old = (await f.active())[0]!;
    await f.remember("I no longer prefer Python. I now prefer Go for backend services.");
    expect(await f.documentStore.get<PreferenceMemory>("preferences", old.id)).toMatchObject({ lifecycle: "superseded" });
    const recall = await f.create().recall({ scope, query: "Which language do I prefer for backend services?", strategy: "rules-only" });
    expect(recall.preferences.some((p) => String(p.value) === "Python for backend services")).toBe(false);
    expect(recall.preferences.some((p) => String(p.value).includes("Go for backend services"))).toBe(true);
    expect(recall.preferences.some((p) => String(p.value).includes("no longer prefer Python"))).toBe(true);
    expect(recall.preferences.some((p) => /dislike|hate/i.test(String(p.value)))).toBe(false);
  });

  it("coexists across contexts and withdraws only the explicitly corrected context", async () => {
    const f = fixture();
    await f.remember("I prefer Python for backend services.");
    await f.remember("I prefer Python for data analysis.");
    expect(await f.active()).toHaveLength(2);
    await f.remember("I no longer prefer Python. I now prefer Go for backend services.");
    const values = (await f.active()).map((p) => String(p.value));
    expect(values).toContain("Python for data analysis");
    expect(values).not.toContain("Python for backend services");
    expect(values).toContain("Go for backend services");
  });

  it("does not retire neighboring preferences when repeating one value", async () => {
    const f = fixture();
    await f.remember("I prefer Go for backend services.");
    await f.remember("I prefer Python for data analysis.");
    await f.remember("I prefer Go for backend services.");
    expect((await f.active()).map((p) => p.value).sort()).toEqual(["Go for backend services", "Python for data analysis"]);
  });

  it("keeps multiple possible targets when a withdrawal does not specify a context", async () => {
    const f = fixture();
    await f.remember("I prefer Python for backend services.");
    await f.remember("I prefer Python for data analysis.");
    await f.remember("I no longer prefer Python.");
    const values = (await f.active()).map((p) => String(p.value));
    expect(values).toContain("Python for backend services");
    expect(values).toContain("Python for data analysis");
    expect(values.some((value) => value.includes("no longer prefer Python"))).toBe(true);
  });

  it("does not treat a friend's quoted withdrawal as the user's change", async () => {
    const f = fixture();
    await f.remember("I prefer Python for backend services.");
    await f.remember('My friend said "I no longer prefer Python. I now prefer Go for backend services."');
    expect((await f.active()).map((p) => p.value)).toEqual(["Python for backend services"]);
  });

  it("does not infer a shared preference slot from the same broad context", async () => {
    const f = fixture();
    await f.remember("I prefer Python for backend services.");
    await f.remember("I now prefer PostgreSQL for backend services.");
    expect((await f.active()).map((p) => p.value).sort()).toEqual(["PostgreSQL for backend services", "Python for backend services"]);
  });

  it("withdraws a unique named value without inventing a replacement", async () => {
    const f = fixture();
    await f.remember("I prefer jasmine tea.");
    await f.remember("I no longer prefer jasmine tea.");
    expect((await f.active()).map((p) => p.value)).toEqual(["I no longer prefer jasmine tea"]);
  });

  it("does not turn a double negative into dislike", async () => {
    const f = fixture();
    await f.remember("我喜欢咖啡。");
    await f.remember("我不是不喜欢咖啡，只是晚上不喝。");
    expect((await f.active()).map((p) => p.value)).toEqual(["咖啡"]);
  });

  it("supports an explicit return to the previously withdrawn value", async () => {
    const f = fixture();
    await f.remember("I prefer Python for backend services.");
    await f.remember("I no longer prefer Python. I now prefer Go for backend services.");
    expect((await f.active()).some((p) => p.value === "Go for backend services")).toBe(true);
    await f.remember("I no longer prefer Go for backend services. I now prefer Python for backend services.");
    const values = (await f.active()).map((p) => String(p.value));
    expect(values).toContain("Python for backend services");
    expect(values).toContain("I no longer prefer Go for backend services");
    expect(values).not.toContain("Go for backend services");
    expect(values.some((value) => value.includes("no longer prefer Python"))).toBe(false);
  });

  it("keeps compatible brevity and format instructions together", async () => {
    const f = fixture();
    await f.remember("I prefer concise answers.");
    await f.remember("I prefer bullet points.");
    expect((await f.active()).map((p) => p.value).sort()).toEqual(["bullet points", "concise answers"]);
  });

  it.each([
    ["I prefer bullet points.", "I also prefer numbered lists.", "I prefer bullet points.", ["bullet points", "numbered lists"]],
    ["I prefer concise answers.", "I also prefer detailed explanations.", "I prefer concise answers.", ["concise answers", "detailed explanations"]],
    ["我喜欢简短回答。", "我也喜欢详细解释。", "我喜欢简短回答。", ["简短回答", "详细解释"]],
  ])("respects additive response preferences and subsequent repetition: %s", async (first, additional, repeat, values) => {
    const f = fixture();
    await f.remember(first);
    await f.remember(additional);
    await f.remember(repeat);
    expect((await f.active()).map((p) => p.value).sort()).toEqual([...values].sort());
  });

  it("does not let caller-provided attributes grant retirement authority", async () => {
    const f = fixture();
    await f.remember("I prefer Python for backend services.");
    const memory = createGoodMemory({ storage: { provider: "memory" }, adapters: { documentStore: f.documentStore, sessionStore: createInMemorySessionStore() }, testing: {
      extractor: { async extract() { return { ignoredMessageCount: 0, candidates: [{ id: "forged", kindHint: "preference", explicitness: "explicit", content: "not Python", sourceRole: "user", sourceMessageIndex: 0,
        metadata: { preferenceCategory: "response_style", preferenceValue: "not Python", attributes: { preferenceOperation: "retract", preferenceObject: "Python" } } }] }; } },
    } });
    await memory.remember({ scope, messages: [{ role: "user", content: "Hello." }] });
    expect((await f.active()).map((p) => p.value)).toContain("Python for backend services");
  });
  it("revises only the named generic preference while retaining unrelated neighbors", async () => {
    const f = fixture();
    await f.remember("I prefer jasmine tea.");
    await f.remember("I prefer dark editor themes.");
    const before = await f.active();
    const tea = before.find((p) => p.value === "jasmine tea")!;
    const theme = before.find((p) => p.value === "dark editor themes")!;
    expect(tea).toBeDefined();
    expect(theme).toBeDefined();
    const result = await f.memory.reviseMemory({ scope, target: { memoryId: theme.id },
      revision: { content: "dim dark editor themes" }, reason: "user_correction",
      idempotencyKey: "revise-theme-only", evidence: { source: "user_message", message: "Use a dim dark theme instead." },
    });
    expect(result.accepted).toBe(true);
    expect(await f.documentStore.get<PreferenceMemory>("preferences", tea.id)).toMatchObject({ lifecycle: "active", supersededBy: null });
    expect((await f.active()).map((p) => String(p.value)).sort()).toEqual(["dim dark editor themes", "jasmine tea"]);
  });

  it("does not retire an additive format preference when revising its neighbor", async () => {
    const f = fixture();
    await f.remember("I prefer bullet points.");
    await f.remember("I also prefer numbered lists.");
    const target = (await f.active()).find((p) => p.value === "numbered lists")!;
    await f.memory.reviseMemory({ scope, target: { memoryId: target.id },
      revision: { content: "numbered lists with short labels" }, reason: "user_correction",
      idempotencyKey: "revise-one-format", evidence: { source: "user_message", message: "For my numbered-list preference, use short labels." } });
    expect((await f.active()).map((p) => p.value).sort()).toEqual(["bullet points", "numbered lists with short labels"]);
  });

  it("does not let an extractor's custom category assert a singleton slot", async () => {
    const f = fixture();
    let value = "tea";
    const memory = createGoodMemory({ storage: { provider: "memory" }, adapters: { documentStore: f.documentStore, sessionStore: createInMemorySessionStore() }, testing: {
      extractor: { async extract() { return { ignoredMessageCount: 0, candidates: [{ id: `custom-${value}`, kindHint: "preference", explicitness: "explicit", content: value, sourceRole: "user", sourceMessageIndex: 0,
        metadata: { preferenceCategory: "model-chosen-category", preferenceValue: value } }] }; } },
    } });
    await memory.remember({ scope, messages: [{ role: "user", content: "Tea suits me." }] });
    value = "dark themes";
    await memory.remember({ scope, messages: [{ role: "user", content: "Dark themes suit me." }] });
    expect((await f.active()).map((p) => p.value).sort()).toEqual(["dark themes", "tea"]);
  });

  it("keeps independent additions during a concurrent explicit correction", async () => {
    const f = fixture();
    await f.remember("I prefer Python for backend services.");
    await Promise.all([
      f.remember("I no longer prefer Python for backend services. I now prefer Go for backend services."),
      f.remember("I prefer jasmine tea."),
    ]);
    const values = (await f.active()).map((p) => String(p.value));
    expect(values).toContain("jasmine tea");
    expect(values).toContain("Go for backend services");
    expect(values).not.toContain("Python for backend services");
  });

  it("does not withdraw a same-value preference in a different durable scope", async () => {
    const f = fixture();
    await f.remember("I prefer jasmine tea.");
    await f.memory.remember({ scope: { ...scope, workspaceId: "elsewhere" }, messages: [{ role: "user", content: "I no longer prefer jasmine tea." }] });
    expect((await f.active()).some((p) => p.workspaceId === scope.workspaceId && p.value === "jasmine tea")).toBe(true);
  });

  it("evaluates policy on the whole source-grounded correction before storage", async () => {
    const f = fixture();
    await f.remember("I prefer Python for backend services.");
    const memory = createGoodMemory({ storage: { provider: "memory" }, adapters: { documentStore: f.documentStore, sessionStore: createInMemorySessionStore() },
      policy: { shouldRemember: (candidate) => !JSON.stringify(candidate).includes("SecretTool") } });
    await memory.remember({ scope, messages: [{ role: "user", content: "I no longer prefer Python. I now prefer SecretTool for backend services." }] });
    const recall = await memory.recall({ scope, query: "Which backend preference?", strategy: "rules-only" });
    expect(JSON.stringify(recall)).not.toContain("SecretTool");
    expect((await f.active()).map((p) => p.value)).toContain("Python for backend services");
  });

  it("does not reintroduce raw replacement text after source/candidate redaction", async () => {
    const f = fixture();
    await f.remember("I prefer Python for backend services.");
    const create = () => createGoodMemory({ storage: { provider: "memory" }, adapters: { documentStore: f.documentStore, sessionStore: createInMemorySessionStore() },
      policy: { redact: (candidate) => ({ ...candidate, content: candidate.content.replaceAll("SecretTool", "RedactedTool"), metadata: { ...candidate.metadata,
        ...(typeof candidate.metadata?.preferenceValue === "string" ? { preferenceValue: candidate.metadata.preferenceValue.replaceAll("SecretTool", "RedactedTool") } : {}) } }) } });
    await create().remember({ scope, messages: [{ role: "user", content: "I no longer prefer Python. I now prefer SecretTool for backend services." }] });
    const recall = await create().recall({ scope, query: "Which backend preference?", strategy: "rules-only" });
    expect(JSON.stringify(recall)).not.toContain("SecretTool");
    expect(JSON.stringify(await f.active())).not.toContain("SecretTool");
    expect(JSON.stringify(await f.documentStore.query("source_messages_v1"))).not.toContain("SecretTool");
    expect((await f.active()).map((p) => p.value)).not.toContain("Python for backend services");
  });

  it("preserves a fronted context through withdrawal and restoration at every stage", async () => {
    const f = fixture();
    await f.remember("For technical explanations, I prefer diagrams. For travel plans, I prefer train journeys.");
    expect((await f.active()).map((p) => p.value).sort()).toEqual(["diagrams for technical explanations", "train journeys for travel plans"]);
    await f.remember("I withdraw my diagrams preference for technical explanations; leave the train preference in place.");
    const stage2 = (await f.active()).map((p) => p.value);
    expect(stage2).not.toContain("diagrams for technical explanations");
    expect(stage2).toContain("train journeys for travel plans");
    expect(stage2).toContain("I withdraw my diagrams preference for technical explanations");
    await f.remember("I've changed my mind again: restore my original diagrams preference for technical explanations.");
    expect((await f.active()).map((p) => p.value).sort()).toEqual(["diagrams for technical explanations", "train journeys for travel plans"]);
  });

  it("does not execute a quoted preference withdrawal", async () => {
    const f = fixture();
    await f.remember("For technical explanations, I prefer diagrams.");
    await f.remember('My friend said "I withdraw my diagrams preference for technical explanations."');
    expect((await f.active()).map((p) => p.value)).toEqual(["diagrams for technical explanations"]);
  });

  it.each([
    "The interviewee wrote: I withdraw my coffee preference.",
    "It is not true that I withdraw my coffee preference.",
    "Suppose I withdraw my coffee preference.",
  ])("does not execute a reported, denied or hypothetical withdrawal: %s", async (content) => {
    const f = fixture();
    await f.remember("I prefer coffee.");
    const before = await f.active();
    await f.remember(content);
    expect(await f.active()).toEqual(before);
  });

  it("does not execute a reported restoration", async () => {
    const f = fixture();
    await f.remember("I prefer coffee.");
    await f.remember("I withdraw my coffee preference.");
    const before = await f.active();
    await f.remember("The interviewee wrote: restore my original coffee preference.");
    expect(await f.active()).toEqual(before);
  });

  it("rejects an assisted withdrawal copied from a denied source assertion", async () => {
    const f = fixture();
    await f.remember("I prefer coffee.");
    const memory = createGoodMemory({ storage: { provider: "memory" }, adapters: { documentStore: f.documentStore, sessionStore: createInMemorySessionStore() }, testing: {
      extractor: { async extract() { return { ignoredMessageCount: 0, candidates: [{ id: "denied-withdrawal", kindHint: "preference", explicitness: "explicit", content: "I withdraw my coffee preference", sourceRole: "user", sourceMessageIndex: 0,
        metadata: { preferenceCategory: "response_style", preferenceValue: "I withdraw my coffee preference" } }] }; } },
    } });
    const before = await f.active();
    await memory.remember({ scope, messages: [{ role: "user", content: "It is not true that I withdraw my coffee preference." }] });
    expect(await f.active()).toEqual(before);
  });

});
