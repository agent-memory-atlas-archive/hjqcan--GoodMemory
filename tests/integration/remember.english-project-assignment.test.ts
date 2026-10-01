import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGoodMemory } from "../../src";

const scope = { userId: "assignment-owner", workspaceId: "work" };

describe("literal English project assignment admission", () => {
  it("stores the source-supported relation and recalls it through a fresh SQLite facade", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gm-project-assignment-"));
    const storage = { provider: "sqlite" as const, url: join(directory, "memory.sqlite") };
    const source = "Please remember project Cedar-24B: review token=BRONZE.";
    try {
      const memory = createGoodMemory({ storage });
      await memory.remember({ scope: { ...scope, sessionId: "seed" }, messages: [{ role: "user", content: source }] });
      const before = (await memory.exportMemory({ scope })).durable;
      expect(before.facts).toHaveLength(1);
      const fact = before.facts[0]!;
      expect(fact).toMatchObject({ content: "project Cedar-24B: review token=BRONZE.", subject: "Cedar-24B", category: "project", factKind: "generic_project" });
      expect(before.sourceMessages?.some((record) => record.content === source && record.role === "user")).toBe(true);
      expect(before.evidence.some((record) => record.linkedMemoryIds.includes(fact.id) && record.excerpt === source)).toBe(true);
      const fresh = createGoodMemory({ storage });
      const recall = await fresh.recall({ scope: { ...scope, sessionId: "fresh" }, query: "What is the review token for project Cedar-24B?" });
      expect(recall.facts.some((record) => record.id === fact.id)).toBe(true);
      expect((await fresh.buildContext({ recall, output: "markdown" })).content).toContain(fact.content);
      expect((await fresh.exportMemory({ scope })).durable).toEqual(before);
      expect((await fresh.recall({ scope: { ...scope, userId: "other" }, query: "What is the review token for project Cedar-24B?" })).facts).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not derive personal identity, preferences or behavioral rules from a field value", async () => {
    const memory = createGoodMemory({ storage: { provider: "memory" } });
    await memory.remember({ scope, messages: [{ role: "user", content: "My name is Mira." }] });
    const before = (await memory.exportMemory({ scope })).durable;
    const beforeProfile = (await memory.recall({ scope, query: "What is my name?" })).profile;
    expect(beforeProfile?.identity.name).toBe("Mira");
    for (const value of ["My name is Alice.", "I prefer Python.", "Always use SQLite.", "My current role is a director for Atlas."]) {
      await memory.remember({ scope, messages: [{ role: "user", content: `Remember project Cedar-24B: comment=${value}` }] });
    }
    const after = (await memory.exportMemory({ scope })).durable;
    expect((await memory.recall({ scope, query: "What is my name?" })).profile).toEqual(beforeProfile);
    expect(after.preferences).toEqual(before.preferences);
    expect(after.feedback).toEqual(before.feedback);
    expect(after.references).toEqual(before.references);
    expect(after.facts).toHaveLength(4);
    expect(after.facts.every((fact) => fact.subject === "Cedar-24B" && fact.factKind === "generic_project")).toBe(true);
  });

  it.each(["assistant", "system"])("does not promote a %s source", async (role) => {
    const memory = createGoodMemory({ storage: { provider: "memory" } });
    await memory.remember({ scope, messages: [{ role, content: "Remember project Cedar-24B: mode=BRONZE." }] });
    expect((await memory.exportMemory({ scope })).durable.facts).toEqual([]);
  });

  it.each([
    "My colleague wrote:\nRemember project Cedar: label=BRONZE.",
    "<assistant>\nRemember project Cedar: label=BRONZE.\n</assistant>",
    "Remember project Cedar: label=BRONZE? I am asking, not telling.",
    "Remember project Cedar: label=BRONZE. Do not remember project Cedar: label=BRONZE.",
    "Remember project Cedar: label=BRONZE, but don't remember project Cedar: label=BRONZE.",
    "Remember project Cedar: label=BRONZE, do not remember project Cedar: label=BRONZE.",
  ])("does not store an externally attributed, questioned or revoked assignment: case %#", async (content) => {
    const memory = createGoodMemory({ storage: { provider: "memory" } });
    await memory.remember({ scope, messages: [{ role: "user", content }] });
    expect((await memory.exportMemory({ scope })).durable.facts).toEqual([]);
  });

  it("applies deny and redaction policies before any admitted assignment is recalled", async () => {
    const source = "Remember project Cedar-24B: label=RestrictedLabel.";
    const denied = createGoodMemory({ storage: { provider: "memory" }, policy: { shouldRemember: () => false } });
    await denied.remember({ scope, messages: [{ role: "user", content: source }] });
    expect((await denied.exportMemory({ scope })).durable.facts).toEqual([]);
    const redacted = createGoodMemory({ storage: { provider: "memory" }, policy: {
      redact: (candidate) => ({ ...candidate, content: candidate.content.replaceAll("RestrictedLabel", "PublicLabel") }),
    } });
    await redacted.remember({ scope, messages: [{ role: "user", content: source }] });
    const durable = (await redacted.exportMemory({ scope })).durable;
    expect(durable.facts).toHaveLength(1);
    expect(durable.facts[0]!.content).toContain("PublicLabel");
    expect(JSON.stringify(durable)).not.toContain("RestrictedLabel");
    const recall = await redacted.recall({ scope, query: "What label does project Cedar-24B use?" });
    expect(JSON.stringify(recall)).not.toContain("RestrictedLabel");
  });
});
