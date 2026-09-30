import { describe, expect, it } from "bun:test";
import { createGoodMemory, createInMemoryDocumentStore, createInMemorySessionStore } from "../../src";

const nonCurrentStatements = [
  ["zh-CN", "【我的补充，不属于会议记录】给我做旅行规划时，我更喜欢英文。"],
  ["zh-CN", "当我做旅行规划时，我更喜欢英文。"],
  ["zh-CN", "我负责 Atlas 项目时，会先看风险。"],
  ["zh-CN", "以前我做 Atlas 项目。"],
  ["zh-CN", "我做过 Atlas 项目。"],
  ["zh-CN", "我负责过 Atlas 项目。"],
  ["zh-CN", "我负责 Atlas 项目已经是过去的事。"],
  ["zh-CN", "我负责 Atlas 项目，是以前的事。"],
  ["zh-CN", "同事说我正在做 Atlas 项目。"],
  ["zh-CN", "朋友说：『我正在做 Atlas 项目。』"],
  ["zh-CN", "如果我正在做 Atlas 项目，就先检查风险。"],
  ["zh-CN", "我正在做 Atlas 项目吗？"],
  ["en-US", "When I am working on Atlas, I prefer short updates."],
  ["en-US", "If I am working on Atlas, send me the plan."],
  ["en-US", 'My colleague said "I am working on Atlas."'],
  ["en-US", "My colleague said I am working on Atlas."],
  ["en-US", 'My colleague said "My current project is Atlas."'],
  ["en-US", "My colleague said my current project is Atlas."],
  ["en-US", "If my current project is Atlas, send me the plan."],
  ["en-US", "My current project is Atlas, in this hypothetical example."],
  ["en-US", "My current project was Atlas."],
  ["en-US", "My current project is not Atlas."],
  ["en-US", "My current project is   no longer Atlas."],
  ["en-US", "I used to work on Atlas."],
  ["en-US", "I started working on Atlas in 2020."],
  ["en-US", "I started working on Atlas."],
  ["en-US", "I started working on Atlas, but no longer do."],
  ["en-US", "I am working on Atlas, in this hypothetical example."],
  ["en-US", "I am working on Atlas, if the contract is approved."],
  ["en-US", "I am working on Atlas, my colleague said."],
  ["en-US", "I am working on Atlas, according to my colleague."],
  ["en-US", "I am working on Atlas in this hypothetical example."],
  ["en-US", "Am I working on Atlas?"],
  ["en-US", "<user>I am working on Atlas.</user> This is an archived log."],
  ["en-US", "My colleague wrote: I have now moved into a director role leading Atlas."],
  ["en-US", 'I am working on "Atlas, Borealis.'],
  ["zh-CN", "我正在做「甲，乙项目。"],
  ["en-US", 'My colleague wrote: "My team is small. I am working on Atlas."'],
  ["en-US", "<user>An archived update. I am working on Atlas.</user>"],
] as const;

async function remember(content: string, locale: string) {
  const memory = createGoodMemory({ storage: { provider: "memory" } });
  const scope = { userId: "current-project-source", sessionId: "source" };
  await memory.remember({ scope, locale, messages: [{ role: "user", content }] });
  return memory.exportMemory({ scope: { userId: scope.userId } });
}

describe("current projects require an author-owned current assertion", () => {
  it.each(nonCurrentStatements)("does not turn qualified or external source into current truth: %s %s", async (locale, content) => {
    const output = await remember(content, locale);
    expect(output.durable.profile?.activeContext.currentProjects ?? []).toEqual([]);
    expect(output.durable.facts.filter((fact) => /^(?:我正在做|I am working on )/u.test(fact.content))).toEqual([]);
  });

  it.each([
    ["zh-CN", "我正在做 Atlas 项目。"],
    ["zh-CN", "我负责 Atlas 项目。"],
    ["zh-CN", "请记住，我正在做 Atlas 项目。"],
    ["en-US", "I am working on Atlas."],
    ["en-US", "My current project is Atlas."],
    ["en-US", "Remember that I am working on Atlas."],
    ["en-US", "I have been working on Atlas."],
    ["en-US", "Currently I am working on Atlas."],
    ["en-US", "Right now, I am working on Atlas."],
    ["zh-CN", "目前我负责 Atlas 项目。"],
    ["zh-CN", "现在我正在做 Atlas 项目。"],
    ["en-US", "I am working on Atlas, according to my current plan."],
    ["en-US", "I am working on Atlas, and I prefer what my colleague said."],
  ])("retains a direct current assertion: %s %s", async (locale, content) => {
    const output = await remember(content, locale);
    const projects = output.durable.profile?.activeContext.currentProjects ?? [];
    const activities = output.durable.facts.filter((fact) => /^(?:我正在做|I am working on )/u.test(fact.content));
    expect([...projects, ...activities.map((fact) => fact.content)].some((value) => value.includes("Atlas"))).toBe(true);
  });

  it("keeps conditional preferences without inventing a current project", async () => {
    const output = await remember("When I am working on Atlas, I prefer short updates.", "en-US");
    expect(output.durable.preferences.some((preference) => String(preference.value).includes("short updates"))).toBe(true);
    expect(output.durable.profile?.activeContext.currentProjects ?? []).toEqual([]);
  });

  it.each([
    ["en-US", 'I am working on "When Tomorrow Comes".', "When Tomorrow Comes"],
    ["en-US", 'My current project is "Not Atlas".', "Not Atlas"],
    ["en-US", "I am working on the Hypothetical Atlas project.", "Hypothetical Atlas"],
    ["zh-CN", "我正在做「过去式」项目。", "过去式"],
    ["en-US", 'I am working on "Atlas, Borealis".', "Atlas, Borealis"],
    ["zh-CN", "我正在做「甲，乙」项目。", "甲，乙"],
  ])("does not treat a project label as a source modality: %s %s", async (locale, content, project) => {
    const output = await remember(content, locale);
    const values = [...(output.durable.profile?.activeContext.currentProjects ?? []), ...output.durable.facts.map((fact) => fact.content)];
    expect(values.some((value) => value.includes(project))).toBe(true);
  });

  it("bounds a current project separately from an adjacent author preference", async () => {
    const output = await remember("I am working on Atlas, and I prefer short updates.", "en-US");
    expect(output.durable.profile?.activeContext.currentProjects).toEqual(["Atlas"]);
    expect(output.durable.preferences.some((preference) => String(preference.value).includes("short updates"))).toBe(true);
  });

  it("uses the same object boundary for profile and fact without a comma", async () => {
    const output = await remember("I am working on Atlas and I prefer short updates.", "en-US");
    expect(output.durable.profile?.activeContext.currentProjects).toEqual(["Atlas"]);
    expect(output.durable.facts.some((fact) => fact.content === "I am working on Atlas.")).toBe(true);
    expect(output.durable.facts.some((fact) => fact.content.includes("short updates"))).toBe(false);
  });

  it("bounds a role-drift project without attaching an adjacent preference", async () => {
    const output = await remember("I have now moved into a director role leading Atlas, and I prefer short updates.", "en-US");
    expect(output.durable.profile?.activeContext.currentProjects).toEqual(["Atlas"]);
    expect(output.durable.facts.some((fact) => fact.content.includes("role") && fact.content.includes("short updates"))).toBe(false);
    expect(output.durable.preferences.some((preference) => String(preference.value).includes("short updates"))).toBe(true);
  });

  it("preserves a current assertion before a trailing question", async () => {
    const output = await remember("我正在做 Atlas 项目，下一步做什么？", "zh-CN");
    expect(output.durable.facts.some((fact) => fact.content === "我正在做Atlas 项目。")).toBe(true);
  });

  it("does not strengthen responsibility into past leadership", async () => {
    const output = await remember("我负责 Atlas 项目。", "zh-CN");
    expect(output.durable.facts.some((fact) => fact.content.startsWith("我主导了"))).toBe(false);
  });

  it("keeps an author's current project beside a different quoted project", async () => {
    const output = await remember('A colleague wrote "I am working on Borealis." I am working on Atlas.', "en-US");
    expect(output.durable.profile?.activeContext.currentProjects).toEqual(["Atlas"]);
    expect(output.durable.facts.some((fact) => fact.content.startsWith("I am working on Borealis"))).toBe(false);
  });

  it.each(["I used to work on Atlas.", "When I work on Atlas, I prefer short updates.", 'A colleague said "I am working on Atlas."'])("rejects a producer's unsupported structured currentProject: %s", async (content) => {
    const memory = createGoodMemory({ storage: { provider: "memory" }, testing: { extractor: {
      async extract() { return { ignoredMessageCount: 0, candidates: [{ id: "assisted-project", kindHint: "profile", explicitness: "explicit", content: "Atlas", sourceMessageIndex: 0, sourceRole: "user", metadata: { profileField: "currentProject" } }] }; },
    } } });
    const scope = { userId: "assisted-current-project" };
    await memory.remember({ scope, messages: [{ role: "user", content }] });
    expect((await memory.exportMemory({ scope })).durable.profile?.activeContext.currentProjects ?? []).toEqual([]);
  });

  it("does not recover currentness proof removed from policy-safe source", async () => {
    const memory = createGoodMemory({ storage: { provider: "memory" }, testing: { extractor: {
      async extract() { return { ignoredMessageCount: 0, candidates: [{ id: "assisted-project", kindHint: "profile", explicitness: "explicit", content: "Atlas", sourceMessageIndex: 0, sourceRole: "user", metadata: { profileField: "currentProject" } }] }; },
    } }, policy: { redact: (candidate) => ({ ...candidate, content: candidate.content.replace("I am working on", "I used to work on") }) } });
    const scope = { userId: "redacted-current-project" };
    await memory.remember({ scope, messages: [{ role: "user", content: "I am working on Atlas." }] });
    expect((await memory.exportMemory({ scope })).durable.profile?.activeContext.currentProjects ?? []).toEqual([]);
  });

  it.each(["I am working on Atlas.", "My current project is Atlas."])("accepts a source-supported structured currentProject after policy processing: %s", async (content) => {
    const memory = createGoodMemory({ storage: { provider: "memory" }, testing: { extractor: {
      async extract() { return { ignoredMessageCount: 0, candidates: [{ id: "assisted-project", kindHint: "profile", explicitness: "explicit", content: "Atlas", sourceMessageIndex: 0, sourceRole: "user", metadata: { profileField: "currentProject" } }] }; },
    } } });
    const scope = { userId: "supported-current-project" };
    await memory.remember({ scope, messages: [{ role: "user", content }] });
    expect((await memory.exportMemory({ scope })).durable.profile?.activeContext.currentProjects).toEqual(["Atlas"]);
  });

  it("rechecks a derived current activity after source-only policy redaction", async () => {
    const memory = createGoodMemory({ storage: { provider: "memory" }, policy: {
      redact: (candidate) => candidate.kindHint === "noise"
        ? { ...candidate, content: candidate.content.replace("I am working on", "I used to work on") }
        : JSON.parse(JSON.stringify(candidate)),
    } });
    const scope = { userId: "source-only-current-redaction" };
    await memory.remember({ scope, messages: [{ role: "user", content: "I am working on Atlas." }] });
    const output = await memory.exportMemory({ scope });
    expect(output.durable.profile?.activeContext.currentProjects ?? []).toEqual([]);
    expect(output.durable.facts.some((fact) => fact.content === "I am working on Atlas.")).toBe(false);
  });

  it("does not resurrect a conditional project in a fresh facade's recall", async () => {
    const adapters = { documentStore: createInMemoryDocumentStore(), sessionStore: createInMemorySessionStore() };
    const create = () => createGoodMemory({ storage: { provider: "memory" }, adapters });
    const scope = { userId: "fresh-current-recall" };
    await create().remember({ scope: { ...scope, sessionId: "source" }, locale: "zh-CN", messages: [{ role: "user", content: "给我做旅行规划时，我更喜欢英文。" }] });
    const recalled = await create().recall({ scope: { ...scope, sessionId: "fresh" }, query: "我正在做什么项目？", strategy: "rules-only" });
    expect(recalled.facts.some((fact) => fact.content.startsWith("我正在做"))).toBe(false);
  });

  it("preserves the existing assisted current-project contract in another language", async () => {
    const memory = createGoodMemory({ storage: { provider: "memory" }, testing: { extractor: {
      async extract() { return { ignoredMessageCount: 0, candidates: [{ id: "assisted-project", kindHint: "profile", explicitness: "explicit", content: "Atlas", sourceMessageIndex: 0, sourceRole: "user", metadata: { profileField: "currentProject" } }] }; },
    } } });
    const scope = { userId: "japanese-current-project" };
    await memory.remember({ scope, locale: "ja-JP", messages: [{ role: "user", content: "私の現在のプロジェクトはAtlasです。" }] });
    expect((await memory.exportMemory({ scope })).durable.profile?.activeContext.currentProjects).toEqual(["Atlas"]);
  });

  it("does not change a Japanese primary-source contract because of auxiliary English evidence", async () => {
    const memory = createGoodMemory({ storage: { provider: "memory" }, testing: { extractor: {
      async extract() { return { ignoredMessageCount: 0, candidates: [{ id: "assisted-project", kindHint: "profile", explicitness: "explicit", content: "Atlas", sourceMessageIndex: 1, sourceMessageIndexes: [0, 1], sourceRole: "user", metadata: { profileField: "currentProject" } }] }; },
    } } });
    const scope = { userId: "japanese-primary-current-project" };
    await memory.remember({ scope, messages: [
      { role: "user", content: "The cache uses Redis." },
      { role: "user", content: "私の現在のプロジェクトはAtlasです。" },
    ] });
    expect((await memory.exportMemory({ scope })).durable.profile?.activeContext.currentProjects).toEqual(["Atlas"]);
  });

  it("preserves literal command facts without interpreting code as user activity", async () => {
    const output = await remember("Remember that the deployment command is `bun run build`.", "en-US");
    expect(output.durable.facts.some((fact) => fact.content.includes("`bun run build`"))).toBe(true);
  });
});
