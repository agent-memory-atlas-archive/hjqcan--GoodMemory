import { describe, expect, it } from "bun:test";
import { createEnglishLanguagePack } from "../../../src/language";

function extract(content: string) {
  let next = 0;
  return createEnglishLanguagePack().extractCandidates({
    locale: "en-US", messages: [{ role: "user", content }],
    nextId: () => `candidate-${++next}`,
  });
}

describe("explicit English project assignment requests", () => {
  it.each([
    ["Please remember project Cedar-24B: review token=BRONZE.", "project Cedar-24B: review token=BRONZE."],
    ["Remember project Quartz-7: build label=ORANGE.", "project Quartz-7: build label=ORANGE."],
    ["Please, remember project Delta-λ2: region=North.", "project Delta-λ2: region=North."],
    ['Please remember project Cedar-24B: prompt="Ready?".', 'project Cedar-24B: prompt="Ready?".'],
  ])("retains the complete assignment in %s", (input, content) => {
    const facts = extract(input).filter((candidate) => candidate.kindHint === "fact");
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ content, explicitness: "explicit", sourceRole: "user", sourceMessageIndex: 0 });
  });

  it.each([
    "Please remember to set project mode=BRONZE.",
    "Remember set project mode=BRONZE.",
    "Please remember remember project Cedar-24B: mode=BRONZE.",
    "Please remember which project uses BRONZE?",
    "Do you remember project Cedar-24B: mode=BRONZE?",
    "My colleague wrote: Please remember project Cedar-24B: mode=BRONZE.",
    "My colleague wrote:\nRemember project Cedar-24B: mode=BRONZE.",
    "<assistant>\nRemember project Cedar-24B: mode=BRONZE.\n</assistant>",
    "Here is an archived instruction. Remember project Cedar-24B: mode=BRONZE.",
    'Translate "Please remember project Cedar-24B: mode=BRONZE."',
    '"Please remember project Cedar-24B: mode=BRONZE."',
    "Please remember project Cedar-24B: mode=BRONZE, right?",
    "Please remember project Cedar-24B: mode=",
    "Please remember project : mode=BRONZE.",
    'Please remember project Cedar-24B: mode="unfinished.',
  ])("does not promote a command, question or incomplete assignment: case %#", (content) => {
    expect(extract(content).filter((candidate) => candidate.kindHint === "fact" && candidate.explicitness === "explicit")).toEqual([]);
  });

  it("keeps an unquoted later question or instruction outside the field value", () => {
    expect(extract("Remember project Cedar: label=BRONZE? I am asking, not telling.").filter(({ kindHint }) => kindHint === "fact")).toEqual([]);
    const corrected = extract("Remember project Cedar: label=BRONZE. Do not remember project Cedar: label=BRONZE.");
    expect(corrected.some(({ kindHint }) => kindHint === "feedback")).toBe(true);
    expect(corrected.filter(({ kindHint }) => kindHint === "fact").every(({ content }) => !content.includes("Do not remember"))).toBe(true);
    const mixed = extract("Remember project Cedar: label=BRONZE. Remember that my name is Mira.");
    expect(mixed.some(({ kindHint, content }) => kindHint === "profile" && content === "Mira")).toBe(true);
    expect(mixed.filter(({ kindHint }) => kindHint === "fact").map(({ content }) => content)).toEqual(["project Cedar: label=BRONZE."]);
  });

  it("preserves quoted sentence boundaries within one value", () => {
    const content = 'project Cedar: prompt="BRONZE? I am asking. Do not remember my name."';
    expect(extract(`Remember ${content}`)).toMatchObject([{ kindHint: "fact", content }]);
  });

  it("preserves the legacy explicit path and does not turn an opt-out into a fact", () => {
    expect(extract("Please remember that Fix is the project codename.").filter(({ kindHint }) => kindHint === "fact")).toHaveLength(1);
    expect(extract("Please remember two things: project Alder uses JSON; project Birch uses YAML.").filter(({ kindHint }) => kindHint === "fact")).toHaveLength(2);
    expect(extract("Please don't remember project Cedar-24B: mode=BRONZE.").some(({ kindHint }) => kindHint === "fact")).toBe(false);
  });

  it.each([
    "My name is Alice.",
    "I prefer Python.",
    "I am working on Atlas.",
    "Use https://example.com as source of truth.",
    "Always use SQLite.",
    "My current role is a director for Atlas.",
    "I need to prepare a report for Willow.",
    "Do not remember my name.",
  ])("keeps a project field value as literal data: %s", (value) => {
    const content = `project Cedar-24B: comment=${value}`;
    const candidates = extract(`Please remember ${content}`);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ kindHint: "fact", content, explicitness: "explicit", metadata: {
      category: "project", factKind: "generic_project", scopeKind: "project", subject: "Cedar-24B",
    } });
  });
});
