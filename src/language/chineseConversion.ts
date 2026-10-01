import {
  normalizeUnicodeForEquality,
  tokenizeUnicodeText,
} from "./generic";
import type { LanguagePack } from "./contracts";

export const CHINESE_ANALYZER_VERSION = "23-adjacent-identifiers";

const SEGMENTERS = new Map<string, Intl.Segmenter>();
type Tokenizer = LanguagePack["tokenizeForScoring"];
type TokenOptions = Parameters<Tokenizer>[2];
const IDENTIFIER_ALIASES = new WeakMap<Tokenizer, (text: string, options: TokenOptions) => string[]>();

export function registerChineseIdentifierTokenizer(
  tokenizer: Tokenizer,
  aliases: (text: string, options: TokenOptions) => string[],
): Tokenizer {
  IDENTIFIER_ALIASES.set(tokenizer, aliases);
  return tokenizer;
}

/** Keep unnumbered comparisons at their legacy denominator. Custom tokenizers
 * are identified by function identity, not a replaceable pack ID or version. */
export function removeUnpairedChineseIdentifierAliases(
  tokenizer: Tokenizer, left: string, right: string, options: TokenOptions,
  leftTokens: Set<string>, rightTokens: Set<string>,
): void {
  const aliases = IDENTIFIER_ALIASES.get(tokenizer);
  if (!aliases) return;
  const leftAliases = aliases(left, options).filter((token) => leftTokens.has(token));
  const rightAliases = aliases(right, options).filter((token) => rightTokens.has(token));
  if (leftAliases.length > 0 && rightAliases.length === 0) {
    for (const token of leftAliases) leftTokens.delete(token);
  } else if (rightAliases.length > 0 && leftAliases.length === 0) {
    for (const token of rightAliases) rightTokens.delete(token);
  }
}

// Use original character adjacency before punctuation normalization. A bare
// digit is not a retrieval term, and a separated identifier must not become
// a partial identifier (for example, 项目A-7 must not become 项目a).
function adjacentIdentifierTokens(text: string, locale: string): string[] {
  const normalized = text.normalize("NFKC").toLowerCase();
  let segmenter: Intl.Segmenter | undefined;
  if (typeof Intl.Segmenter === "function") {
    segmenter = SEGMENTERS.get(locale);
    if (!segmenter) {
      segmenter = new Intl.Segmenter(locale, { granularity: "word" });
      SEGMENTERS.set(locale, segmenter);
    }
  }
  const tokens: string[] = [];
  for (const match of normalized.matchAll(/[\p{Script=Han}]+/gu)) {
    const suffixStart = match.index + match[0].length;
    const suffix = normalized.slice(suffixStart).match(/^[a-z0-9]+/u)?.[0];
    if (!suffix || !/[0-9]/u.test(suffix)) continue;
    const tail = normalized.slice(suffixStart + suffix.length);
    const next = tail.match(/^./u)?.[0] ?? "";
    if ((/^[\p{L}\p{N}\p{M}]$/u.test(next) && !/^\p{Script=Han}$/u.test(next)) ||
      /^[\p{Dash_Punctuation}_./\\]+[\p{L}\p{N}\p{M}]/u.test(tail)) continue;
    const prefix = match[0];
    let word = [...prefix].slice(-2).join("");
    if (segmenter) {
      for (const segment of segmenter.segment(prefix)) {
        if (segment.isWordLike && /^[\p{Script=Han}]+$/u.test(segment.segment)) {
          word = segment.segment;
        }
      }
    }
    tokens.push(`${word}${suffix}`);
  }
  return tokens;
}

export function additionalChineseIdentifierTokens(text: string, locale: string): string[] {
  const identifiers = adjacentIdentifierTokens(text, locale);
  if (identifiers.length === 0) return [];
  const legacy = new Set(tokenizeUnicodeText(text, locale));
  return identifiers.filter((token) => !legacy.has(token));
}

export function normalizeChineseForEquality(text: string): string {
  return normalizeUnicodeForEquality(text);
}

export function tokenizeChineseForScoring(
  text: string,
  locale: string,
): string[] {
  const legacy = tokenizeUnicodeText(text, locale);
  const legacyTerms = new Set(legacy);
  return [...adjacentIdentifierTokens(text, locale).filter((token) => !legacyTerms.has(token)), ...legacy];
}

export function buildChineseSearchTerms(
  text: string,
  locale: string,
): string[] {
  // Existing index coverage takes precedence when the service applies its
  // search-term cap. New identifier keys fill the remaining capacity.
  return [...new Set([...tokenizeUnicodeText(text, locale), ...adjacentIdentifierTokens(text, locale)])];
}
