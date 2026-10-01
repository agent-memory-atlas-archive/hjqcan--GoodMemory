import { expect, it } from "bun:test";
import { createGoodMemory } from "../../src";

it("preserves the real author through an explicitly pasted email and retains its literal source", async () => {
  const memory = createGoodMemory({ storage: { provider: "memory" } });
  const scope = { userId: "document-author", workspaceId: "work" };
  await memory.remember({ scope, messages: [{ role: "user", content: "My name is Nia. I prefer diagrams for design reviews." }] });
  const query = "What is my name and preference for design reviews?";
  const before = await memory.recall({ scope, query });
  expect(before.profile?.identity.name).toBe("Nia");
  expect(before.preferences.some((record) => String(record.value).includes("diagrams"))).toBe(true);
  const source = ["Pasted fictional email for copy editing:", "From: Demo Sender", "Body: My name is Hugo. I prefer tables for design reviews.", "End of pasted email."].join("\n");
  await memory.remember({ scope: { ...scope, sessionId: "document" }, messages: [{ role: "user", content: source }] });
  const after = await memory.recall({ scope: { ...scope, sessionId: "fresh" }, query });
  expect(after.profile).toEqual(before.profile);
  expect(after.preferences.map(({ value }) => value)).toEqual(before.preferences.map(({ value }) => value));
  const context = await memory.buildContext({ recall: after, output: "system_prompt_fragment" });
  expect(context.content).toContain("Nia");
  expect(context.content).toContain("diagrams");
  expect(context.content).not.toContain("Hugo");
  expect(context.content).not.toContain("tables");
  const durable = (await memory.exportMemory({ scope })).durable;
  expect(durable.sourceMessages?.some(({ content }) => content === source)).toBe(true);
});

it.each([
  ["name", "Alice", "My name is Alice."],
  ["location", "Paris", "I live in Paris."],
  ["organization", "Acme", "I work at Acme."],
  ["role", "doctor", "I am a doctor."],
  ["currentProject", "Atlas", "My current project is Atlas."],
] as const)("rejects an assisted %s borrowed from the external body", async (field, value, assertion) => {
  const memory = createGoodMemory({ storage: { provider: "memory" }, testing: { extractor: {
    async extract() { return { ignoredMessageCount: 0, candidates: [{ id: "external-profile", kindHint: "profile", explicitness: "explicit", sourceRole: "user", sourceMessageIndex: 0, content: value, metadata: { profileField: field } }] }; },
  } } });
  const scope = { userId: `external-${field}` };
  const result = await memory.remember({ scope, messages: [{ role: "user", content: `From: Demo Sender\nBody: ${assertion}\nEnd of email.` }] });
  expect(result.accepted).toBe(0);
  expect((await memory.exportMemory({ scope })).durable.profile).toBeNull();
});

it.each([
  ["name", "Alice", "My name is Alice."],
  ["currentProject", "Atlas", "My current project is Atlas."],
] as const)("does not let source-only header redaction turn an external %s into author evidence", async (field, value, assertion) => {
  const memory = createGoodMemory({ storage: { provider: "memory" }, policy: {
    redact: (candidate) => candidate.kindHint === "noise"
      ? { ...candidate, content: candidate.content.replace("From: Demo Sender\nBody: ", "").replace("\nEnd of email.", "") }
      : JSON.parse(JSON.stringify(candidate)),
  }, testing: { extractor: {
    async extract() { return { ignoredMessageCount: 0, candidates: [{ id: "external-profile", kindHint: "profile", explicitness: "explicit", sourceRole: "user", sourceMessageIndex: 0, content: value, metadata: { profileField: field } }] }; },
  } } });
  const scope = { userId: "external-redaction" };
  const result = await memory.remember({ scope, messages: [{ role: "user", content: `From: Demo Sender\nBody: ${assertion}\nEnd of email.` }] });
  expect(result.accepted).toBe(0);
  expect((await memory.exportMemory({ scope })).durable.profile).toBeNull();
});

it("allows consistent redaction of a real current project outside an unrelated document", async () => {
  const memory = createGoodMemory({ storage: { provider: "memory" }, policy: {
    redact: (candidate) => ({ ...candidate, content: candidate.content.replaceAll("Atlas", "ProjectAlias") }),
  } });
  const scope = { userId: "outside-redacted-project" };
  await memory.remember({ scope, messages: [{ role: "user", content: "My current project is Atlas.\nFrom: Demo Sender\nBody: My name is Hugo.\nEnd of email." }] });
  const durable = (await memory.exportMemory({ scope })).durable;
  expect(durable.profile?.activeContext.currentProjects).toEqual(["ProjectAlias"]);
  expect(JSON.stringify(durable)).not.toContain("Atlas");
  expect(durable.profile?.identity.name).toBeUndefined();
});

it("allows consistent redaction of a real name outside an unrelated document", async () => {
  const memory = createGoodMemory({ storage: { provider: "memory" }, policy: {
    redact: (candidate) => ({ ...candidate, content: candidate.content.replaceAll("Mira", "AuthorAlias") }),
  } });
  const scope = { userId: "outside-redacted-name" };
  await memory.remember({ scope, messages: [{ role: "user", content: "My name is Mira.\nFrom: Demo Sender\nBody: My name is Hugo.\nEnd of email." }] });
  const durable = (await memory.exportMemory({ scope })).durable;
  expect(durable.profile?.identity.name).toBe("AuthorAlias");
  expect(JSON.stringify(durable)).not.toContain("Mira");
});

it("uses the same container boundary for Chinese personal assertions", async () => {
  const memory = createGoodMemory({ storage: { provider: "memory" } });
  const scope = { userId: "external-chinese" };
  await memory.remember({ scope, locale: "zh-CN", messages: [{ role: "user", content: "我叫小明。" }] });
  await memory.remember({ scope, locale: "zh-CN", messages: [{ role: "user", content: "From: Demo Sender\nBody: 我叫小林。我喜欢喝咖啡。\nEnd of email." }] });
  const durable = (await memory.exportMemory({ scope })).durable;
  expect(durable.profile?.identity.name).toBe("小明");
  expect(durable.preferences).toEqual([]);
});
