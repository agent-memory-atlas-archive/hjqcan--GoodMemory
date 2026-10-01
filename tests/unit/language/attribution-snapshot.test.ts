import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createAttributionSnapshot, matchesAttributionSnapshot } from "../../../src/language/attributionSnapshot";

describe("private attribution snapshots", () => {
  test("reconstructs the existing author and withheld views from changed code units", () => {
    const source = "My name is Mira.\r\n> My name is Alice! 🛰️";
    const author = "My name is Mira.\r\n" + " ".repeat("> My name is Alice".length) + "! " + " ".repeat("🛰️".length);
    const view = createAttributionSnapshot(source, author, { sourceMessageIndex: 2, phase: "original" });
    expect(view.authorText).toBe(author);
    expect(view.withheldText).toBe(Array.from({ length: source.length }, (_, i) =>
      source[i] === author[i] ? " " : source[i]).join(""));
    expect(view.hasRestrictions).toBe(true);
    expect(view.sourceLength).toBe(source.length);
    expect(view.digestEncoding).toBe("sha256-utf16le");
    expect(view.sourceDigest).toBe(createHash("sha256").update(source, "utf16le").digest("hex"));
    let reconstructed = source;
    for (const span of view.spans) {
      expect(span.kind).toBe("masked-code-units");
      reconstructed = reconstructed.slice(0, span.start) + " ".repeat(span.end - span.start) + reconstructed.slice(span.end);
    }
    expect(reconstructed).toBe(author);
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view.spans)).toBe(true);
    expect(view.spans.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(view.binding)).toBe(true);
  });

  test("keeps unchanged input unrestricted without claiming authorship", () => {
    const source = "ordinary text;\n  punctuation.";
    const view = createAttributionSnapshot(source, source);
    expect(view.authorText).toBe(source);
    expect(view.withheldText).toBe("");
    expect(view.spans).toEqual([]);
    expect(view.hasRestrictions).toBe(false);
    expect(view.binding).toBeUndefined();
    expect(matchesAttributionSnapshot(view, source)).toBe(true);
  });

  test("binds exact source code units and immutable index and policy phase", () => {
    const source = "quoted name";
    const binding = { sourceMessageIndex: 0, phase: "original" as const };
    const view = createAttributionSnapshot(source, "           ", binding);
    binding.sourceMessageIndex = 1;
    expect(view.binding?.sourceMessageIndex).toBe(0);
    expect(matchesAttributionSnapshot(view, source, { sourceMessageIndex: 0, phase: "original" })).toBe(true);
    expect(matchesAttributionSnapshot(view, source, { sourceMessageIndex: 1, phase: "original" })).toBe(false);
    expect(matchesAttributionSnapshot(view, source, { sourceMessageIndex: 0, phase: "safe" })).toBe(false);
    expect(matchesAttributionSnapshot(view, source + " ", { sourceMessageIndex: 0, phase: "original" })).toBe(false);
    expect(matchesAttributionSnapshot({ ...view }, source, { sourceMessageIndex: 0, phase: "original" })).toBe(false);
  });

  test("does not normalize Unicode or replace unmatched surrogate code units in its digest", () => {
    const inputs = ["é", "e\u0301", "Ａ", "A", "\ud800", "\ud801", "\ufffd"];
    const views = inputs.map((source) => createAttributionSnapshot(source, source));
    expect(new Set(views.map((view) => view.sourceDigest)).size).toBe(inputs.length);
    for (let i = 0; i < inputs.length; i += 1) {
      expect(matchesAttributionSnapshot(views[i]!, inputs[(i + 1) % inputs.length]!)).toBe(false);
    }
  });

  test.each([
    ["short", "longer"],
    ["same", "tame"],
    ["x\ny", "x y"],
    ["🛰", " \udef0"],
  ])("rejects invalid mask output at case %# instead of returning unmasked input", (source, author) => {
    expect(() => createAttributionSnapshot(source, author)).toThrow();
  });

  test.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid source index at case %#", (sourceMessageIndex) => {
    expect(() => createAttributionSnapshot("text", "text", { sourceMessageIndex, phase: "safe" })).toThrow();
  });
});
