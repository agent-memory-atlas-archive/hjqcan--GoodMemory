import { hasUnterminatedQuote, maskQuotedText } from "./generic";

/**
 * A bounded present-assertion grammar, separate from speaker attribution.
 * The match must start an independent author statement. A substring inside a
 * request, condition, historical frame or report cannot establish currentness.
 * This only establishes the source utterance's assertion, not present-day truth
 * when an old message is replayed.
 */
export function matchCurrentAssertion(
  content: string,
  pattern: RegExp,
  language: "en" | "zh",
): RegExpMatchArray | null {
  const directedStatement = language === "en"
    ? content.trim().replace(/^(?:please\s+)?remember\s+(?:that\s+)?[:：,]?\s*/iu, "")
    : content.trim().replace(/^(?:请|請)?(?:记住|記住)[，,:：]?\s*/u, "");
  // Consume only an affirmative present-time frame directly introducing the
  // author, not an arbitrary preamble that happens to contain a self pronoun.
  const statement = language === "en"
    ? directedStatement.replace(/^(?:currently|right\s+now|now|at\s+present|at\s+the\s+moment)\s*,?\s*(?=i\b)/iu, "")
    : directedStatement.replace(/^(?:目前|现在|現在|眼下)[，,]?\s*(?=我)/u, "");
  if (hasUnterminatedQuote(statement)) return null;
  const syntax = maskQuotedText(statement);
  // Every current-project generator shares the same quote-aware target end.
  // Keep the original text for captured values; the masked view is syntax only.
  const boundary = syntax.search(language === "en"
    ? /[,，.!?;。！？；]|\s+and\s+i\b/iu
    : /[,，.!?;。！？；]|(?:并且|並且|而且|而)我/u);
  const assertion = boundary < 0 ? statement : statement.slice(0, boundary);
  const match = assertion.match(pattern);
  if (!match || match.index !== 0) return null;
  // Quoted project labels are values, not clauses that can alter modality.
  const asserted = maskQuotedText(match[0]);
  // Object extraction may stop at a comma. Qualification must still inspect
  // the following source clauses, rather than turn a truncated object match
  // into an independent assertion. Ordinary additive author clauses are kept.
  const followingClauses = syntax.slice(assertion.length)
    .split(/[,，]/u).map((clause) => clause.trim()).filter(Boolean);
  if (language === "en") {
    if (/\b(?:if|when|whenever|unless|until)\b|\bin\s+the\s+past\b|\bin\s+(?:(?:this|that|a|the)\s+)?(?:hypothetical|fictional)\s+(?:example|scenario|story|setting|case)\b/iu.test(asserted)) return null;
    if (followingClauses.some((clause) => /^(?:if|when|whenever|unless|until|but)\b|^in\s+(?:the\s+past|(?:(?:this|that|a|the)\s+)?(?:hypothetical|fictional)\s+(?:example|scenario|story|setting|case))\b/iu.test(clause))) return null;
    if (followingClauses.some((clause) =>
      /^according\s+to\s+(?!my\s+(?:current\s+)?plan\b|me\b)/iu.test(clause) ||
      (!/^(?:(?:and|as)\s+)?i\b/iu.test(clause) &&
        /\b(?:said|says|wrote|writes|replied|reported|told\s+me)\s*[.!?]?$/iu.test(clause)))) return null;
  } else {
    if (/(?:做|负责|推[进進]|[参參][与與])(?:过|過|了)|(?:时|時|时候|時候|期间|期間|之前|之后|之後)(?:[，,。.!！?？]|$)|(?:过去|過去|曾经|曾經|以前|假设|假設|虚构|虛構)/u.test(asserted)) return null;
    if (followingClauses.some((clause) => /^(?:如果|假如|假设|假設|假使|当|當|但是|但|不过|不過)|^(?:这|這|那)?(?:已经|已經)?是(?:过去|過去|以前|曾经|曾經|假设|假設|虚构|虛構)/u.test(clause))) return null;
  }
  return match;
}
