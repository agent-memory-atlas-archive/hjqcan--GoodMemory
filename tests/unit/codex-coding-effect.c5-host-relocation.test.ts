import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";

import {
  C5_RUNNER_RELOCATION_ROOTS,
  normalizeC5RunnerDenyConfiguration,
  parseC5HostRelocationEvidence,
  parseC5HostRelocationReference,
  verifyC5RelocationPermission,
} from "../../scripts/codex-coding-effect/c5-host-relocation";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const [original, recovered] = C5_RUNNER_RELOCATION_ROOTS;
const config = (root: string) => [
  'default_permissions = "c3-task"',
  '[permissions.c3-task.filesystem]',
  '":root" = "deny"',
  `${JSON.stringify(root)} = "deny"`,
  '[permissions.c3-task.filesystem.":workspace_roots"]',
  '"." = "write"',
  '[permissions.c3-task.network]',
  'enabled = false',
  '',
].join("\n");

describe("C5 sealed-run runner relocation semantics", () => {
  it("keeps the formal review reference content-free and fixed to one sidecar", () => {
    const reference = {
      policyId: "run-c5-level2-flat-20260904T100113Z-runner-relocation-v1",
      path: "host-relocation-evidence.json", bytes: 100, sha256: sha("capsule"),
    } as const;
    expect(parseC5HostRelocationReference(reference)).toEqual(reference);
    for (const changed of [
      { ...reference, path: "../host-relocation-evidence.json" },
      { ...reference, path: "different.json" },
      { ...reference, policyId: "generic" },
      { ...reference, reviewManifest: "embedded content" },
      { ...reference, bytes: -1 },
    ]) expect(() => parseC5HostRelocationReference(changed)).toThrow();
  });
  it("compares only the exact runner deny key without deleting permissions", () => {
    const before = config(original);
    const after = config(recovered);
    const normalized = normalizeC5RunnerDenyConfiguration(before, original);
    expect(normalizeC5RunnerDenyConfiguration(after, recovered)).toBe(normalized);
    expect(normalized).toContain('"<runner-source-root>" = "deny"');
    expect(normalized).toContain('\":root\" = \"deny\"');
    expect(normalized).toContain('enabled = false');
    expect(before).toBe(config(original));
    expect(after).toBe(config(recovered));
  });

  it("rejects wrong roots, sections, duplicate roots, absent denies and changed values", () => {
    const line = `${JSON.stringify(original)} = "deny"`;
    for (const text of [
      config(`${original}-copy`),
      config(original).replace('[permissions.c3-task.filesystem]', '[permissions.other.filesystem]'),
      config(original).replace(line, `${line}\n${line}`),
      config(original).replace(line, ''),
      config(original).replace(line, `${JSON.stringify(original)} = "read"`),
      config(original).replace(line, `${JSON.stringify(original)} = "write"`),
      config(original).replace(line, `${line}\n${JSON.stringify(recovered)} = "deny"`),
      config(original).replace(line, `# ${line}`),
    ]) {
      expect(() => normalizeC5RunnerDenyConfiguration(text, original)).toThrow();
    }
    expect(() => normalizeC5RunnerDenyConfiguration(config('/different'), '/different')).toThrow();
  });

  it("does not conceal other config changes during the comparison", () => {
    const normalized = normalizeC5RunnerDenyConfiguration(config(original), original);
    for (const changed of [
      config(recovered).replace('enabled = false', 'enabled = true'),
      config(recovered).replace('\":root\" = \"deny\"', '\":root\" = \"read\"'),
      `${config(recovered)}[features]\nhooks = false\n`,
    ]) {
      expect(normalizeC5RunnerDenyConfiguration(changed, recovered)).not.toBe(normalized);
    }
  });

  it("requires config cross-binding, all controls and successful denial probes", () => {
    for (const runnerRoot of C5_RUNNER_RELOCATION_ROOTS) {
      const receipt = permission(runnerRoot);
      expect(() => verifyC5RelocationPermission(receipt, {
        configSha256: sha('config'), runnerRoot,
      })).not.toThrow();
    }
    const variants = [
      (r: ReturnType<typeof permission>) => { r.configSha256 = sha('other-config'); },
      (r: ReturnType<typeof permission>) => { r.deniedReads[0]!.exitCode = 0; },
      (r: ReturnType<typeof permission>) => { r.deniedReads[0]!.exitCode = null; },
      (r: ReturnType<typeof permission>) => { r.deniedReads[0]!.exitCode = -1; },
      (r: ReturnType<typeof permission>) => { r.deniedReads[0]!.denied = false; },
      (r: ReturnType<typeof permission>) => { r.deniedReads.pop(); },
      (r: ReturnType<typeof permission>) => { r.deniedReads[0]!.label = 'unknown'; },
      (r: ReturnType<typeof permission>) => { r.deniedReads[1]!.label = r.deniedReads[0]!.label; },
      (r: ReturnType<typeof permission>) => { r.deniedReads.find(p => p.label === 'runner-source')!.pathSha256 = sha('wrong-root'); },
      (r: ReturnType<typeof permission>) => { r.deniedReads.find(p => p.label === 'goodmemory-source-package')!.pathSha256 = sha('wrong-package-path'); },
      (r: ReturnType<typeof permission>) => { r.networkAccess = true; },
      (r: ReturnType<typeof permission>) => { r.networkDenied = false; },
      (r: ReturnType<typeof permission>) => { r.networkPositiveControl = false; },
      (r: ReturnType<typeof permission>) => { r.workspaceRead = false; },
      (r: ReturnType<typeof permission>) => { r.workspaceWrite = false; },
      (r: ReturnType<typeof permission>) => { r.passed = false; },
      (r: ReturnType<typeof permission>) => { r.reasons.push('probe-failed'); },
    ];
    for (const mutate of variants) {
      const receipt = permission(original);
      mutate(receipt);
      // The semantic predicate must reject even if an enclosing receipt hash
      // is freshly computed; these tests do not rely on a stale outer hash.
      const rebound = JSON.parse(JSON.stringify(receipt));
      expect(sha(JSON.stringify(rebound))).toHaveLength(64);
      expect(() => verifyC5RelocationPermission(rebound, {
        configSha256: sha('config'), runnerRoot: original,
      })).toThrow();
    }
  });

  it("rejects invented or incomplete policy envelopes", () => {
    for (const value of [null, {}, { policyId: 'generic-ignore-paths' }, {
      policyId: 'run-c5-level2-flat-20260904T100113Z-runner-relocation-v1',
      reviewManifest: '{}', captureManifest: '{}', supplementalFiles: [],
    }]) expect(() => parseC5HostRelocationEvidence(value)).toThrow();
  });
});

function permission(runnerRoot: string) {
  const labels = [
    'asset-lock', 'codex-auth-source', 'current-runtime-auth', 'current-runtime-config',
    'dataset-manifest', 'evaluator-cases', 'evaluator-runner', 'frozen-prehistory',
    'gold-patch', 'goodmemory-source-package', 'installed-package', 'other-arm-runtime-auth',
    'other-arm-runtime-config', 'other-arm-workspace', 'output-root', 'package-tarball',
    'runner-source', 'source-repository',
  ];
  return {
    configSha256: sha('config'),
    deniedReads: labels.map(label => ({
      denied: true,
      exitCode: 1 as number | null,
      label,
      pathSha256: sha(label === 'runner-source'
        ? `${runnerRoot}/scripts/codex-coding-effect/c5-native-adapter.ts`
        : label === 'goodmemory-source-package' ? `${runnerRoot}/package.json` : label),
    })),
    networkAccess: false,
    networkDenied: true,
    networkPositiveControl: true,
    passed: true,
    phase: 'preflight',
    profileName: 'c3-task',
    reasons: [] as string[],
    schemaVersion: 1,
    workspaceRead: true,
    workspaceWrite: true,
  };
}
