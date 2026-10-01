// First-person wording inside a quote, example, or hypothetical is not evidence
// about the message author. Preserve offsets while withholding those spans from
// deterministic personal extraction; canonical source messages stay unchanged.
import type { MemoryCandidate } from "../domain/memoryCandidate";

// An internal restriction, not producer metadata or permission to write. It
// survives internal object spreads but is absent from JSON/wire representations.
const FINAL_SOURCE_GROUNDING = Symbol("final-source-grounding-required");
export function requiresFinalSourceGrounding(candidate: MemoryCandidate): boolean {
  return (candidate as MemoryCandidate & { [FINAL_SOURCE_GROUNDING]?: boolean })[FINAL_SOURCE_GROUNDING] === true;
}

const FIRST_PERSON = /\bi\b(?![/\\])|\b(?:my|me|je|moi|mon|ma|mes|yo|mi)\b|\bj['’]|我|私|僕|나는|저는|제\s/iu;
const PERSONAL_ASSERTION = /\b(?:my\s+(?:name|timezone|preferred\s+language|language)|i\s*(?:am\b|'m\b|(?:(?:no\s+longer|do\s+not|don't)\s+)?prefer\b|like\b|love\b|withdraw\b|retract\b)|restore\s+my\b)|我(?:自己)?(?:叫|(?:的)?(?:名字|姓名|时区|時區|语言|語言)|是|在|(?:不再|不)?(?:喜欢|喜歡|偏好))/iu;
const NON_ACTUAL = /^\s*(?:(?:(?:please\s+)?(?:pretend|imagine|suppose|translate|roleplay)\b)|(?:in|from)\s+(?:(?:my|the|a|this)\s+)?(?:novel|fiction|story)\b|(?:this\s+is\s+(?:an?\s+)?)?(?:hypothetical|example|sample|test\s+string)\b|(?:here\s+is\s+(?:an?\s+)?(?:example|sample|test\s+string))\b|(?:小说里|小說裡|小说中|小說中|假设|假設|假如|如果|假使|倘若|想象|想像|例如|示例|例子|(?:请|請)?(?:翻译|翻譯)|测试|測試|字符串))/iu;
const DIRECT_SELF_REPORT = /\bi\s+(?:(?:said|say|wrote|write|introduced\s+myself)(?:\s+to\s+(?:him|her|them|you|my\s+(?:friend|colleague|family)))?|(?:told|tell)\s+(?:him|her|them|you|my\s+(?:friend|colleague|family)))\s*[:,-]?\s*$|我(?:(?:说|說|自我介绍|自我介紹)|(?:告诉|告訴)(?:他|她|你|他们|她们|你们|他們|她們|你們|朋友)|(?:对|對)(?:他|她|你|朋友)(?:说|說))\s*[:：，,]?\s*$/iu;
const OTHER_REPORT = /\b(?:said|says|wrote|writes|saying|told|tell|replied|replies|asked|asks|explained|reported)\b|(?:说|說|告诉|告訴|回复|回覆|问|問)/iu;
const DENIED = /\b(?:not\s+true\s+that|false\s+that|not\s+the\s+case\s+that|does(?:n't|\s+not)\s+mean)\b|不是说|不是說|不代表|并非|並非/iu;
const QUOTE_PAIRS = new Map([["\"", "\""], ["'", "'"], ["“", "”"], ["‘", "’"], ["「", "」"], ["『", "』"], ["«", "»"], ["‹", "›"]]);

function apostrophe(text: string, index: number): boolean {
  return (text[index] === "'" || text[index] === "’") && /[\p{L}\p{N}]/u.test(text[index - 1] ?? "") && /[\p{L}\p{N}]/u.test(text[index + 1] ?? "");
}

function escaped(text: string, index: number): boolean {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function clauseBefore(text: string, index: number): string {
  return text.slice(0, index).split(/[.!?;\n。！？；]/u).at(-1) ?? "";
}

function blank(text: string): string {
  return text.replace(/[^\n\r.!?;。！？；]/g, " ");
}

function authorIsLastReportedSpeaker(text: string): boolean {
  // Only a directly adjacent, bounded self-report introduces the quoted voice.
  // An earlier "I told you" must not win over an intervening unknown speaker.
  return DIRECT_SELF_REPORT.test(text.replace(/["'“‘「『]\s*$/u, ""));
}

function maskSerializedRoleSpans(text: string): string {
  const spans: Array<[number, number]> = [];
  const stack: string[] = [];
  let start: number | undefined;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "<") continue;
    const head = /^<(\/?)([a-z][a-z0-9_-]*)\b/iu.exec(text.slice(index));
    if (!head) continue;
    let end = index + head[0].length;
    let quote: string | undefined;
    for (; end < text.length; end += 1) {
      const char = text[end]!;
      if (quote) { if (char === quote) quote = undefined; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === ">") break;
    }
    const name = head[2]!.toLowerCase();
    const tag = text.slice(index, Math.min(end + 1, text.length));
    const closing = head[1] === "/";
    const role = /^(?:system|user|assistant)$/u.test(name) ||
      (name === "message" && /\brole\s*=\s*["'](?:system|user|assistant)["']/iu.test(tag));
    const selfClosing = /\/\s*>$/u.test(tag);
    if (!closing && (start !== undefined || role)) {
      start ??= index;
      if (!selfClosing) stack.push(name);
      else if (stack.length === 0) { spans.push([start, end + 1]); start = undefined; }
    } else if (closing && start !== undefined && stack.at(-1) === name) {
      stack.pop();
      if (stack.length === 0) { spans.push([start, end + 1]); start = undefined; }
    }
    index = end;
  }
  if (start !== undefined) spans.push([start, text.length]);
  let result = "", previous = 0;
  for (const [from, to] of spans) {
    result += text.slice(previous, from) + blank(text.slice(from, to));
    previous = to;
  }
  return result + text.slice(previous);
}

function documentContainerSpans(structuralText: string): Array<[number, number]> {
  const from = /^\s*from\s*:/iu;
  const header = /^\s*(?:to|cc|bcc|subject|date|reply-to|message-id|mime-version|content-type|content-transfer-encoding)\s*:/iu;
  const body = /^\s*body\s*:\s*/iu;
  const close = /^end\s+(?:of\s+)?(?:(?:pasted|quoted|forwarded)\s+)?e-?mail\s*[.!]?$/iu;
  const spans: Array<[number, number]> = [];
  let pending: { start: number; lines: number } | undefined;
  let outerStart: number | undefined;
  let depth = 0;
  // One pass over bounded header blocks. Blank lines never restore authorship.
  for (const match of structuralText.matchAll(/[^\n]*(?:\n|$)/gu)) {
    if (!match[0]) break;
    const line = match[0].replace(/\r?\n$/u, "");
    const start = match.index;
    const end = start + match[0].length;
    if (depth > 0 && close.test(line.trim())) {
      // An unresolved nested header cannot release its enclosing document.
      if (pending) { pending = undefined; continue; }
      depth -= 1;
      if (depth === 0) {
        spans.push([outerStart!, end]);
        outerStart = undefined;
      }
      continue;
    }
    const bodyMatch = body.exec(line);
    if (pending && bodyMatch) {
      outerStart ??= pending.start;
      depth += 1;
      pending = undefined;
      if (depth > 32) return [...spans, [outerStart, structuralText.length]];
      // A forwarded header may start directly after the outer Body: label.
      if (from.test(line.slice(bodyMatch[0].length))) pending = { start, lines: 1 };
      continue;
    }
    if (from.test(line)) {
      pending = pending ? { ...pending, lines: pending.lines + 1 } : { start, lines: 1 };
    } else if (pending && (header.test(line) || !line.trim())) {
      pending.lines += 1;
    } else {
      pending = undefined;
    }
    if (pending && pending.lines > 16) {
      return [...spans, [outerStart ?? pending.start, structuralText.length]];
    }
  }
  if (outerStart !== undefined) spans.push([outerStart, structuralText.length]);
  return spans;
}

function maskSpans(text: string, spans: readonly [number, number][]): string {
  let result = "", previous = 0;
  for (const [start, end] of spans) {
    result += text.slice(previous, start) + blank(text.slice(start, end));
    previous = end;
  }
  return result + text.slice(previous);
}

function maskEmbeddedSpeakers(text: string): string {
  // Serialized role tags are document data, never the enclosing live speaker.
  let result = maskSerializedRoleSpans(text);
  const roles = /^(\s*)(SELF|ME|SYSTEM|USER|ASSISTANT|INTERVIEWEE|INTERVIEWER|SPEAKER(?:\s+\d+)?|CUSTOMER|GUEST)(?:(\s*:\s*)(.*)|\s*)$/iu;
  // An ownership declaration is authority only in the live preface, before
  // any serialized speaker section, outside removed XML/quoted/code content.
  let declarationView = result.replace(/^[\t ]*>[^\n]*/gm, blank);
  for (let index = 0; index < declarationView.length; index += 1) {
    const opening = declarationView[index]!;
    const closing = opening === "`" ? (declarationView.startsWith("```", index) ? "```" : "`") : QUOTE_PAIRS.get(opening);
    if (!closing || apostrophe(declarationView, index) || escaped(declarationView, index)) continue;
    const width = opening === "`" ? closing.length : 1;
    let end = declarationView.indexOf(closing, index + width);
    while (end >= 0 && (escaped(declarationView, end) ||
      ((closing === "'" || closing === "’") && apostrophe(declarationView, end)))) {
      end = declarationView.indexOf(closing, end + 1);
    }
    const stop = end < 0 ? declarationView.length : end + closing.length;
    declarationView = declarationView.slice(0, index) + blank(declarationView.slice(index, stop)) + declarationView.slice(stop);
    index = stop - 1;
  }
  // Header/body containers are external data. Mask them before recognizing
  // any document-local declaration that would otherwise grant SELF authority.
  const documentSpans = documentContainerSpans(declarationView);
  result = maskSpans(result, documentSpans);
  declarationView = maskSpans(declarationView, documentSpans);
  const prefaceLines = declarationView.split(/\r?\n/u);
  const firstSpeaker = prefaceLines.findIndex((line) => roles.test(line));
  const preface = prefaceLines.slice(0, firstSpeaker < 0 ? undefined : firstSpeaker).join("\n");
  const ownLabels = new Set<string>();
  for (const clause of preface.split(/[.!?;\n。！？；]/u)) {
    const match = /^\s*(?:statements|sections?|notes|entries)\s+(?:under|labeled|labelled)\s+([A-Z][A-Z0-9_-]{0,30})\s+(?:are|is)\s+(?:about me|mine)\s*$/iu.exec(clause);
    if (match) ownLabels.add(match[1]!.toUpperCase());
  }
  let section: "author" | "external" | undefined;
  const structuralLines = declarationView.split(/(\r?\n)/u);
  result = result.split(/(\r?\n)/u).map((line, index) => {
    if (/^\r?\n$/u.test(line)) return line;
    const heading = roles.exec(structuralLines[index] ?? "");
    if (heading) {
      const own = ownLabels.has(heading[2]!.toUpperCase());
      section = own ? "author" : "external";
      if (heading[3] !== undefined && heading[4]?.length) {
        const bodyStart = line.indexOf(":", heading[1]!.length + heading[2]!.length) + 1;
        return own ? blank(line.slice(0, bodyStart)) + line.slice(bodyStart) : blank(line);
      }
      return blank(line);
    }
    return section === "external" ? blank(line) : line;
  }).join("");
  return result;
}

export function speakerAttributedText(text: string): string {
  text = maskEmbeddedSpeakers(text);
  text = text.replace(/^[\t ]*>[^\n]*/gm, (line) => FIRST_PERSON.test(line) ? blank(line) : line);
  let result = "";
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const opening = text[index]!;
    const code = opening === "`";
    const closing = code ? (text.startsWith("```", index) ? "```" : "`") : QUOTE_PAIRS.get(opening);
    if (!closing || apostrophe(text, index) || escaped(text, index)) continue;
    const width = code ? closing.length : 1;
    let end = text.indexOf(closing, index + width);
    while (end >= 0 && (escaped(text, end) || ((closing === "'" || closing === "’") && apostrophe(text, end)))) end = text.indexOf(closing, end + 1);
    const closed = end >= 0;
    if (!closed) end = text.length;
    const body = text.slice(index + width, end);
    const before = clauseBefore(text, index);
    const after = text.slice(end + closing.length).match(/^\s*,?\s*(?:I\s+(?:said|told|wrote)|我(?:说|說|告诉|告訴))/iu)?.[0] ?? "";
    const selfReport = closed && !NON_ACTUAL.test(before) && !DENIED.test(before) && !/\bif\b/iu.test(before) &&
      (authorIsLastReportedSpeaker(before) || authorIsLastReportedSpeaker(after));
    const literalName = /(?:\bmy\s+name\s+is|我(?:叫|(?:的)?(?:名字|姓名)(?:是|叫)))\s*$/iu.test(before);
    const stop = closed ? end + closing.length : end;
    if (code || (!selfReport && !literalName && (FIRST_PERSON.test(body) || NON_ACTUAL.test(before)))) {
      result += text.slice(start, index) + blank(text.slice(index, stop));
      start = stop;
    }
    index = stop - 1;
  }
  result += text.slice(start);
  return result.replace(/[^.!?;\n。！？；]+/gu, (clause) => {
    // Modality governs the speaker regardless of the personal verb. An
    // assisted location/organization claim must not escape merely because
    // live/work are absent from the deterministic profile grammar.
    if (FIRST_PERSON.test(clause) && (NON_ACTUAL.test(clause) || /^\s*if\b/iu.test(clause))) return blank(clause);
    const assertion = PERSONAL_ASSERTION.exec(clause);
    if (!assertion) return clause;
    const prefix = clause.slice(0, assertion.index);
    if (NON_ACTUAL.test(prefix) || DENIED.test(prefix) || /\bif\s*$/iu.test(prefix) ||
      (OTHER_REPORT.test(prefix) && !authorIsLastReportedSpeaker(prefix))) {
      return blank(clause);
    }
    return clause;
  });
}

export function hasUnattributedPersonalClaims(text: string): boolean {
  // Structural document/quotation boundaries apply across language packs.
  // They must not depend on an English-only list of personal verbs.
  return speakerAttributedText(text) !== text;
}

export function withheldPersonalText(text: string): string {
  if (!hasUnattributedPersonalClaims(text)) return "";
  const attributed = speakerAttributedText(text);
  return Array.from({ length: text.length }, (_, index) =>
    text[index] === attributed[index] ? " " : text[index]).join("");
}

/** Attribution masking must never rewrite commands, quoted facts or pointers. */
export function extractWithPersonalAttribution(
  text: string,
  extract: (content: string, markAuthorDerived: (candidate: MemoryCandidate) => MemoryCandidate) => MemoryCandidate[],
): MemoryCandidate[] {
  // This ephemeral marker is only supplied to trusted pack generation code.
  // It is not serialized metadata or authority that an extractor can claim.
  const authorDerived = new WeakSet<MemoryCandidate>();
  const markAuthorDerived = (candidate: MemoryCandidate): MemoryCandidate => {
    authorDerived.add(candidate);
    Object.assign(candidate, { [FINAL_SOURCE_GROUNDING]: true });
    return candidate;
  };
  const attributed = speakerAttributedText(text);
  if (attributed === text) return extract(text, markAuthorDerived);
  const personal = (candidate: MemoryCandidate) =>
    candidate.kindHint === "profile" || candidate.kindHint === "preference" || authorDerived.has(candidate);
  return [
    ...extract(text, markAuthorDerived).filter((candidate) => !personal(candidate)),
    ...extract(attributed, markAuthorDerived).filter(personal),
  ];
}
