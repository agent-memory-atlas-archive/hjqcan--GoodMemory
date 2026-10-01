import { describe, expect, it } from "bun:test";
import { createChineseLanguagePack, createLanguageService } from "../../../src/language";
import { tokenizeDocumentSearch } from "../../../src/storage/textSearch";
import { tokenizeUnicodeText } from "../../../src/language/generic";
import { createPreferenceMemory } from "../../../src/domain/records";
import { selectPreferencesForQuery } from "../../../src/recall/selectors/recordSelection";

describe("Chinese adjacent identifier retrieval", () => {
  const language = createLanguageService();

  it.each(["zh-CN", "zh-Hant"])("keeps a complete numbered identifier in %s search and scoring", (locale) => {
    const query = "项目0的代号是什么？";
    const matching = "项目0的代号=Canary0";
    const other = "项目7的代号=Canary7";
    expect(language.buildSearchTerms(query, locale)).toContain("项目0");
    expect(language.tokenize(matching, locale)).toContain("项目0");
    expect(language.tokenOverlap(matching, query, locale, { excludeStopwords: true }))
      .toBeGreaterThan(language.tokenOverlap(other, query, locale, { excludeStopwords: true }));
    expect(tokenizeDocumentSearch(language.buildSearchTerms(query, locale).join(" "))).not.toContain("0");
  });

  it("does not join across punctuation or accept a prefix of a separated identifier", () => {
    for (const text of ["项目 7", "项目，7", "项目-7", "项目A-7", "项目A/7", "项目A.7", "项目A_7"]) {
      const tokens = language.buildSearchTerms(text, "zh-CN");
      expect(tokens).not.toContain("项目7");
      expect(tokens).not.toContain("项目a");
    }
    for (const text of ["项目A7‐9", "项目A7‑9", "项目A7–9", "项目A7--9", "项目A7é9", "项目A7/甲"]) {
      expect(language.buildSearchTerms(text, "zh-CN")).not.toContain("项目a7");
    }
  });

  it("keeps exact full suffixes rather than collapsing leading zeroes or unrelated entity types", () => {
    expect(language.buildSearchTerms("项目07的代号", "zh-CN")).toContain("项目07");
    expect(language.buildSearchTerms("项目07的代号", "zh-CN")).not.toContain("项目7");
    expect(language.buildSearchTerms("项目A7的代号", "zh-CN")).toContain("项目a7");
    expect(language.buildSearchTerms("通道7的代号", "zh-CN")).not.toContain("项目7");
    const query = "项目7的代号是什么？";
    const score = (text: string) => language.tokenOverlap(text, query, "zh-CN", { excludeStopwords: true });
    expect(score("项目7的代号=Canary7")).toBeGreaterThan(score("项目70的代号=Canary70"));
    expect(score("项目7的代号=Canary7")).toBeGreaterThan(score("通道7的代号=Canary7"));
  });

  it("normalizes width and case without altering the equality or entity contracts", () => {
    expect(language.buildSearchTerms("專案Ａ７的代號", "zh-Hant")).toContain("專案a7");
    expect(language.normalizeForEquality("项目A-7", "zh-CN")).toBe("项目a 7");
    expect(language.extractEntityMentions("项目7在2026年10月需要3个文件", "zh-CN")).toEqual([]);
    expect(language.buildSearchTerms("7", "zh-CN")).toEqual([]);
  });

  it("keeps ordinary unnumbered text tokenization unchanged", () => {
    for (const text of ["请记住我偏好简短回答", "项目的代号是什么", "今天吃午饭", "更新部署文档", "项目使用PostgreSQL数据库"]) {
      expect(language.tokenize(text, "zh-CN")).toEqual(tokenizeUnicodeText(text, "zh-CN"));
    }
  });

  it("does not evict established search terms when compounds exceed the term limit", () => {
    const text = `needleword ${Array.from({ length: 128 }, (_, index) => `项目${index}`).join(" ")}`;
    const existing = [...new Set(tokenizeUnicodeText(text, "zh-CN"))];
    const indexed = language.buildSearchTerms(text, "zh-CN");
    expect(indexed).toHaveLength(128);
    expect(indexed).toContain("needleword");
    for (const term of existing.slice(0, 128)) expect(indexed).toContain(term);
    // Scoring has always accepted more tokens than capped index expansion.
    expect(language.tokenize(text, "zh-CN")).toContain("项目7");
  });

  it("retains the numbered distinction without Intl.Segmenter", () => {
    const original = Object.getOwnPropertyDescriptor(Intl, "Segmenter")!;
    Object.defineProperty(Intl, "Segmenter", { ...original, value: undefined });
    try {
      expect(language.buildSearchTerms("项目7的代号", "zh-CN")).toContain("项目7");
      expect(language.buildSearchTerms("項目7的代號", "zh-Hant")).toContain("項目7");
      expect(language.buildSearchTerms("项目A-7的代号", "zh-CN")).not.toContain("项目a");
    } finally {
      Object.defineProperty(Intl, "Segmenter", original);
    }
  });

  it("does not dilute unnumbered preference questions with document-only identifier aliases", () => {
    const preference = createPreferenceMemory({
      id: "preference", userId: "synthetic", category: "response_style",
      value: "项目7 alpha beta gamma delta epsilon zeta eta theta iota kappa",
      source: { method: "explicit", extractedAt: "2026-10-01T00:00:00.000Z" },
    });
    expect(language.tokenOverlap(`${preference.category} ${preference.value}`, "alpha beta", "zh-CN", { excludeStopwords: true })).toBe(2 / 13);
    expect(selectPreferencesForQuery([preference], "alpha beta", language, "zh-CN").map(({ id }) => id)).toEqual(["preference"]);
  });

  it("does not reinterpret a custom tokenizer replacing the Chinese pack", () => {
    const custom = {
      ...createChineseLanguagePack("Hans"),
      analyzerVersion: "custom",
      tokenizeForScoring(text: string) { return text === "left" ? ["项目7", "common"] : ["common"]; },
    };
    const configured = createLanguageService({ packs: [custom] });
    expect(configured.tokenOverlap("left", "right", "zh-CN")).toBe(0.5);
  });

  it("handles long Han runs with no adjacent identifier within a bounded budget", () => {
    const text = `${"汉".repeat(1000)} 7`;
    const started = performance.now();
    expect(language.buildSearchTerms(text, "zh-CN")).not.toContain("汉7");
    expect(performance.now() - started).toBeLessThan(250);
  });
});
