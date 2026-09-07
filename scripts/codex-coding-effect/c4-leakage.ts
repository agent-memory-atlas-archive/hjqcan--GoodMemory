import { createHash } from "node:crypto";

export const C4_LEAKAGE_SURFACE_IDS = [
  "allowed-feedback",
  "effective-codex-input-after-seeding",
  "flat-summary-after-seeding",
  "frozen-prehistory",
  "goodmemory-export-after-seeding",
  "goodmemory-hook-context-after-seeding",
  "repository-instructions",
  "stage-prompts",
  "visible-repository-files",
] as const;

export const C4_HIDDEN_ARTIFACT_IDS = [
  "expected-changed-files",
  "gold-patches",
  "hidden-test-source",
] as const;

export type C4LeakageSurfaceId =
  typeof C4_LEAKAGE_SURFACE_IDS[number];
export type C4HiddenArtifactId =
  typeof C4_HIDDEN_ARTIFACT_IDS[number];

export interface C4LeakageSurface {
  content: string;
  fragmentContents?: readonly string[];
  hiddenValueContent?: string;
  hiddenValueContents?: readonly string[];
  id: C4LeakageSurfaceId;
}

export interface C4HiddenArtifact {
  allowedPublicFragments?: readonly string[];
  content: string;
  fragments: readonly string[];
  hiddenValueRelations?: readonly (readonly C4HiddenValue[])[];
  hiddenValues?: readonly C4HiddenValue[];
  id: C4HiddenArtifactId;
}

export type C4HiddenValue = string | number | boolean | null;

export interface C4LeakageMatrixCell {
  artifactId: C4HiddenArtifactId;
  artifactSha256: string;
  allowedPublicContractCount: number;
  allowedPublicFragmentSha256: string[];
  candidateFragmentCount: number;
  candidateFragmentSetSha256: string;
  exactOverlapCount: number;
  hiddenValueCount: number;
  hiddenValueRelationCount: number;
  hiddenValueRelationSetSha256: string;
  hiddenValueSetSha256: string;
  hiddenValueSurfaceSha256: string;
  matchedFragmentSha256: string[];
  normalizedOverlapCount: number;
  status: "accepted" | "rejected";
  surfaceId: C4LeakageSurfaceId;
  surfaceSha256: string;
}

export interface C4LeakageMatrixAudit {
  artifactIds: readonly C4HiddenArtifactId[];
  auditSha256: string;
  candidateBindingVersion: 1;
  candidateExtractionVersion:
    "semantic-documents-exact-relations-corpus-wide-v9";
  cells: C4LeakageMatrixCell[];
  normalizationVersion: "nfkc-lowercase-whitespace-numeric-equivalence-v4";
  overlapCount: number;
  schemaVersion: 1;
  status: "accepted" | "rejected";
  surfaceIds: readonly C4LeakageSurfaceId[];
}

export interface C4LeakageMutationCell {
  applicability: "applicable" | "not-applicable-no-secret-candidate";
  artifactId: C4HiddenArtifactId;
  candidateKind: "fragment" | "hidden-value" | "hidden-value-relation";
  injectedCandidateSha256: string | null;
  surfaceId: C4LeakageSurfaceId;
  targetCellRejected: boolean | null;
}

export interface C4LeakageMutationAudit {
  applicableCellCount: number;
  auditSha256: string;
  cells: C4LeakageMutationCell[];
  matrixCellCount: number;
  mutationCellCount: number;
  notApplicableCellCount: number;
  schemaVersion: 1;
  status: "accepted";
}

export function auditC4SurfaceHiddenArtifactMatrix(input: {
  artifacts: readonly C4HiddenArtifact[];
  surfaces: readonly C4LeakageSurface[];
}): C4LeakageMatrixAudit {
  assertExactIds(
    input.surfaces.map((surface) => surface.id),
    C4_LEAKAGE_SURFACE_IDS,
    "surface",
  );
  assertExactIds(
    input.artifacts.map((artifact) => artifact.id),
    C4_HIDDEN_ARTIFACT_IDS,
    "hidden artifact",
  );

  const cells = [...input.surfaces]
    .sort((first, second) => first.id.localeCompare(second.id))
    .flatMap((surface) =>
      [...input.artifacts]
        .sort((first, second) => first.id.localeCompare(second.id))
        .map((artifact) => auditCell(surface, artifact))
    );
  const overlapCount = cells.reduce(
    (total, cell) =>
      total + cell.exactOverlapCount + cell.normalizedOverlapCount,
    0,
  );
  const basis = {
    artifactIds: [...C4_HIDDEN_ARTIFACT_IDS],
    candidateBindingVersion: 1,
    candidateExtractionVersion:
      "semantic-documents-exact-relations-corpus-wide-v9",
    cells,
    normalizationVersion: "nfkc-lowercase-whitespace-numeric-equivalence-v4",
    overlapCount,
    schemaVersion: 1,
    status: overlapCount === 0 ? "accepted" : "rejected",
    surfaceIds: [...C4_LEAKAGE_SURFACE_IDS],
  } as const;
  return {
    ...basis,
    auditSha256: sha256(JSON.stringify(basis)),
  };
}

export function mutationTestC4SurfaceHiddenArtifactMatrix(input: {
  artifacts: readonly C4HiddenArtifact[];
  surfaces: readonly C4LeakageSurface[];
}): C4LeakageMutationAudit {
  const clean = auditC4SurfaceHiddenArtifactMatrix(input);
  if (clean.status !== "accepted") {
    throw new Error("C4 leakage mutation test requires a clean matrix");
  }
  const artifacts = new Map(input.artifacts.map((artifact) => [
    artifact.id,
    artifact,
  ]));
  const cells = clean.cells.flatMap((cell) => {
    const artifact = artifacts.get(cell.artifactId);
    if (artifact === undefined) {
      throw new Error(`missing C4 hidden artifact ${cell.artifactId}`);
    }
    // An empty string renders to nothing and can never match a surface, so
    // the injected candidate must be the first one with matchable text.
    return ([
      ["fragment", artifact.fragments.find((fragment) => fragment.length > 0)],
      [
        "hidden-value",
        artifact.hiddenValues?.find((value) =>
          renderHiddenValue(value).length > 0
        ),
      ],
      [
        "hidden-value-relation",
        artifact.hiddenValueRelations?.find((relation) =>
          relation.every((value) => renderHiddenValue(value).length > 0)
        ),
      ],
    ] as const).map(([candidateKind, candidate]): C4LeakageMutationCell => {
      if (candidate === undefined) {
        return {
          applicability: "not-applicable-no-secret-candidate",
          artifactId: cell.artifactId,
          candidateKind,
          injectedCandidateSha256: null,
          surfaceId: cell.surfaceId,
          targetCellRejected: null,
        };
      }
      const injection = candidateKind === "fragment"
        ? candidate
        : candidateKind === "hidden-value"
        ? renderHiddenValue(candidate)
        : candidate.map(renderHiddenValue).join(" | ");
      const mutated = input.surfaces.map((surface) => {
        if (surface.id !== cell.surfaceId) {
          return surface;
        }
        if (candidateKind === "fragment") {
          return {
            ...surface,
            content: `${surface.content}\n${injection}\n`,
            ...(surface.fragmentContents
              ? {
                  fragmentContents: [
                    ...surface.fragmentContents,
                    injection,
                  ],
                }
              : {}),
          };
        }
        const { hiddenValueContent: _, hiddenValueContents: __, ...basis } =
          surface;
        return {
          ...basis,
          hiddenValueContents: [
            ...semanticHiddenValueSurfaces(surface),
            injection,
          ],
        };
      });
      const mutation = auditC4SurfaceHiddenArtifactMatrix({
        artifacts: input.artifacts,
        surfaces: mutated,
      });
      const target = mutation.cells.find((candidateCell) =>
        candidateCell.surfaceId === cell.surfaceId &&
        candidateCell.artifactId === cell.artifactId
      );
      if (target?.status !== "rejected") {
        throw new Error(
          `C4 leakage mutation escaped at ${cell.surfaceId}/${cell.artifactId}/${candidateKind}`,
        );
      }
      return {
        applicability: "applicable",
        artifactId: cell.artifactId,
        candidateKind,
        injectedCandidateSha256: sha256(JSON.stringify({
          candidate,
          candidateKind,
        })),
        surfaceId: cell.surfaceId,
        targetCellRejected: true,
      };
    });
  });
  const applicableCellCount = cells.filter((cell) =>
    cell.applicability === "applicable"
  ).length;
  const basis = {
    applicableCellCount,
    cells,
    matrixCellCount: clean.cells.length,
    mutationCellCount: cells.length,
    notApplicableCellCount: cells.length - applicableCellCount,
    schemaVersion: 1,
    status: "accepted",
  } as const;
  return {
    ...basis,
    auditSha256: sha256(JSON.stringify(basis)),
  };
}

function auditCell(
  surface: C4LeakageSurface,
  artifact: C4HiddenArtifact,
): C4LeakageMatrixCell {
  const fragmentSurfaces = surface.fragmentContents ?? [surface.content];
  const normalizedSurfaces = fragmentSurfaces.map(normalizeLeakageText);
  const hiddenValueSurfaces = semanticHiddenValueSurfaces(surface);
  const fragments = [...new Set([
    artifact.content,
    ...artifact.fragments,
  ].filter((fragment) => fragment.length > 0))].sort();
  const hiddenValues = canonicalHiddenValues(artifact.hiddenValues ?? []);
  const hiddenValueRelations = canonicalHiddenValueRelations(
    artifact.hiddenValueRelations ?? [],
  );
  const exact = new Set<string>();
  const normalized = new Set<string>();
  const allowedPublic = new Set<string>();
  for (const fragment of artifact.allowedPublicFragments ?? []) {
    if (
      fragmentSurfaces.some((candidate) => candidate.includes(fragment)) ||
      normalizedSurfaces.some((candidate) =>
        candidate.includes(normalizeLeakageText(fragment))
      )
    ) {
      allowedPublic.add(sha256(fragment));
    }
  }
  for (const fragment of fragments) {
    const fragmentSha256 = sha256(fragment);
    if (fragmentSurfaces.some((candidate) => candidate.includes(fragment))) {
      exact.add(fragmentSha256);
      continue;
    }
    const normalizedFragment = normalizeLeakageText(fragment);
    if (
      normalizedFragment.length > 0 &&
      normalizedSurfaces.some((candidate) => candidate.includes(normalizedFragment))
    ) {
      normalized.add(fragmentSha256);
    }
  }
  for (const value of hiddenValues) {
    const match = matchHiddenValueInSurfaces(hiddenValueSurfaces, value);
    if (match === null) {
      continue;
    }
    const valueSha256 = sha256(JSON.stringify({
      type: value === null ? "null" : typeof value,
      value,
    }));
    (match === "exact" ? exact : normalized).add(valueSha256);
  }
  for (const relation of hiddenValueRelations) {
    const match = matchHiddenValueRelationInSurfaces(
      hiddenValueSurfaces,
      relation,
    );
    if (match === null) {
      continue;
    }
    const relationSha256 = sha256(JSON.stringify({
      type: "relation",
      values: relation.map(canonicalHiddenValue),
    }));
    (match === "exact" ? exact : normalized).add(relationSha256);
  }
  const matchedFragmentSha256 = [...exact, ...normalized].sort();
  return {
    artifactId: artifact.id,
    artifactSha256: sha256(artifact.content),
    allowedPublicContractCount: allowedPublic.size,
    allowedPublicFragmentSha256: [...allowedPublic].sort(),
    candidateFragmentCount: fragments.length,
    candidateFragmentSetSha256: sha256(JSON.stringify(fragments)),
    exactOverlapCount: exact.size,
    hiddenValueCount: hiddenValues.length,
    hiddenValueRelationCount: hiddenValueRelations.length,
    hiddenValueRelationSetSha256: sha256(JSON.stringify(
      hiddenValueRelations.map((relation) =>
        relation.map(canonicalHiddenValue)
      ),
    )),
    hiddenValueSetSha256: sha256(JSON.stringify(hiddenValues.map(
      canonicalHiddenValue,
    ))),
    hiddenValueSurfaceSha256: sha256(JSON.stringify(hiddenValueSurfaces)),
    matchedFragmentSha256,
    normalizedOverlapCount: normalized.size,
    status: matchedFragmentSha256.length === 0 ? "accepted" : "rejected",
    surfaceId: surface.id,
    surfaceSha256: sha256(surface.content),
  };
}

function canonicalHiddenValues(
  values: readonly C4HiddenValue[],
): C4HiddenValue[] {
  return [...new Map(values.map((value) => [
    JSON.stringify(canonicalHiddenValue(value)),
    value,
  ])).entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => value);
}

function canonicalHiddenValueRelations(
  relations: readonly (readonly C4HiddenValue[])[],
): C4HiddenValue[][] {
  const canonical = new Map<string, C4HiddenValue[]>();
  for (const relation of relations) {
    if (relation.length < 2) {
      continue;
    }
    const values = [...relation];
    const key = JSON.stringify(values.map(canonicalHiddenValue));
    canonical.set(key, values);
  }
  return [...canonical.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, relation]) => relation);
}

function canonicalHiddenValue(value: C4HiddenValue): {
  type: "boolean" | "null" | "number" | "string";
  value: C4HiddenValue;
} {
  const type = value === null
    ? "null"
    : typeof value === "boolean"
    ? "boolean"
    : typeof value === "number"
    ? "number"
    : "string";
  return {
    type,
    value,
  };
}

export function c4HiddenValueAppearsInSurface(
  surface: string,
  value: C4HiddenValue,
): boolean {
  return matchHiddenValue(surface, value) !== null;
}

export function c4HiddenValueAppearsInSurfaces(
  surfaces: readonly string[],
  value: C4HiddenValue,
): boolean {
  return matchHiddenValueInSurfaces(surfaces, value) !== null;
}

export function c4HiddenValueRelationAppearsInSurface(
  surface: string,
  relation: readonly C4HiddenValue[],
): boolean {
  return matchHiddenValueRelation(surface, relation) !== null;
}

export function c4HiddenValueRelationAppearsInSurfaces(
  surfaces: readonly string[],
  relation: readonly C4HiddenValue[],
): boolean {
  return matchHiddenValueRelationInSurfaces(
    surfaces,
    relation,
  ) !== null;
}

interface HiddenValueMatch {
  end: number;
  surfaceIndex?: number;
  start: number;
}

function matchHiddenValue(
  surface: string,
  value: C4HiddenValue,
): "exact" | "normalized" | null {
  if (exactHiddenValueMatches(surface, value).length > 0) {
    return "exact";
  }
  return normalizedHiddenValueMatches(surface, value).length > 0
    ? "normalized"
    : null;
}

function matchHiddenValueInSurfaces(
  surfaces: readonly string[],
  value: C4HiddenValue,
): "exact" | "normalized" | null {
  let normalized = false;
  for (const surface of surfaces) {
    const match = matchHiddenValue(surface, value);
    if (match === "exact") {
      return "exact";
    }
    normalized ||= match === "normalized";
  }
  return normalized ? "normalized" : null;
}

function matchHiddenValueRelation(
  surface: string,
  relation: readonly C4HiddenValue[],
): "exact" | "normalized" | null {
  if (hasDistinctMatches(
    relation.map((value) => exactHiddenValueMatches(surface, value)),
  )) {
    return "exact";
  }
  if (!relation.some((value) => typeof value === "number")) {
    return null;
  }
  return hasDistinctMatches(
      relation.map((value) =>
        typeof value === "number"
          ? normalizedHiddenValueMatches(surface, value)
          : exactHiddenValueMatches(surface, value)
      ),
    )
    ? "normalized"
    : null;
}

function matchHiddenValueRelationInSurfaces(
  surfaces: readonly string[],
  relation: readonly C4HiddenValue[],
): "exact" | "normalized" | null {
  const matchesAcrossSurfaces = (
    value: C4HiddenValue,
    normalized: boolean,
  ): HiddenValueMatch[] => surfaces.flatMap((surface, surfaceIndex) =>
    (normalized
      ? normalizedHiddenValueMatches(surface, value)
      : exactHiddenValueMatches(surface, value)
    ).map((match) => ({ ...match, surfaceIndex }))
  );
  if (hasDistinctMatches(
    relation.map((value) => matchesAcrossSurfaces(value, false)),
  )) {
    return "exact";
  }
  if (!relation.some((value) => typeof value === "number")) {
    return null;
  }
  return hasDistinctMatches(
      relation.map((value) =>
        matchesAcrossSurfaces(value, typeof value === "number")
      ),
    )
    ? "normalized"
    : null;
}

function exactHiddenValueMatches(
  surface: string,
  value: C4HiddenValue,
): HiddenValueMatch[] {
  return delimitedMatches(surface, value === null ? "null" : String(value));
}

function normalizedHiddenValueMatches(
  surface: string,
  value: C4HiddenValue,
): HiddenValueMatch[] {
  const normalizedSurface = normalizeLeakageText(surface);
  const fragment = normalizeLeakageText(
    value === null ? "null" : String(value),
  );
  const matches = delimitedMatches(normalizedSurface, fragment);
  if (typeof value === "number") {
    matches.push(...equivalentNumberMatches(normalizedSurface, value));
  }
  return [...new Map(matches.map((match) => [
    `${match.start}:${match.end}`,
    match,
  ])).values()];
}

function equivalentNumberMatches(
  surface: string,
  value: number,
): HiddenValueMatch[] {
  const matches: HiddenValueMatch[] = [];
  for (const match of surface.matchAll(
    /(?<![\p{L}\p{N}_])[-+]?(?:(?:\d{1,3}(?:,\d{3})+)|(?:\d(?:[\d_]*\d)?))(?:\.(?:\d(?:[\d_]*\d)?))?(?:[eE][-+]?\d(?:[\d_]*\d)?)?(?![\p{L}\p{N}_])/gu,
  )) {
    const candidate = Number(match[0].replaceAll(",", "").replaceAll("_", ""));
    if (
      Number.isFinite(candidate) &&
      candidate === value &&
      match.index !== undefined
    ) {
      matches.push({
        end: match.index + match[0].length,
        start: match.index,
      });
    }
  }
  return matches;
}

function renderHiddenValue(value: C4HiddenValue): string {
  return value === null ? "null" : String(value);
}

function delimitedMatches(
  surface: string,
  fragment: string,
): HiddenValueMatch[] {
  if (fragment.length === 0) {
    return [];
  }
  const matches: HiddenValueMatch[] = [];
  let offset = surface.indexOf(fragment);
  while (offset >= 0) {
    const before = offset === 0 ? undefined : surface[offset - 1];
    const afterIndex = offset + fragment.length;
    const after = afterIndex === surface.length
      ? undefined
      : surface[afterIndex];
    if (
      boundaryAllows(fragment[0], before) &&
      boundaryAllows(fragment[fragment.length - 1], after)
    ) {
      matches.push({ end: afterIndex, start: offset });
    }
    offset = surface.indexOf(fragment, offset + 1);
  }
  return matches;
}

function hasDistinctMatches(
  groups: readonly (readonly HiddenValueMatch[])[],
): boolean {
  if (groups.length === 0 || groups.some((group) => group.length === 0)) {
    return false;
  }
  const ordered = [...groups].sort((left, right) => left.length - right.length);
  const selected: HiddenValueMatch[] = [];
  const assign = (index: number): boolean => {
    if (index === ordered.length) {
      return true;
    }
    for (const candidate of ordered[index]!) {
      if (selected.some((match) =>
        (candidate.surfaceIndex ?? 0) === (match.surfaceIndex ?? 0) &&
        candidate.start < match.end && match.start < candidate.end
      )) {
        continue;
      }
      selected.push(candidate);
      if (assign(index + 1)) {
        return true;
      }
      selected.pop();
    }
    return false;
  };
  return assign(0);
}

function semanticHiddenValueSurfaces(
  surface: C4LeakageSurface,
): readonly string[] {
  if (
    surface.hiddenValueContent !== undefined &&
    surface.hiddenValueContents !== undefined
  ) {
    throw new Error("C4 leakage surface has conflicting hidden-value content");
  }
  return surface.hiddenValueContents ?? [
    surface.hiddenValueContent ?? surface.content,
  ];
}

function boundaryAllows(
  fragmentEdge: string | undefined,
  neighboringSurfaceCharacter: string | undefined,
): boolean {
  return fragmentEdge === undefined ||
    neighboringSurfaceCharacter === undefined ||
    !isTokenCharacter(fragmentEdge) ||
    !isTokenCharacter(neighboringSurfaceCharacter);
}

function isTokenCharacter(value: string): boolean {
  return /[\p{L}\p{N}_]/u.test(value);
}

function assertExactIds<T extends string>(
  actual: readonly T[],
  expected: readonly T[],
  label: string,
): void {
  const sortedActual = [...actual].sort();
  const sortedExpected = [...expected].sort();
  if (
    new Set(actual).size !== actual.length ||
    JSON.stringify(sortedActual) !== JSON.stringify(sortedExpected)
  ) {
    throw new Error(`C4 leakage matrix requires every ${label} exactly once`);
  }
}

function normalizeLeakageText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(
    /\s+/gu,
    " ",
  ).trim();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
