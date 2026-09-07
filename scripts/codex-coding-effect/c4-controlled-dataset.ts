import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import { z } from "zod";
import { controlledRepositoryIdForUrl } from "./controlled-dataset-profile";

import {
  parseCodexCodingEffectDataset,
} from "./dataset";
import type {
  CodexCodingEffectDatasetV2,
} from "./dataset";
import { validateC4ControlledPilotDataset } from "./c4-contracts";
import {
  c4HiddenValueAppearsInSurfaces,
  c4HiddenValueRelationAppearsInSurfaces,
} from "./c4-leakage";
import { runBoundaryProcess } from "./process";

const DATASET_ID = "codex-c4-controlled-pilot-v2";
const FIXED_GIT_DATE = "2026-07-15T18:00:00+00:00";
const OWNERSHIP_MARKER = ".goodmemory-c4-controlled-dataset-owned";
const DATASET_AUTHOR = "GoodMemory C4 dataset author";
const DATASET_AUTHOR_TASK_NAME = "/root";
const PROMPT_TITLE = "TypeScript utility task";
const MIT_LICENSE = [
  "MIT License",
  "",
  "Copyright (c) 2026 GoodMemory contributors",
  "",
  "Permission is hereby granted, free of charge, to any person obtaining a copy",
  "of this software and associated documentation files (the \"Software\"), to deal",
  "in the Software without restriction, including without limitation the rights",
  "to use, copy, modify, merge, publish, distribute, sublicense, and/or sell",
  "copies of the Software, and to permit persons to whom the Software is",
  "furnished to do so, subject to the following conditions:",
  "",
  "The above copyright notice and this permission notice shall be included in all",
  "copies or substantial portions of the Software.",
  "",
  "THE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR",
  "IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,",
  "FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE",
  "AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER",
  "LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,",
  "OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE",
  "SOFTWARE.",
  "",
].join("\n");

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const assetFileSchema = z.object({
  bytes: z.number().int().nonnegative(),
  kind: z.enum([
    "author-attestation",
    "dataset-license",
    "evaluator",
    "gold-patch",
    "license-receipt",
    "manifest",
    "prehistory",
    "prompt",
    "repository-provenance",
    "repository-source",
  ]),
  path: z.string().min(1),
  sha256: sha256Schema,
}).strict();
const assetLockSchema = z.object({
  assetRootSha256: sha256Schema,
  files: z.array(assetFileSchema).min(1),
  schemaVersion: z.literal(1),
}).strict();

export type C4AssetFile = z.infer<typeof assetFileSchema>;
export type C4AssetLock = z.infer<typeof assetLockSchema>;

export interface C4ControlledPilotDatasetFixture {
  assetLock: C4AssetLock;
  assetLockSha256: string;
  dataset: CodexCodingEffectDatasetV2;
  root: string;
}

interface JsonCase {
  args: unknown[];
  expected: unknown;
}

interface TaskSpec {
  allowedFeedback: string;
  baseImplementation: string;
  failToPass: readonly JsonCase[];
  forbiddenStrings: readonly string[];
  functionName: string;
  goldImplementation: string;
  id: string;
  passToPass: readonly JsonCase[];
  prompt: string;
  visible: readonly JsonCase[];
}

interface EpisodeSpec {
  history: readonly { role: "assistant" | "user"; text: string }[];
  id: string;
  memoryMode: "irrelevant-control" | "required";
  repositoryId: RepositorySpec["id"];
  stages: readonly [TaskSpec, TaskSpec, TaskSpec];
  strata: readonly MemoryStratum[];
}

interface RepositorySpec {
  id: "continuity-utils" | "policy-utils";
  preamble: string;
  supportFiles?: readonly { content: string; path: string }[];
  title: string;
  url: string;
}

// Fixture directory names are registered per dataset profile; the C4 table
// below keeps the synthetic repository contents.
export type C4ControlledRepositoryId = string;

type MemoryStratum = CodexCodingEffectDatasetV2["episodes"][number]["strata"][number];

const REPOSITORIES: readonly RepositorySpec[] = [
  {
    id: "continuity-utils",
    preamble: "",
    title: "Continuity Utils",
    url: "https://example.invalid/goodmemory-c4/continuity-utils.git",
  },
  {
    id: "policy-utils",
    preamble: [
      'import { acceptUnchecked } from "./parse-result";',
      'import { SETTING_ERROR_CODES } from "./errors";',
      'import type { ParseResult } from "./parse-result";',
      'import type { LogLevel, OutputFormat, TransportMode } from "./setting-types";',
      'export { SETTING_ERROR_CODES } from "./errors";',
      'export type { ParseResult } from "./parse-result";',
      'export type { LogLevel, OutputFormat, TransportMode } from "./setting-types";',
      "",
    ].join("\n"),
    supportFiles: [
      {
        content: [
          "export const SETTING_ERROR_CODES = {",
          '  format: "invalid-format",',
          '  level: "invalid-level",',
          '  mode: "invalid-mode",',
          "} as const;",
          "",
        ].join("\n"),
        path: "src/errors.ts",
      },
      {
        content: [
          "export type ParseResult<T> =",
          "  | { ok: true; value: T }",
          "  | { error: string; ok: false };",
          "",
          "export function acceptUnchecked<T>(value: T): ParseResult<T> {",
          "  return { ok: true, value };",
          "}",
          "",
        ].join("\n"),
        path: "src/parse-result.ts",
      },
      {
        content: [
          'export type LogLevel = "debug" | "info" | "notice" | "warn";',
          "",
          'export type OutputFormat = "json" | "text" | "yaml";',
          "",
          'export type TransportMode = "buffered" | "direct" | "relay";',
          "",
        ].join("\n"),
        path: "src/setting-types.ts",
      },
    ],
    title: "Policy Utils",
    url: "https://example.invalid/goodmemory-c4/policy-utils.git",
  },
] as const;

const EPISODES: readonly EpisodeSpec[] = [
  {
    history: [
      {
        role: "user",
        text: "The endpoint display utilities need one project-specific presentation rule. Establish it in the first task, then apply the accepted rule to the remaining display functions without changing exported signatures.",
      },
      {
        role: "assistant",
        text: "Recorded that the first endpoint task will establish the local presentation policy for the later display functions.",
      },
    ],
    id: "endpoint-open-loop",
    memoryMode: "required",
    repositoryId: "continuity-utils",
    stages: [
      task({
        allowedFeedback: "Use the endpoint-display rule stated in this task.",
        baseImplementation: [
          "export function renderHostDisplay(host: string): string {",
          "  return host;",
          "}",
        ],
        failToPass: [
          { args: ["2001:db8::1"], expected: "(2001:db8::1)" },
          { args: ["::1"], expected: "(::1)" },
          { args: ["fe80::1%en0"], expected: "(fe80::1%en0)" },
        ],
        forbiddenStrings: [
          'host.includes(":") && !(host.startsWith("(") && host.endsWith(")"))',
        ],
        functionName: "renderHostDisplay",
        goldImplementation: [
          "export function renderHostDisplay(host: string): string {",
          '  return host.includes(":") && !(host.startsWith("(") && host.endsWith(")"))',
          "    ? `(${host})`",
          "    : host;",
          "}",
        ],
        id: "render-host-display",
        passToPass: [
          { args: ["api.internal"], expected: "api.internal" },
          { args: ["(2001:db8::4)"], expected: "(2001:db8::4)" },
        ],
        prompt: "Establish and implement the endpoint-display policy for this repository. Project policy: for endpoint display text, wrap a host containing a colon in one pair of parentheses unless it already begins with an opening parenthesis and ends with a closing parenthesis; leave other hosts unchanged. Keep the exported signature stable.",
        visible: [{ args: ["localhost"], expected: "localhost" }],
      }),
      task({
        allowedFeedback: "Use the accepted endpoint-display policy.",
        baseImplementation: [
          "export function renderEndpointDisplay(host: string, port: number): string {",
          "  return `${host}:${port}`;",
          "}",
        ],
        failToPass: [
          { args: ["2001:db8::1", 443], expected: "(2001:db8::1):443" },
          { args: ["::1", 8080], expected: "(::1):8080" },
          { args: ["fe80::2%en0", 3000], expected: "(fe80::2%en0):3000" },
        ],
        forbiddenStrings: [
          'host.includes(":") && !(host.startsWith("(") && host.endsWith(")"))',
        ],
        functionName: "renderEndpointDisplay",
        goldImplementation: [
          "export function renderEndpointDisplay(host: string, port: number): string {",
          '  const renderedHost = host.includes(":") && !(host.startsWith("(") && host.endsWith(")"))',
          "    ? `(${host})`",
          "    : host;",
          "  return `${renderedHost}:${port}`;",
          "}",
        ],
        id: "render-endpoint-display",
        passToPass: [
          { args: ["api.internal", 443], expected: "api.internal:443" },
          { args: ["(2001:db8::3)", 8443], expected: "(2001:db8::3):8443" },
        ],
        prompt: "Apply the accepted endpoint-display policy to renderEndpointDisplay. Keep the exported signature unchanged.",
        visible: [{
          args: ["localhost", 3000],
          expected: "localhost:3000",
        }],
      }),
      task({
        allowedFeedback: "Use the accepted endpoint-display policy.",
        baseImplementation: [
          "export function renderTargetDisplay(target: string, host: string, port: number): string {",
          "  return `${target} ${host}:${port}`;",
          "}",
        ],
        failToPass: [
          {
            args: ["primary", "2001:db8::9", 443],
            expected: "primary (2001:db8::9):443",
          },
          {
            args: ["local", "::1", 8080],
            expected: "local (::1):8080",
          },
          {
            args: ["backup", "fe80::7%en0", 9000],
            expected: "backup (fe80::7%en0):9000",
          },
        ],
        forbiddenStrings: [
          'host.includes(":") && !(host.startsWith("(") && host.endsWith(")"))',
        ],
        functionName: "renderTargetDisplay",
        goldImplementation: [
          "export function renderTargetDisplay(target: string, host: string, port: number): string {",
          '  const renderedHost = host.includes(":") && !(host.startsWith("(") && host.endsWith(")"))',
          "    ? `(${host})`",
          "    : host;",
          "  return `${target} ${renderedHost}:${port}`;",
          "}",
        ],
        id: "render-target-display",
        passToPass: [
          {
            args: ["primary", "proxy.internal", 443],
            expected: "primary proxy.internal:443",
          },
          {
            args: ["backup", "(2001:db8::8)", 80],
            expected: "backup (2001:db8::8):80",
          },
        ],
        prompt: "Apply the accepted endpoint-display policy to renderTargetDisplay. Keep the exported signature unchanged.",
        visible: [{
          args: ["local", "localhost", 3000],
          expected: "local localhost:3000",
        }],
      }),
    ],
    strata: ["open-loop-handoff", "no-history-negative-control"],
  },
  {
    history: [
      {
        role: "user",
        text: "The related pair parsers need one repository-level boundary policy. Establish it in the first task and apply the accepted policy to the follow-up parsers.",
      },
      {
        role: "assistant",
        text: "Recorded that the first parser task will define the local delimiter rule for the remaining stages.",
      },
    ],
    id: "delimiter-boundary-policy",
    memoryMode: "required",
    repositoryId: "continuity-utils",
    stages: [
      delimiterTask({
        delimiter: "=",
        establishPolicy: true,
        functionName: "splitAssignment",
        noun: "assignment",
      }),
      delimiterTask({
        delimiter: ":",
        establishPolicy: false,
        functionName: "splitHeader",
        noun: "header",
      }),
      delimiterTask({
        delimiter: "->",
        establishPolicy: false,
        functionName: "splitRoute",
        noun: "route",
      }),
    ],
    strata: ["validated-approach"],
  },
  {
    history: [
      {
        role: "user",
        text: "We tried treating every separator as a field boundary, and it corrupted embedded field content. Do not repeat that failed approach. Establish the replacement project policy in the first task, then reuse it in the remaining parsers.",
      },
      {
        role: "assistant",
        text: "Recorded the unconditional-split failure and that the first parser must establish the replacement field-boundary policy for later stages.",
      },
    ],
    id: "field-boundary-policy",
    memoryMode: "required",
    repositoryId: "continuity-utils",
    stages: [
      task({
        allowedFeedback: "Use the field-boundary rule stated in this task.",
        baseImplementation: [
          "export function parseCsvFields(input: string): string[] {",
          '  return input.split(",").map((field) => field.trim());',
          "}",
        ],
        failToPass: [
          {
            args: ['alpha,"beta,gamma",delta'],
            expected: ["alpha", "beta,gamma", "delta"],
          },
          {
            args: ['alpha,"say ""hello""",omega'],
            expected: ["alpha", 'say "hello"', "omega"],
          },
          {
            args: ['"a,b","c,d"'],
            expected: ["a,b", "c,d"],
          },
        ],
        forbiddenStrings: ["const fields: string[] = [];"],
        functionName: "parseCsvFields",
        goldImplementation: csvFieldsImplementation(),
        id: "parse-csv-fields",
        passToPass: [
          { args: ["alpha,beta"], expected: ["alpha", "beta"] },
          {
            args: ["'north,south',east"],
            expected: ["'north", "south'", "east"],
          },
        ],
        prompt: "Establish and implement the field-boundary policy for this repository. Project policy: only double quotes protect a delimiter; grouping double quotes are removed; two consecutive double quotes inside a protected field produce one literal double quote; single quotes are ordinary characters. Preserve the existing return shape.",
        visible: [{ args: ["a, b"], expected: ["a", "b"] }],
      }),
      task({
        allowedFeedback: "Use the accepted field-boundary policy.",
        baseImplementation: [
          "export function parsePipeFields(input: string): string[] {",
          '  return input.split("|").map((field) => field.trim());',
          "}",
        ],
        failToPass: [
          {
            args: ['alpha|"beta|gamma"|delta'],
            expected: ["alpha", "beta|gamma", "delta"],
          },
          {
            args: ['alpha|"say ""hello"""|omega'],
            expected: ["alpha", 'say "hello"', "omega"],
          },
          {
            args: ['"a|b"|"c|d"'],
            expected: ["a|b", "c|d"],
          },
        ],
        forbiddenStrings: ["const fields: string[] = [];"],
        functionName: "parsePipeFields",
        goldImplementation: pipeFieldsImplementation(),
        id: "parse-pipe-fields",
        passToPass: [
          { args: ["alpha|beta"], expected: ["alpha", "beta"] },
          {
            args: ["'north|middle'|south"],
            expected: ["'north", "middle'", "south"],
          },
        ],
        prompt: "Apply the accepted field-boundary policy to parsePipeFields. Keep the exported signature unchanged.",
        visible: [{ args: ["west|east"], expected: ["west", "east"] }],
      }),
      task({
        allowedFeedback: "Use the accepted field-boundary policy.",
        baseImplementation: [
          "export function parseSemicolonFields(input: string): string[] {",
          '  return input.split(";").map((field) => field.trim());',
          "}",
        ],
        failToPass: [
          {
            args: ['alpha;"beta;gamma";delta'],
            expected: ["alpha", "beta;gamma", "delta"],
          },
          {
            args: ['alpha;"say ""hello""";omega'],
            expected: ["alpha", 'say "hello"', "omega"],
          },
          {
            args: ['"a;b";"c;d"'],
            expected: ["a;b", "c;d"],
          },
        ],
        forbiddenStrings: ["const fields: string[] = [];"],
        functionName: "parseSemicolonFields",
        goldImplementation: semicolonFieldsImplementation(),
        id: "parse-semicolon-fields",
        passToPass: [
          { args: ["alpha;beta"], expected: ["alpha", "beta"] },
          {
            args: ["'north;middle';south"],
            expected: ["'north", "middle'", "south"],
          },
        ],
        prompt: "Apply the accepted field-boundary policy to parseSemicolonFields. Keep the exported signature unchanged.",
        visible: [{ args: ["west;east"], expected: ["west", "east"] }],
      }),
    ],
    strata: ["failure-avoidance"],
  },
  {
    history: [
      {
        role: "user",
        text: "I reject the current setting-parser behavior that broadly trims whitespace, folds case, or trusts unchecked casts. The first task will define the corrected input policy; later parsers must follow that correction.",
      },
      {
        role: "assistant",
        text: "Recorded the rejected normalization and cast behavior, and that the first setting task will establish the corrected input policy for later stages.",
      },
    ],
    id: "parse-result-correction",
    memoryMode: "required",
    repositoryId: "policy-utils",
    stages: [
      task({
        allowedFeedback: "Use the setting-input rule stated in this task.",
        baseImplementation: [
          "export function parseModeSetting(input: string): ParseResult<TransportMode> {",
          "  return acceptUnchecked(input as TransportMode);",
          "}",
        ],
        failToPass: [
          {
            args: [" direct "],
            expected: { ok: true, value: "direct" },
          },
          {
            args: ["DIRECT"],
            expected: { error: "invalid-mode", ok: false },
          },
          {
            args: ["\tdirect\t"],
            expected: { error: "invalid-mode", ok: false },
          },
          {
            args: ["turbo"],
            expected: { error: "invalid-mode", ok: false },
          },
        ],
        forbiddenStrings: [
          'input.replace(/^ +| +$/gu, "")',
          "return { error: SETTING_ERROR_CODES.mode, ok: false };",
        ],
        functionName: "parseModeSetting",
        goldImplementation: [
          "export function parseModeSetting(input: string): ParseResult<TransportMode> {",
          '  const normalized = input.replace(/^ +| +$/gu, "");',
          '  if (normalized === "buffered" || normalized === "direct" || normalized === "relay") {',
          "    return { ok: true, value: normalized };",
          "  }",
          "  return { error: SETTING_ERROR_CODES.mode, ok: false };",
          "}",
        ],
        id: "parse-mode-setting",
        passToPass: [
          { args: ["direct"], expected: { ok: true, value: "direct" } },
          { args: ["relay"], expected: { ok: true, value: "relay" } },
        ],
        prompt: "Establish and implement the setting-input policy for this repository. Project policy: remove only leading and trailing U+0020 SPACE characters; tabs and other whitespace remain part of the input; preserve letter case; after normalization accept only exact values declared by the function's TypeScript union; return ParseResult with the matching shared error code for every other value.",
        visible: [{
          args: ["buffered"],
          expected: { ok: true, value: "buffered" },
        }],
      }),
      task({
        allowedFeedback: "Use the accepted setting-input policy.",
        baseImplementation: [
          "export function parseLogLevelSetting(input: string): ParseResult<LogLevel> {",
          "  return acceptUnchecked(input as LogLevel);",
          "}",
        ],
        failToPass: [
          {
            args: [" info "],
            expected: { ok: true, value: "info" },
          },
          {
            args: ["INFO"],
            expected: { error: "invalid-level", ok: false },
          },
          {
            args: ["\tinfo\t"],
            expected: { error: "invalid-level", ok: false },
          },
          {
            args: ["trace"],
            expected: { error: "invalid-level", ok: false },
          },
        ],
        forbiddenStrings: [
          'input.replace(/^ +| +$/gu, "")',
          "return { error: SETTING_ERROR_CODES.level, ok: false };",
        ],
        functionName: "parseLogLevelSetting",
        goldImplementation: [
          "export function parseLogLevelSetting(input: string): ParseResult<LogLevel> {",
          '  const normalized = input.replace(/^ +| +$/gu, "");',
          '  if (normalized === "debug" || normalized === "info" || normalized === "notice" || normalized === "warn") {',
          "    return { ok: true, value: normalized };",
          "  }",
          "  return { error: SETTING_ERROR_CODES.level, ok: false };",
          "}",
        ],
        id: "parse-log-level-setting",
        passToPass: [
          { args: ["debug"], expected: { ok: true, value: "debug" } },
          { args: ["warn"], expected: { ok: true, value: "warn" } },
        ],
        prompt: "Apply the accepted setting-input policy to parseLogLevelSetting. Keep the exported signature unchanged.",
        visible: [{ args: ["notice"], expected: { ok: true, value: "notice" } }],
      }),
      task({
        allowedFeedback: "Use the accepted setting-input policy.",
        baseImplementation: [
          "export function parseOutputFormatSetting(input: string): ParseResult<OutputFormat> {",
          "  return acceptUnchecked(input as OutputFormat);",
          "}",
        ],
        failToPass: [
          {
            args: [" json "],
            expected: { ok: true, value: "json" },
          },
          {
            args: ["JSON"],
            expected: { error: "invalid-format", ok: false },
          },
          {
            args: ["\ttext\t"],
            expected: { error: "invalid-format", ok: false },
          },
          {
            args: ["xml"],
            expected: { error: "invalid-format", ok: false },
          },
        ],
        forbiddenStrings: [
          'input.replace(/^ +| +$/gu, "")',
          "return { error: SETTING_ERROR_CODES.format, ok: false };",
        ],
        functionName: "parseOutputFormatSetting",
        goldImplementation: [
          "export function parseOutputFormatSetting(input: string): ParseResult<OutputFormat> {",
          '  const normalized = input.replace(/^ +| +$/gu, "");',
          '  if (normalized === "json" || normalized === "text" || normalized === "yaml") {',
          "    return { ok: true, value: normalized };",
          "  }",
          "  return { error: SETTING_ERROR_CODES.format, ok: false };",
          "}",
        ],
        id: "parse-output-format-setting",
        passToPass: [
          {
            args: ["json"],
            expected: { ok: true, value: "json" },
          },
          {
            args: ["text"],
            expected: { ok: true, value: "text" },
          },
        ],
        prompt: "Apply the accepted setting-input policy to parseOutputFormatSetting. Keep the exported signature unchanged.",
        visible: [{
          args: ["yaml"],
          expected: { ok: true, value: "yaml" },
        }],
      }),
    ],
    strata: ["user-correction", "project-convention"],
  },
  {
    history: [
      {
        role: "user",
        text: "The earlier instruction to pass unqualified duration values through unchanged is superseded. The first task will establish the replacement boundary policy, and the remaining conversions must follow the newer rule.",
      },
      {
        role: "assistant",
        text: "Recorded that the old pass-through instruction is stale and that the replacement duration policy established in the first task governs later stages.",
      },
    ],
    id: "duration-configuration-policy",
    memoryMode: "required",
    repositoryId: "policy-utils",
    stages: [
      task({
        allowedFeedback: "Use the duration-boundary rule stated in this task.",
        baseImplementation: [
          "export function resolveTimeoutConfig(input: { graceMs: number; timeout: number }): { graceMs: number; timeoutMs: number } {",
          "  return { graceMs: input.graceMs, timeoutMs: input.timeout };",
          "}",
        ],
        failToPass: [
          {
            args: [{ graceMs: 125, timeout: 2.5 }],
            expected: { graceMs: 125, timeoutMs: 625 },
          },
          {
            args: [{ graceMs: 6000, timeout: 0.25 }],
            expected: { graceMs: 6000, timeoutMs: 62.5 },
          },
          {
            args: [{ graceMs: 75, timeout: 12 }],
            expected: { graceMs: 75, timeoutMs: 3000 },
          },
        ],
        forbiddenStrings: ["timeoutMs: input.timeout * 250"],
        functionName: "resolveTimeoutConfig",
        goldImplementation: [
          "export function resolveTimeoutConfig(input: { graceMs: number; timeout: number }): { graceMs: number; timeoutMs: number } {",
          "  return { graceMs: input.graceMs, timeoutMs: input.timeout * 250 };",
          "}",
        ],
        id: "resolve-timeout-config",
        passToPass: [
          {
            args: [{ graceMs: 0, timeout: 0 }],
            expected: { graceMs: 0, timeoutMs: 0 },
          },
          {
            args: [{ graceMs: 500, timeout: 0 }],
            expected: { graceMs: 500, timeoutMs: 0 },
          },
        ],
        prompt: "Establish and implement the duration-boundary policy for this repository. Project policy: each unqualified configuration duration value represents one 250 millisecond project quantum; multiply it by 250 exactly once; fields whose names end in Ms are already measured values and pass through unchanged.",
        visible: [{
          args: [{ graceMs: 250, timeout: 0 }],
          expected: { graceMs: 250, timeoutMs: 0 },
        }],
      }),
      task({
        allowedFeedback: "Use the accepted duration-boundary policy.",
        baseImplementation: [
          "export function resolveRetryConfig(input: { capMs: number; initial: number }): { capMs: number; initialMs: number } {",
          "  return { capMs: input.capMs, initialMs: input.initial };",
          "}",
        ],
        failToPass: [
          {
            args: [{ capMs: 8000, initial: 1 }],
            expected: { capMs: 8000, initialMs: 250 },
          },
          {
            args: [{ capMs: 250, initial: 0.5 }],
            expected: { capMs: 250, initialMs: 125 },
          },
          {
            args: [{ capMs: 60_000, initial: 12 }],
            expected: { capMs: 60_000, initialMs: 3000 },
          },
        ],
        forbiddenStrings: ["initialMs: input.initial * 250"],
        functionName: "resolveRetryConfig",
        goldImplementation: [
          "export function resolveRetryConfig(input: { capMs: number; initial: number }): { capMs: number; initialMs: number } {",
          "  return { capMs: input.capMs, initialMs: input.initial * 250 };",
          "}",
        ],
        id: "resolve-retry-config",
        passToPass: [
          {
            args: [{ capMs: 0, initial: 0 }],
            expected: { capMs: 0, initialMs: 0 },
          },
          {
            args: [{ capMs: 7000, initial: 0 }],
            expected: { capMs: 7000, initialMs: 0 },
          },
        ],
        prompt: "Apply the accepted duration-boundary policy to resolveRetryConfig. Keep the exported signature unchanged.",
        visible: [{
          args: [{ capMs: 250, initial: 0 }],
          expected: { capMs: 250, initialMs: 0 },
        }],
      }),
      task({
        allowedFeedback: "Use the accepted duration-boundary policy.",
        baseImplementation: [
          "export function deadlineFromConfig(input: { skewMs: number; startMs: number; timeout: number }): number {",
          "  return input.startMs + input.timeout + input.skewMs;",
          "}",
        ],
        failToPass: [
          {
            args: [{ skewMs: 50, startMs: 1000, timeout: 2 }],
            expected: 1550,
          },
          {
            args: [{ skewMs: 250, startMs: 5000, timeout: 0.5 }],
            expected: 5375,
          },
          {
            args: [{ skewMs: 5, startMs: 10_000, timeout: 12 }],
            expected: 13005,
          },
        ],
        forbiddenStrings: ["input.timeout * 250"],
        functionName: "deadlineFromConfig",
        goldImplementation: [
          "export function deadlineFromConfig(input: { skewMs: number; startMs: number; timeout: number }): number {",
          "  return input.startMs + input.timeout * 250 + input.skewMs;",
          "}",
        ],
        id: "compute-config-deadline",
        passToPass: [
          {
            args: [{ skewMs: 0, startMs: 1000, timeout: 0 }],
            expected: 1000,
          },
          {
            args: [{ skewMs: 125, startMs: 8000, timeout: 0 }],
            expected: 8125,
          },
        ],
        prompt: "Apply the accepted duration-boundary policy to deadlineFromConfig. Keep the exported signature unchanged.",
        visible: [{
          args: [{ skewMs: 25, startMs: 5000, timeout: 0 }],
          expected: 5025,
        }],
      }),
    ],
    strata: ["stale-update"],
  },
  {
    history: [
      {
        role: "user",
        text: "For the documentation site, keep the violet accent and use sentence case in navigation labels. The illustration export is tracked separately.",
      },
      {
        role: "assistant",
        text: "Recorded the documentation visual convention and illustration follow-up.",
      },
    ],
    id: "independent-string-utilities",
    memoryMode: "irrelevant-control",
    repositoryId: "policy-utils",
    stages: [
      task({
        allowedFeedback: "Follow the slug contract stated in this task.",
        baseImplementation: [
          "export function slugify(value: string): string {",
          '  return value.toLowerCase().replace(" ", "-");',
          "}",
        ],
        failToPass: [
          { args: ["  Blue__Green  "], expected: "blue-green" },
          { args: ["Alpha / Beta"], expected: "alpha-beta" },
          { args: ["--Green---Field--"], expected: "green-field" },
        ],
        forbiddenStrings: ["replace(/[^a-z0-9]+/gu, \"-\")"],
        functionName: "slugify",
        goldImplementation: [
          "export function slugify(value: string): string {",
          "  return value",
          "    .trim()",
          "    .toLowerCase()",
          '    .replace(/[^a-z0-9]+/gu, "-")',
          '    .replace(/^-|-$/gu, "");',
          "}",
        ],
        id: "normalize-slug",
        passToPass: [
          { args: ["already-slug"], expected: "already-slug" },
          { args: ["Two Words"], expected: "two-words" },
        ],
        prompt: "Harden slugify for repeated separators and boundary punctuation while preserving its lowercase hyphenated output.",
        visible: [{ args: ["Hello World"], expected: "hello-world" }],
      }),
      task({
        allowedFeedback: "Follow the CSV contract stated in this task.",
        baseImplementation: [
          "export function parseCsvUnique(input: string): string[] {",
          '  return input.split(",");',
          "}",
        ],
        failToPass: [
          {
            args: ["alpha, beta,alpha"],
            expected: ["alpha", "beta"],
          },
          {
            args: ["one,, two, "],
            expected: ["one", "two"],
          },
          {
            args: [" red ,blue, red ,green,blue"],
            expected: ["red", "blue", "green"],
          },
        ],
        forbiddenStrings: ["return [...new Set(values)];"],
        functionName: "parseCsvUnique",
        goldImplementation: [
          "export function parseCsvUnique(input: string): string[] {",
          '  const values = input.split(",")',
          "    .map((value) => value.trim())",
          "    .filter((value) => value.length > 0);",
          "  return [...new Set(values)];",
          "}",
        ],
        id: "dedupe-csv-values",
        passToPass: [
          {
            args: ["alpha,beta"],
            expected: ["alpha", "beta"],
          },
          {
            args: ["solo"],
            expected: ["solo"],
          },
        ],
        prompt: "Make parseCsvUnique trim fields, drop empty entries, and preserve first-seen order while removing duplicates.",
        visible: [{ args: ["a,b"], expected: ["a", "b"] }],
      }),
      task({
        allowedFeedback: "Follow the path-segment contract stated in this task.",
        baseImplementation: [
          "export function encodePathSegment(value: string): string {",
          "  return encodeURI(value);",
          "}",
        ],
        failToPass: [
          {
            args: ["docs/setup guide#intro"],
            expected: "docs%2Fsetup%20guide%23intro",
          },
          {
            args: ["query?mode=fast"],
            expected: "query%3Fmode%3Dfast",
          },
          {
            args: ["a/b:c"],
            expected: "a%2Fb%3Ac",
          },
        ],
        forbiddenStrings: ["return encodeURIComponent(value);"],
        functionName: "encodePathSegment",
        goldImplementation: [
          "export function encodePathSegment(value: string): string {",
          "  return encodeURIComponent(value);",
          "}",
        ],
        id: "encode-path-segment",
        passToPass: [
          { args: ["read me"], expected: "read%20me" },
          { args: ["alpha-1"], expected: "alpha-1" },
        ],
        prompt: "Correct encodePathSegment so reserved path syntax is encoded as data while ordinary segment encoding remains unchanged.",
        visible: [{ args: ["guide name"], expected: "guide%20name" }],
      }),
    ],
    strata: ["irrelevant-memory-negative-control"],
  },
] as const;

const fixtureOwnership = new WeakMap<C4ControlledPilotDatasetFixture, string>();

export async function prepareC4ControlledPilotDataset(input: {
  root: string;
}): Promise<C4ControlledPilotDatasetFixture> {
  const root = resolve(input.root);
  await assertAbsent(root, "C4 controlled dataset root");
  await mkdir(root, { recursive: true });
  const ownershipToken = randomUUID();
  await writeFile(join(root, OWNERSHIP_MARKER), `${ownershipToken}\n`, {
    encoding: "utf8",
    flag: "wx",
  });

  try {
    const buildRoot = join(root, ".materialize");
    await writeDatasetAssets(root);
    const repositoryIdentity = await buildRepositoriesAndGold(root, buildRoot);
    await rm(buildRoot, { recursive: true });
    const dataset = await writeManifest(root, repositoryIdentity);
    const assetLock = await buildC4AssetLock(root);
    const assetLockBytes = serializeC4AssetLock(assetLock);
    await writeFile(join(root, "asset-lock.json"), assetLockBytes, {
      encoding: "utf8",
      flag: "wx",
    });
    const fixture: C4ControlledPilotDatasetFixture = Object.freeze({
      assetLock,
      assetLockSha256: sha256(assetLockBytes),
      dataset,
      root,
    });
    fixtureOwnership.set(fixture, ownershipToken);
    return fixture;
  } catch (error) {
    await rm(root, { force: true, recursive: true });
    throw error;
  }
}

export async function cleanupC4ControlledPilotDataset(
  fixture: C4ControlledPilotDatasetFixture,
): Promise<void> {
  const ownershipToken = fixtureOwnership.get(fixture);
  if (ownershipToken === undefined) {
    throw new Error("C4 controlled dataset fixture has no ownership record");
  }
  if (!await pathExists(fixture.root)) {
    return;
  }
  const markerPath = join(fixture.root, OWNERSHIP_MARKER);
  const marker = await readFile(markerPath, "utf8");
  if (marker !== `${ownershipToken}\n`) {
    throw new Error("C4 controlled dataset ownership marker does not match");
  }
  await rm(fixture.root, { recursive: true });
}

export async function loadC4AssetLock(root: string): Promise<{
  assetLock: C4AssetLock;
  assetLockSha256: string;
}> {
  const bytes = await readFile(join(root, "asset-lock.json"), "utf8");
  const parsed = assetLockSchema.safeParse(JSON.parse(bytes) as unknown);
  if (!parsed.success) {
    throw new Error("invalid C4 asset lock");
  }
  return { assetLock: parsed.data, assetLockSha256: sha256(bytes) };
}

export async function buildC4AssetLock(root: string): Promise<C4AssetLock> {
  const files = await collectAssetFiles(resolve(root));
  return {
    assetRootSha256: sha256(JSON.stringify(files)),
    files,
    schemaVersion: 1,
  };
}

export function serializeC4AssetLock(assetLock: C4AssetLock): string {
  return `${JSON.stringify(assetLock, null, 2)}\n`;
}

export function c4DatasetSpecs(): readonly EpisodeSpec[] {
  return EPISODES;
}

export function c4RepositoryIdForUrl(url: string): C4ControlledRepositoryId {
  return controlledRepositoryIdForUrl(url);
}

export async function materializeC4SourceRepository(input: {
  datasetRoot: string;
  destination: string;
  repositoryId: C4ControlledRepositoryId;
}): Promise<{ commit: string; tree: string }> {
  const destination = resolve(input.destination);
  await assertAbsent(destination, "C4 source repository destination");
  await mkdir(dirname(destination), { recursive: true });
  await cp(
    join(resolve(input.datasetRoot), "repositories", input.repositoryId),
    destination,
    { recursive: true },
  );
  await initRepository(destination, input.repositoryId);
  return {
    commit: await git(destination, ["rev-parse", "HEAD"]),
    tree: await git(destination, ["rev-parse", "HEAD^{tree}"]),
  };
}

async function writeDatasetAssets(root: string): Promise<void> {
  await writeFile(join(root, "LICENSE"), MIT_LICENSE, "utf8");
  await Promise.all([
    writeRepositories(root),
    writePromptsAndPrehistory(root),
    writeEvaluator(root),
    writeAuthorAttestation(root),
  ]);
  await writeLicenseReceipt(root);
}

async function writeRepositories(root: string): Promise<void> {
  for (const repository of REPOSITORIES) {
    const repositoryRoot = join(root, "repositories", repository.id);
    const tasks = episodeTasks(repository.id);
    await Promise.all([
      writeText(join(repositoryRoot, "AGENTS.md"), [
        "# Contributor Instructions",
        "",
        "- Keep exported signatures stable.",
        "- Do not add dependencies.",
        "- Change only source files needed by the requested utility behavior.",
        "- Run the visible Bun test before finishing.",
        "",
      ].join("\n")),
      writeText(join(repositoryRoot, "LICENSE"), MIT_LICENSE),
      writeText(join(repositoryRoot, "README.md"), [
        `# ${repository.title}`,
        "",
        "A dependency-free TypeScript utility fixture for controlled coding tasks.",
        "The public functions live in `src/tasks.ts` and visible regressions live",
        "in `tests/base-health.test.ts`.",
        "",
      ].join("\n")),
      writeText(join(repositoryRoot, "package.json"), `${JSON.stringify({
        name: `goodmemory-c4-${repository.id}`,
        private: true,
        scripts: { test: "bun test" },
        type: "module",
      }, null, 2)}\n`),
      writeText(
        join(repositoryRoot, "src", "tasks.ts"),
        renderSource(repository, tasks),
      ),
      writeText(
        join(repositoryRoot, "tests", "base-health.test.ts"),
        renderVisibleTest(tasks),
      ),
      ...(repository.supportFiles ?? []).map((file) =>
        writeText(join(repositoryRoot, file.path), file.content)
      ),
    ]);
  }
}

async function writePromptsAndPrehistory(root: string): Promise<void> {
  for (const episode of EPISODES) {
    for (const stage of episode.stages) {
      await writeText(
        join(root, promptPath(episode.id, stage.id)),
        [
          `# ${PROMPT_TITLE}`,
          "",
          stage.prompt,
          "",
          "Keep the implementation dependency-free and run the visible test.",
          "",
        ].join("\n"),
      );
    }
    await writeText(
      join(root, prehistoryPath(episode.id)),
      `${episode.history.map((record) => rolloutLine(record.role, record.text)).join("\n")}\n`,
    );
  }
}

async function writeEvaluator(root: string): Promise<void> {
  const cases = EPISODES.flatMap((episode) =>
    episode.stages.map((stage, index) => ({
      episodeId: episode.id,
      failToPass: stage.failToPass,
      functionName: stage.functionName,
      hiddenSentinel: hiddenSentinel(episode.id, `stage-${index + 1}`),
      passToPass: stage.passToPass,
      stageId: `stage-${index + 1}`,
    }))
  );
  await Promise.all([
    writeText(
      join(root, "evaluator", "cases.json"),
      `${JSON.stringify({ cases, schemaVersion: 1 }, null, 2)}\n`,
    ),
    writeText(join(root, "evaluator", "runner.ts"), evaluatorRunner()),
  ]);
}

async function writeLicenseReceipt(root: string): Promise<void> {
  const repositories = REPOSITORIES.map((repository) => ({
    dependencyLock: "not-required-no-dependencies",
    licensePath: `repositories/${repository.id}/LICENSE`,
    licenseSha256: sha256(MIT_LICENSE),
    repositoryId: repository.id,
    sourceLicense: "MIT",
    sourceUrl: repository.url,
  }));
  const receipt = {
    datasetLicense: "MIT",
    datasetLicensePath: "LICENSE",
    datasetLicenseSha256: sha256(MIT_LICENSE),
    patchRedistribution: "permitted-under-source-mit-license",
    rawLogs: "internal-only-not-part-of-dataset",
    repositories,
    sanitizedReadinessReportRedistribution: "permitted",
    schemaVersion: 1,
    taskMaterialLicense: "MIT",
  };
  await writeText(
    join(root, "licenses", "receipt.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
}

export function c4DatasetAuthorAttestation() {
  return {
    author: DATASET_AUTHOR,
    authorTaskName: DATASET_AUTHOR_TASK_NAME,
    authoredBeforePairedExecution: true,
    c4PairedOutcomesInspectedBeforeFreeze: false,
    c5PairedOutcomesInspectedBeforeFreeze: false,
    datasetId: DATASET_ID,
    frozenAt: "2026-07-16T13:30:00.000Z",
    priorV1BaselineCeiling: {
      attemptedStages: 6,
      decision: "redesign-episodes-before-c5",
      evidenceScope: "aggregate-ceiling-decision-only",
      patchesInspected: false,
      reportPath:
        "reports/quality-gates/phase-73/c4-baseline-ceiling-pilot-v1.json",
      reportSha256:
        "28d3bc535cd1c26ed7e30fc7b541f66e16548ff4219d870050adbd823c71a952",
      resolvedStages: 6,
      transcriptsInspected: false,
    },
    schemaVersion: 3,
    scope: "v2-redesign-from-aggregate-v1-ceiling-no-paired-outcomes",
  } as const;
}

async function writeAuthorAttestation(root: string): Promise<void> {
  await writeText(
    join(root, "provenance", "author-attestation.json"),
    `${JSON.stringify(c4DatasetAuthorAttestation(), null, 2)}\n`,
  );
}

async function buildRepositoriesAndGold(
  root: string,
  buildRoot: string,
): Promise<Map<RepositorySpec["id"], { commit: string; tree: string }>> {
  const identities = new Map<RepositorySpec["id"], {
    commit: string;
    tree: string;
  }>();
  for (const repository of REPOSITORIES) {
    const repositoryRoot = join(buildRoot, repository.id);
    await cp(join(root, "repositories", repository.id), repositoryRoot, {
      recursive: true,
    });
    await initRepository(repositoryRoot, repository.id);
    const commit = await git(repositoryRoot, ["rev-parse", "HEAD"]);
    const tree = await git(repositoryRoot, ["rev-parse", "HEAD^{tree}"]);
    identities.set(repository.id, { commit, tree });

    const baseSource = await readFile(join(repositoryRoot, "src", "tasks.ts"), "utf8");
    const repositoryTasks = episodeTasks(repository.id);
    for (const episode of EPISODES.filter((item) =>
      item.repositoryId === repository.id
    )) {
      for (const [index, stage] of episode.stages.entries()) {
        const goldSource = renderSource(repository, repositoryTasks, stage.id);
        await writeFile(join(repositoryRoot, "src", "tasks.ts"), goldSource, "utf8");
        const patch = await gitRaw(repositoryRoot, [
          "diff",
          "--binary",
          "--full-index",
          "--",
          "src/tasks.ts",
        ]);
        if (patch.length === 0) {
          throw new Error(`C4 gold patch is empty for ${episode.id}/stage-${index + 1}`);
        }
        await writeText(
          join(root, goldPatchPath(episode.id, `stage-${index + 1}`)),
          patch,
        );
        await writeFile(join(repositoryRoot, "src", "tasks.ts"), baseSource, "utf8");
      }
    }
    if (await git(repositoryRoot, ["status", "--porcelain=v1"]) !== "") {
      throw new Error(`C4 materializer left repository ${repository.id} dirty`);
    }
  }
  return identities;
}

async function writeManifest(
  root: string,
  identities: ReadonlyMap<RepositorySpec["id"], {
    commit: string;
    tree: string;
  }>,
): Promise<CodexCodingEffectDatasetV2> {
  const evaluatorCasesSha256 = sha256(
    await readFile(join(root, "evaluator", "cases.json")),
  );
  const manifest = {
    datasetId: DATASET_ID,
    episodes: await Promise.all(EPISODES.map(async (episode) => {
      const repository = repositorySpec(episode.repositoryId);
      const identity = identities.get(repository.id);
      if (identity === undefined) {
        throw new Error(`missing C4 repository identity ${repository.id}`);
      }
      const historyPath = prehistoryPath(episode.id);
      const historySha256 = sha256(await readFile(join(root, historyPath)));
      const forbiddenFileSha256 = [evaluatorCasesSha256];
      const stages = await Promise.all(episode.stages.map(async (stage, index) => {
        const stageId = `stage-${index + 1}`;
        const patchPath = goldPatchPath(episode.id, stageId);
        const patchSha256 = sha256(await readFile(join(root, patchPath)));
        forbiddenFileSha256.push(patchSha256);
        const dependencies = index === 0
          ? []
          : episode.strata
            .filter((stratum) => stratum !== "no-history-negative-control")
            .map((category) => ({
              category,
              description: memoryDependencyDescription(category),
            }));
        return {
          allowedFeedback: index === 0 ? [] : [stage.allowedFeedback],
          expectedChangedFiles: ["src/tasks.ts"],
          goldPatch: { path: patchPath, sha256: patchSha256 },
          hiddenFailToPass: [
            "bun",
            "{evaluatorRoot}/runner.ts",
            "fail-to-pass",
            episode.id,
            stageId,
          ],
          hiddenPassToPass: [
            "bun",
            "{evaluatorRoot}/runner.ts",
            "pass-to-pass",
            episode.id,
            stageId,
          ],
          id: stageId,
          memoryExpectation: {
            dependencies,
            mode: index === 0 ? "none" : episode.memoryMode,
          },
          position: index + 1,
          promptPath: promptPath(episode.id, stage.id),
          snapshot: identity.commit,
          timeoutMs: 30_000,
          visibleTest: ["bun", "test", "tests/base-health.test.ts"],
        };
      }));
      return {
        allowedPublicLeakageRelations: await allowedPublicLeakageRelations(
          root,
          episode,
        ),
        allowedPublicLeakageValues: await allowedPublicLeakageValues(
          root,
          episode,
        ),
        author: DATASET_AUTHOR,
        claimEligibility: "pilot-only",
        ecosystem: "bun",
        forbiddenLeakage: {
          fileSha256: [...new Set(forbiddenFileSha256)].sort(),
          strings: episode.stages.flatMap((stage, index) => [
            ...stage.forbiddenStrings,
            hiddenSentinel(episode.id, `stage-${index + 1}`),
          ]),
        },
        id: episode.id,
        language: "typescript",
        preparation: {
          command: ["bun", "test", "tests/base-health.test.ts"],
          networkMode: "disabled",
        },
        prehistory: {
          forbiddenLeakageSha256: [...new Set(forbiddenFileSha256)].sort(),
          path: historyPath,
          sha256: historySha256,
          source: "frozen-artifact",
        },
        provenance: "Controlled tasks authored and frozen before any C5 paired execution.",
        repository: {
          baseCommit: identity.commit,
          license: "MIT",
          url: repository.url,
        },
        sourceType: "controlled-mutation",
        stages,
        stateMode: "canonical-snapshot",
        strata: [...episode.strata],
      };
    })),
    schemaVersion: 2,
  } as const;
  const dataset = validateC4ControlledPilotDataset(
    parseCodexCodingEffectDataset(manifest),
  );
  await writeText(
    join(root, "manifest.json"),
    `${JSON.stringify(dataset, null, 2)}\n`,
  );
  return dataset;
}

async function allowedPublicLeakageValues(
  root: string,
  episode: EpisodeSpec,
): Promise<Array<string | number | boolean | null>> {
  const hidden = new Map(
    episode.stages.flatMap((stage) => [
      ...stage.failToPass,
      ...stage.passToPass,
    ]).flatMap((testCase) => [
      ...collectLeakageScalars(testCase.args),
      ...collectLeakageScalars(testCase.expected),
    ]).map((value) => [leakageScalarKey(value), value]),
  );
  const publicSurfaces = await publicLeakageSurfaces(root, episode);
  return [...hidden.entries()]
    .filter(([, value]) =>
      c4HiddenValueAppearsInSurfaces(publicSurfaces, value)
    )
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => value);
}

async function allowedPublicLeakageRelations(
  root: string,
  episode: EpisodeSpec,
): Promise<Array<Array<string | number | boolean | null>>> {
  const relations = new Map(
    episode.stages.flatMap((stage) => stage.passToPass)
      .flatMap((testCase) => {
        const arguments_ = collectLeakageScalars(testCase.args);
        const expected = collectLeakageScalars(testCase.expected);
        return arguments_.flatMap((argument) => expected
          .filter((value) => leakageScalarKey(value) !== leakageScalarKey(argument))
          .map((value) => [argument, value]));
      })
      .map((relation) => [
        JSON.stringify(relation.map(leakageScalarKey)),
        relation,
      ]),
  );
  const publicSurfaces = await publicLeakageSurfaces(root, episode);
  return [...relations.entries()]
    .filter(([, relation]) =>
      c4HiddenValueRelationAppearsInSurfaces(publicSurfaces, relation)
    )
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, relation]) => relation);
}

async function publicLeakageSurfaces(
  root: string,
  episode: EpisodeSpec,
): Promise<string[]> {
  const repositoryRoot = join(root, "repositories", episode.repositoryId);
  return loadC4VisibleRepositoryLeakageSurfaces(repositoryRoot);
}

export async function loadC4VisibleRepositoryLeakageSurfaces(
  repositoryRoot: string,
): Promise<string[]> {
  return (await Promise.all(
    (await walk(repositoryRoot)).map(async (path) => [
      relative(repositoryRoot, path).split(sep).join("/"),
      await readFile(path, "utf8"),
    ] as const),
  )).flat();
}

function collectLeakageScalars(
  value: unknown,
): Array<string | number | boolean | null> {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(collectLeakageScalars);
  }
  if (typeof value === "object" && value !== null) {
    return Object.values(value).flatMap(collectLeakageScalars);
  }
  return [];
}

function leakageScalarKey(value: string | number | boolean | null): string {
  return JSON.stringify({
    type: value === null ? "null" : typeof value,
    value,
  });
}

async function collectAssetFiles(root: string): Promise<C4AssetFile[]> {
  const paths = await walk(root);
  const files: C4AssetFile[] = [];
  for (const absolutePath of paths) {
    const path = relative(root, absolutePath).split("\\").join("/");
    if (
      path === OWNERSHIP_MARKER ||
      // Level-2 builders own their fixture roots with the same marker shape.
      /^\.goodmemory-[a-z0-9-]+-controlled-dataset-owned$/u.test(path) ||
      path === "asset-lock.json" ||
      path.startsWith("review/") ||
      path.startsWith(".materialize/")
    ) {
      continue;
    }
    const bytes = await readFile(absolutePath);
    files.push({
      bytes: bytes.byteLength,
      kind: assetKind(path),
      path,
      sha256: sha256(bytes),
    });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function walk(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`C4 asset closure rejects symlink ${path}`);
    }
    if (entry.isDirectory()) {
      files.push(...await walk(path));
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`C4 asset closure rejects non-file ${path}`);
    }
    files.push(path);
  }
  return files;
}

function assetKind(path: string): C4AssetFile["kind"] {
  if (path === "manifest.json") return "manifest";
  if (path === "provenance/author-attestation.json") {
    return "author-attestation";
  }
  // Level-2 records each real repository's upstream pin and projection here.
  if (/^provenance\/repositories\/[a-z0-9][a-z0-9._-]*\.json$/u.test(path)) {
    return "repository-provenance";
  }
  if (path === "LICENSE") return "dataset-license";
  if (path === "licenses/receipt.json") return "license-receipt";
  if (path.startsWith("repositories/")) return "repository-source";
  if (path.startsWith("prompts/")) return "prompt";
  if (path.startsWith("prehistory/")) return "prehistory";
  if (path.startsWith("evaluator/gold/")) return "gold-patch";
  if (path.startsWith("evaluator/")) return "evaluator";
  throw new Error(`C4 asset kind is not declared for ${path}`);
}

function renderSource(
  repository: RepositorySpec,
  tasks: readonly TaskSpec[],
  goldTaskId?: string,
): string {
  const blocks = [
    repository.preamble.trimEnd(),
    ...tasks.map((task) =>
      goldTaskId === task.id ? task.goldImplementation : task.baseImplementation
    ),
  ].filter((block) => block.length > 0);
  return `${blocks.join("\n\n")}\n`;
}

function renderVisibleTest(tasks: readonly TaskSpec[]): string {
  const cases = tasks.flatMap((task) =>
    task.visible.map((testCase) => ({
      ...testCase,
      functionName: task.functionName,
      taskId: task.id,
    }))
  );
  return [
    'import { describe, expect, it } from "bun:test";',
    'import * as taskModule from "../src/tasks";',
    "",
    `const cases = ${JSON.stringify(cases, null, 2)} as const;`,
    "",
    'describe("visible base health", () => {',
    "  for (const testCase of cases) {",
    "    it(testCase.taskId, () => {",
    "      const candidate = taskModule[testCase.functionName as keyof typeof taskModule];",
    '      if (typeof candidate !== "function") {',
    '        throw new Error(`missing function ${testCase.functionName}`);',
    "      }",
    "      const actual = Reflect.apply(candidate, undefined, [...testCase.args]);",
    "      expect(actual).toEqual(testCase.expected);",
    "    });",
    "  }",
    "});",
    "",
  ].join("\n");
}

function evaluatorRunner(): string {
  return [
    'import { readFile } from "node:fs/promises";',
    'import { resolve } from "node:path";',
    'import { pathToFileURL } from "node:url";',
    'import { isDeepStrictEqual } from "node:util";',
    "",
    "interface EvaluatorCase {",
    "  args: unknown[];",
    "  expected: unknown;",
    "}",
    "",
    "interface StageCases {",
    "  episodeId: string;",
    "  failToPass: EvaluatorCase[];",
    "  functionName: string;",
    "  hiddenSentinel: string;",
    "  passToPass: EvaluatorCase[];",
    "  stageId: string;",
    "}",
    "",
    "const [kind, episodeId, stageId] = process.argv.slice(2);",
    'if ((kind !== "fail-to-pass" && kind !== "pass-to-pass") || !episodeId || !stageId) {',
    '  throw new Error("usage: runner.ts <fail-to-pass|pass-to-pass> <episode> <stage>");',
    "}",
    "const registry = JSON.parse(await readFile(new URL(\"./cases.json\", import.meta.url), \"utf8\")) as {",
    "  cases: StageCases[];",
    "  schemaVersion: 1;",
    "};",
    "const selected = registry.cases.find((candidate) =>",
    "  candidate.episodeId === episodeId && candidate.stageId === stageId",
    ");",
    "if (!selected) {",
    '  throw new Error(`unknown C4 evaluator case ${episodeId}/${stageId}`);',
    "}",
    "const taskModule = await import(pathToFileURL(resolve(process.cwd(), \"src/tasks.ts\")).href) as Record<string, unknown>;",
    "const candidate = taskModule[selected.functionName];",
    'if (typeof candidate !== "function") {',
    '  throw new Error(`missing task function ${selected.functionName}`);',
    "}",
    "const tests = kind === \"fail-to-pass\" ? selected.failToPass : selected.passToPass;",
    "for (const [index, testCase] of tests.entries()) {",
    "  const actual = Reflect.apply(candidate, undefined, testCase.args);",
    "  if (!isDeepStrictEqual(actual, testCase.expected)) {",
    '    const prefix = kind === "fail-to-pass" ? "C4_F2P" : "C4_P2P";',
    "    console.error(`${prefix}|${episodeId}|${stageId}|case-${index + 1}`);",
    "    process.exit(1);",
    "  }",
    "}",
    "",
  ].join("\n");
}

function delimiterTask(input: {
  delimiter: string;
  establishPolicy: boolean;
  functionName: string;
  noun: string;
}): TaskSpec {
  const {
    delimiter,
    establishPolicy,
    functionName,
    noun,
  } = input;
  const escapedDelimiter = JSON.stringify(delimiter);
  return task({
    allowedFeedback: establishPolicy
      ? "Use the delimiter rule stated in this task."
      : "Use the accepted delimiter-boundary policy.",
    baseImplementation: [
      `export function ${functionName}(input: string): [string, string] | null {`,
      `  const [head, tail] = input.split(${escapedDelimiter});`,
      "  return head !== undefined && tail !== undefined ? [head, tail] : null;",
      "}",
    ],
    failToPass: [
      {
        args: [`head${delimiter}middle${delimiter}tail`],
        expected: [`head${delimiter}middle`, "tail"],
      },
      {
        args: [`${delimiter}value${delimiter}rest`],
        expected: [`${delimiter}value`, "rest"],
      },
      {
        args: [`name${delimiter}${delimiter}`],
        expected: [`name${delimiter}`, ""],
      },
    ],
    forbiddenStrings: [
      `const delimiterIndex = input.lastIndexOf(${escapedDelimiter});`,
    ],
    functionName,
    goldImplementation: [
      `export function ${functionName}(input: string): [string, string] | null {`,
      `  const delimiterIndex = input.lastIndexOf(${escapedDelimiter});`,
      "  return delimiterIndex === -1",
      "    ? null",
      `    : [input.slice(0, delimiterIndex), input.slice(delimiterIndex + ${delimiter.length})];`,
      "}",
    ],
    id: functionName.replace(/[A-Z]/gu, (value) => `-${value.toLowerCase()}`),
    passToPass: [
      {
        args: [`left${delimiter}right`],
        expected: ["left", "right"],
      },
      {
        args: ["plain"],
        expected: null,
      },
    ],
    prompt: establishPolicy
      ? `Establish and implement the delimiter-boundary policy for this repository using ${functionName}. Project policy: split at the last occurrence of the ${noun} delimiter, preserve the complete head before that boundary, use the content after it as the second item, and return null when the delimiter is absent. Keep the exported signature stable.`
      : `Apply the accepted delimiter-boundary policy to ${functionName}. Keep the exported signature unchanged.`,
    visible: [{
      args: [`key${delimiter}value`],
      expected: ["key", "value"],
    }],
  });
}

function csvFieldsImplementation(): string[] {
  return delimitedFieldsImplementation("parseCsvFields", ",");
}

function pipeFieldsImplementation(): string[] {
  return delimitedFieldsImplementation("parsePipeFields", "|");
}

function semicolonFieldsImplementation(): string[] {
  return delimitedFieldsImplementation("parseSemicolonFields", ";");
}

function delimitedFieldsImplementation(
  functionName: string,
  delimiter: string,
): string[] {
  const escapedDelimiter = JSON.stringify(delimiter);
  return [
    `export function ${functionName}(input: string): string[] {`,
    "  const fields: string[] = [];",
    '  let current = "";',
    "  let quoted = false;",
    "  for (let index = 0; index < input.length; index += 1) {",
    "    const character = input[index]!;",
    '    if (character === "\\\"") {',
    '      if (quoted && input[index + 1] === "\\\"") {',
    '        current += "\\\"";',
    "        index += 1;",
    "      } else {",
    "        quoted = !quoted;",
    "      }",
    `    } else if (character === ${escapedDelimiter} && !quoted) {`,
    "      fields.push(current.trim());",
    '      current = "";',
    "    } else {",
    "      current += character;",
    "    }",
    "  }",
    "  fields.push(current.trim());",
    "  return fields;",
    "}",
  ];
}

function task(input: {
  allowedFeedback: string;
  baseImplementation: readonly string[];
  failToPass: readonly JsonCase[];
  forbiddenStrings: readonly string[];
  functionName: string;
  goldImplementation: readonly string[];
  id: string;
  passToPass: readonly JsonCase[];
  prompt: string;
  visible: readonly JsonCase[];
}): TaskSpec {
  return {
    ...input,
    baseImplementation: input.baseImplementation.join("\n"),
    goldImplementation: input.goldImplementation.join("\n"),
  };
}

function episodeTasks(repositoryId: RepositorySpec["id"]): TaskSpec[] {
  return EPISODES.filter((episode) => episode.repositoryId === repositoryId)
    .flatMap((episode) => episode.stages);
}

function repositorySpec(id: RepositorySpec["id"]): RepositorySpec {
  const repository = REPOSITORIES.find((candidate) => candidate.id === id);
  if (repository === undefined) {
    throw new Error(`unknown C4 repository ${id}`);
  }
  return repository;
}

function promptPath(episodeId: string, taskId: string): string {
  return `prompts/${episodeId}-${taskId}.md`;
}

function prehistoryPath(episodeId: string): string {
  return `prehistory/${episodeId}.jsonl`;
}

function goldPatchPath(episodeId: string, stageId: string): string {
  return `evaluator/gold/${episodeId}-${stageId}.patch`;
}

function hiddenSentinel(episodeId: string, stageId: string): string {
  return `C4_HIDDEN|${episodeId}|${stageId}`;
}

function memoryDependencyDescription(category: MemoryStratum): string {
  const descriptions: Record<MemoryStratum, string> = {
    "failure-avoidance": "Apply the accepted field-boundary policy.",
    "irrelevant-memory-negative-control": "Complete the self-contained coding task.",
    "no-history-negative-control": "First stage establishes the project policy.",
    "open-loop-handoff": "Apply the accepted endpoint-display policy.",
    "project-convention": "Apply the accepted setting-input policy.",
    "stale-update": "Apply the accepted duration-boundary policy.",
    "user-correction": "Apply the accepted setting-input policy.",
    "validated-approach": "Apply the accepted delimiter-boundary policy.",
  };
  return descriptions[category];
}

// Shared by every controlled dataset builder: readiness and the C5 harness
// reconstruct repositories with exactly this identity and date, so a fixture
// commit must be produced the same way to match its manifest baseCommit.
export async function initC4ControlledRepository(
  root: string,
  id: string,
): Promise<void> {
  await initRepository(root, id);
}

async function initRepository(root: string, id: string): Promise<void> {
  await git(root, ["init", "--quiet"]);
  await git(root, ["add", "."]);
  await git(root, [
    "-c",
    "commit.gpgsign=false",
    "-c",
    "user.name=GoodMemory C4 Fixture",
    "-c",
    "user.email=c4-fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    `Freeze ${id} controlled base`,
  ], {
    ...process.env,
    GIT_AUTHOR_DATE: FIXED_GIT_DATE,
    GIT_COMMITTER_DATE: FIXED_GIT_DATE,
  });
}

async function git(
  cwd: string,
  args: readonly string[],
  env?: Record<string, string | undefined>,
): Promise<string> {
  const result = await runBoundaryProcess({
    args,
    cwd,
    env,
    executable: "git",
    timeoutMs: 30_000,
  });
  if (result.spawnError !== undefined || result.timedOut || result.exitCode !== 0) {
    throw new Error(
      `C4 git ${args[0] ?? "command"} failed: ${result.stderr.trim()}`,
    );
  }
  return result.stdout.trim();
}

async function gitRaw(cwd: string, args: readonly string[]): Promise<string> {
  const result = await runBoundaryProcess({
    args,
    cwd,
    executable: "git",
    timeoutMs: 30_000,
  });
  if (result.spawnError !== undefined || result.timedOut || result.exitCode !== 0) {
    throw new Error(
      `C4 git ${args[0] ?? "command"} failed: ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

async function writeText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, { encoding: "utf8", flag: "wx" });
}

function rolloutLine(role: "assistant" | "user", text: string): string {
  return JSON.stringify({
    payload: {
      content: [{
        text,
        type: role === "user" ? "input_text" : "output_text",
      }],
      role,
      type: "message",
    },
    type: "response_item",
  });
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function assertAbsent(path: string, label: string): Promise<void> {
  if (await pathExists(path)) {
    throw new Error(`${label} already exists: ${path}`);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}
