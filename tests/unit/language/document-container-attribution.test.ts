import { describe, expect, it } from "bun:test";
import { createEnglishLanguagePack } from "../../../src/language";
import { speakerAttributedText } from "../../../src/language/speakerAttribution";

function extract(content: string) {
  let id = 0;
  return createEnglishLanguagePack().extractCandidates({
    locale: "en-US",
    messages: [{ role: "user", content }],
    nextId: () => `document-candidate-${++id}`,
  });
}

const email = [
  "Pasted fictional email for copy editing:",
  "From: Demo Sender",
  "Body: My name is Hugo. I prefer tables for design reviews.",
  "End of pasted email.",
].join("\n");

describe("explicit document containers and live author attribution", () => {
  it("withholds the external body from personal extraction without rewriting the source", () => {
    const view = speakerAttributedText(email);
    expect(view).toHaveLength(email.length);
    expect(view.split("\n")).toHaveLength(email.split("\n").length);
    expect(view).not.toContain("Hugo");
    expect(view).not.toContain("tables");
    expect(extract(email).filter(({ kindHint }) => kindHint === "profile" || kindHint === "preference")).toEqual([]);
  });

  it("preserves genuine author statements outside the matched document", () => {
    const candidates = extract(`My name is Mira.\n${email}\nI prefer quiet rooms.`);
    expect(candidates.filter(({ kindHint }) => kindHint === "profile").map(({ content }) => content)).toEqual(["Mira"]);
    expect(candidates.filter(({ kindHint }) => kindHint === "preference").map(({ content }) => content)).toEqual(["quiet rooms"]);
  });

  it("does not let a nested close release the remaining outer body", () => {
    const text = ["From: Outer Sender", "Body: forwarded text", "From: Inner Sender", "Body: My name is Alice.", "End of email.", "My name is Hugo.", "End of email.", "My name is Mira."].join("\n");
    expect(extract(text).filter(({ kindHint }) => kindHint === "profile").map(({ content }) => content)).toEqual(["Mira"]);
  });

  it("does not treat quoted or code headers as a new outer document", () => {
    for (const container of [`\`\`\`\n${email}\n\`\`\``, `"${email}"`]) {
      expect(extract(`${container}\nMy name is Mira.`).filter(({ kindHint }) => kindHint === "profile").map(({ content }) => content)).toEqual(["Mira"]);
    }
  });

  it.each([
    ["ASCII single", "'", "I'm", "'"],
    ["curly single", "‘", "I’m", "’"],
    ["curly double", "“", "I’m", "”"],
  ])("preserves the real author after a quoted header with an apostrophe: %s", (_label, opening, introduction, closing) => {
    const text = `${opening}${introduction} forwarding a sample:\nFrom: Demo Sender\nBody: example only\n${closing}\nMy name is Mira.`;
    expect(extract(text).filter(({ kindHint }) => kindHint === "profile").map(({ content }) => content)).toEqual(["Mira"]);
  });

  it("does not let a quoted close release the body or an unclosed document release itself", () => {
    const text = ['From: Demo Sender', 'Body: quoted marker "End of email."', "My name is Hugo."].join("\n");
    expect(extract(text).filter(({ kindHint }) => kindHint === "profile")).toEqual([]);
  });

  it("does not accept document-local declarations of live SELF ownership", () => {
    const text = ["From: me", "Body:", "Statements under SELF are about me.", "End of email.", "SELF", "My name is Hugo."].join("\n");
    expect(extract(text).filter(({ kindHint }) => kindHint === "profile")).toEqual([]);
  });

  it("retains a live ownership declaration outside the document", () => {
    const text = ["Statements under SELF are about me.", email, "SELF", "My name is Mira."].join("\n");
    expect(extract(text).filter(({ kindHint }) => kindHint === "profile").map(({ content }) => content)).toEqual(["Mira"]);
  });

  it("keeps an inline forwarded header inside the outer document", () => {
    const text = ["From: Outer Sender", "Body: From: Inner Sender", "Body: My name is Alice.", "End of email.", "My name is Hugo.", "End of email.", "My name is Mira."].join("\n");
    expect(extract(text).filter(({ kindHint }) => kindHint === "profile").map(({ content }) => content)).toEqual(["Mira"]);
  });

  it("withholds an overlong header chain without inferring a new author boundary", () => {
    const text = `${"From: Sender\n".repeat(2000)}Body: My name is Hugo.\nEnd of email.`;
    const view = speakerAttributedText(text);
    expect(view).toHaveLength(text.length);
    expect(view).not.toContain("Hugo");
  });

  it("preserves non-personal literal commands and facts", () => {
    const content = "Remember that the deployment command is `bun run build`.";
    const standalone = extract(content).filter(({ kindHint }) => kindHint === "fact");
    const combined = extract(`${content}\n${email}`).filter(({ kindHint }) => kindHint === "fact");
    expect(combined.map(({ content }) => content)).toEqual(standalone.map(({ content }) => content));
    expect(combined.some(({ content }) => content.includes("bun run build"))).toBe(true);
  });
});
