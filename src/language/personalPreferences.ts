import { speakerAttributedText } from "./speakerAttribution";

export interface PersonalPreferenceStatement {
  value: string;
  raw: string;
  object: string;
  context: string | null;
  polarity: "positive" | "withdrawn";
  explicitUpdate: boolean;
  additive: boolean;
  start: number;
  end: number;
  renderedValue: string;
}

export function normalizePreferenceSurface(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim().toLowerCase();
}

function target(value: string): { object: string; context: string | null } {
  const match = /^(.+?)\s+((?:for|in|when|during|at)\s+.+)$/iu.exec(value) ??
    /^(.+?)((?:用于|用於|用来|用來|做|作为|作為).+)$/u.exec(value);
  return { object: (match?.[1] ?? value).trim(), context: match?.[2]?.trim() ?? null };
}

/** Only explicit surface statements; no synonym, embedding, or learned slot matching. */
export function parsePersonalPreferenceStatements(text: string): PersonalPreferenceStatement[] {
  const source = speakerAttributedText(text);
  const found: PersonalPreferenceStatement[] = [];
  const patterns = [
    /\bi\s+(?:(no\s+longer|do\s+not|don't)\s+|(now|currently|also|still)\s+)?prefer\s+(.+?)(?=\s*(?:[,;]?\s+(?:and|but)\s+i\b|[.!?;\n]|$))/giu,
    /我(?:(不再|不)\s*|((?:(?:现在|現在|目前|也|更|比较|比較|仍然)\s*)+))?(?:喜欢|喜歡|偏好)\s*([^，。！？；,\n]+)/gu,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const body = match[3]?.trim();
      if (!body || !/[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(body)) continue;
      const polarity = match[1] ? "withdrawn" : "positive";
      const raw = match[0].trim();
      const value = polarity === "withdrawn" ? raw : body;
      const parsedTarget = target(body);
      const clausePrefix = source.slice(0, match.index!).split(/[.!?;\n]/u).at(-1) ?? "";
      const prefixContext = /^\s*((?:for|in|during|when)\s+[^,;.!?]+),\s*$/iu.exec(clausePrefix)?.[1];
      const context = parsedTarget.context ?? prefixContext ?? null;
      found.push({ value, raw, object: parsedTarget.object, context, polarity,
        explicitUpdate: /\bnow\b|现在|現在/u.test(match[2] ?? ""),
        additive: /\balso\b|也/u.test(match[2] ?? ""),
        start: match.index!, end: match.index! + match[0].length,
        renderedValue: polarity === "positive" && parsedTarget.context === null && prefixContext
          ? `${body} ${prefixContext[0]!.toLowerCase()}${prefixContext.slice(1)}` : value,
      });
    }
  }
  // Explicit operations name their object and optional literal context. They
  // are not permission to infer a synonym, slot, or replacement preference.
  const operations = /\b(?:(I\s+(?:withdraw|retract))\s+my\s+|((?:I\s+)?restore)\s+my\s+(?:original\s+)?)(.+?)\s+preference(?:\s+((?:for|in|during|when)\s+[^.;!?\n]+))?(?=[.;!?\n]|$)/giu;
  for (const match of source.matchAll(operations)) {
    const prefix = source.slice(0, match.index).split(/[.;!?\n]/u).at(-1) ?? "";
    // Operations are direct author commands, not substrings of reporting or
    // denial. An unknown surrounding frame must not grant retirement power.
    if (!/^\s*(?:(?:actually|correction)\s*[:,]\s*|I(?:'ve| have)\s+changed\s+my\s+mind(?:\s+again)?\s*:\s*)?$/iu.test(prefix)) continue;
    const withdrawn = Boolean(match[1]);
    const object = match[3]!.trim();
    const context = match[4]?.trim() ?? null;
    const raw = match[0].trim();
    const value = withdrawn ? raw : `${object}${context ? ` ${context}` : ""}`;
    found.push({ value, raw, object, context, polarity: withdrawn ? "withdrawn" : "positive",
      explicitUpdate: !withdrawn, additive: false, start: match.index!,
      end: match.index! + match[0].length, renderedValue: value });
  }
  found.sort((a, b) => a.start - b.start);
  // A directly adjacent, explicit replacement may supply its literal context
  // to the named withdrawal. Never borrow from another message or guess a slot.
  found.forEach((statement, index) => {
    const next = found[index + 1];
    if (statement.polarity !== "withdrawn" || statement.context !== null ||
      !next || next.polarity !== "positive" || !next.explicitUpdate || next.context === null ||
      !/^[\s.,;!?。，；！？]*(?:(?:and|but|instead|而|但)[\s.,;!?。，；！？]*)?$/iu.test(source.slice(statement.end, next.start))) return;
    statement.context = next.context;
    statement.renderedValue = source.slice(statement.start, next.end).trim();
  });
  return found;
}

export function sourcePreferenceStatement(value: string, userSources: readonly string[]): PersonalPreferenceStatement | null {
  const normalized = normalizePreferenceSurface(value);
  const matches = userSources.flatMap(parsePersonalPreferenceStatements)
    .filter((statement) => normalizePreferenceSurface(statement.value) === normalized ||
      normalizePreferenceSurface(statement.renderedValue) === normalized);
  const identities = new Set(matches.map((statement) => JSON.stringify([
    statement.polarity, normalizePreferenceSurface(statement.object),
    statement.context === null ? null : normalizePreferenceSurface(statement.context),
  ])));
  return identities.size === 1 ? { ...matches.at(-1)!, explicitUpdate: matches.some((statement) => statement.explicitUpdate) } : null;
}

interface StoredPreference { id: string; value: unknown; }
function storedStatement(value: string): Pick<PersonalPreferenceStatement, "object" | "context" | "polarity"> | null {
  const parsed = parsePersonalPreferenceStatements(value);
  if (parsed.length === 1) return parsed[0]!;
  if (parsed.length === 2 && parsed[0]?.polarity === "withdrawn" &&
    normalizePreferenceSurface(parsed[0].renderedValue) === normalizePreferenceSurface(value)) return parsed[0];
  if (parsed.length > 0) return null; // Never retire an opaque compound as one atom.
  return { ...target(value), polarity: "positive" };
}
function sameContext(a: string | null, b: string | null): boolean {
  return a === null || b === null ? a === b : normalizePreferenceSurface(a) === normalizePreferenceSurface(b);
}
function knownResponseDimension(value: string): "format" | "verbosity" | null {
  if (/\b(?:bullet\s+points?|numbered\s+lists?|paragraphs?)\b|要点|要點|项目符号|項目符號|编号列表|編號列表|段落/iu.test(value)) return "format";
  if (/^(?:concise|brief|verbose|detailed)$/iu.test(value) ||
    /\b(?:concise|brief|short|long|verbose|detailed)\s+(?:answers?|responses?|replies|explanations?)\b|(?:简短|簡短|详细|詳細|简洁|簡潔)(?:的)?(?:回答|回复|回覆|解释|解釋)/iu.test(value)) return "verbosity";
  return null;
}

/** Recompute against the latest active snapshot inside the existing category CAS. */
export function preferenceSupersessionIds(
  records: readonly StoredPreference[], statement: PersonalPreferenceStatement | null,
): Set<string> {
  if (!statement) {
    // Category is producer metadata, not a declaration of mutual exclusion.
    // Explicit host corrections can use the target-specific revision API.
    return new Set();
  }
  const parsed = records.flatMap((record) => {
    const parsed = typeof record.value === "string" ? storedStatement(record.value) : null;
    return parsed ? [{ id: record.id, ...parsed }] : [];
  });
  const object = normalizePreferenceSurface(statement.object);
  if (statement.polarity === "withdrawn") {
    const targets = parsed.filter((record) => record.polarity === "positive" &&
      normalizePreferenceSurface(record.object) === object &&
      (statement.context === null || sameContext(record.context, statement.context)));
    return new Set(targets.length === 1 ? [targets[0]!.id] : []);
  }
  const retired = new Set<string>();
  const dimension = knownResponseDimension(statement.object);
  if (dimension && !statement.additive) {
    for (const record of parsed) {
      if (record.polarity === "positive" && sameContext(record.context, statement.context) &&
        knownResponseDimension(record.object) === dimension) retired.add(record.id);
    }
  }

  if (statement.explicitUpdate) {
    const negatives = parsed.filter((record) => record.polarity === "withdrawn" &&
      normalizePreferenceSurface(record.object) === object && sameContext(record.context, statement.context));
    if (negatives.length === 1) retired.add(negatives[0]!.id);
  }
  return retired;
}

/** Exact contradictory assertions for read-only chronology admission, not retirement. */
export function preferenceOppositionIds(
  records: readonly StoredPreference[], statement: PersonalPreferenceStatement | null,
): Set<string> {
  if (!statement) return new Set();
  return new Set(records.flatMap((record) => {
    const stored = typeof record.value === "string" ? storedStatement(record.value) : null;
    return stored && stored.polarity !== statement.polarity &&
      normalizePreferenceSurface(stored.object) === normalizePreferenceSurface(statement.object) &&
      sameContext(stored.context, statement.context) ? [record.id] : [];
  }));
}
