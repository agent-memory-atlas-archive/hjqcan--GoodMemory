import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  buildC4AssetLock,
  loadC4AssetLock,
} from "./codex-coding-effect/c4-controlled-dataset";
import {
  buildC4IndependentReviewDispatch,
  buildC4IndependentReviewSpawnMessage,
  buildC4ReviewInputBundle,
  buildC4ReviewRequest,
  serializeC4ReviewArtifact,
} from "./codex-coding-effect/c4-review-artifacts";
import { resolveControlledDatasetProfile } from "./codex-coding-effect/controlled-dataset-profile";
import type {
  C4DatasetCoreReadiness,
} from "./codex-coding-effect/c4-readiness";

const DEFAULT_DATASET_ROOT = resolve(
  "fixtures/codex-coding-effect/c4-controlled-pilot",
);
const DEFAULT_CORE_PATH = resolve(
  "reports/quality-gates/phase-73/c4-controlled-pilot-core.json",
);

export async function prepareC4IndependentReview(input: {
  corePath: string;
  createdAt: string;
  datasetRoot: string;
  replace?: boolean;
}): Promise<{
  dispatchSha256: string;
  inputBundleSha256: string;
  requestSha256: string;
  reviewRoot: string;
}> {
  const datasetRoot = resolve(input.datasetRoot);
  const reviewRoot = join(datasetRoot, "review");
  const [coreBytes, storedAssetLock, currentAssetLock] = await Promise.all([
    readFile(input.corePath, "utf8"),
    loadC4AssetLock(datasetRoot),
    buildC4AssetLock(datasetRoot),
  ]);
  if (
    JSON.stringify(storedAssetLock.assetLock) !==
      JSON.stringify(currentAssetLock)
  ) {
    throw new Error("C4 review preparation requires a current asset lock");
  }
  const core = JSON.parse(coreBytes) as C4DatasetCoreReadiness;
  const profile = resolveControlledDatasetProfile(core.datasetId);
  const coreSha256 = sha256(coreBytes);
  const assetFiles = storedAssetLock.assetLock.files.map((file) => ({
    path: file.path,
    sha256: file.sha256,
  })).sort((first, second) => first.path.localeCompare(second.path));
  if (
    core.status !== "accepted" ||
    core.assetLockSha256 !== storedAssetLock.assetLockSha256 ||
    core.assetRootSha256 !== storedAssetLock.assetLock.assetRootSha256 ||
    JSON.stringify(core.assetFiles) !== JSON.stringify(assetFiles)
  ) {
    throw new Error("C4 review preparation core does not bind the frozen dataset");
  }
  const inputBundleBytes = serializeC4ReviewArtifact(
    buildC4ReviewInputBundle({
      assetFiles,
      assetLockSha256: core.assetLockSha256,
      assetRootSha256: core.assetRootSha256,
      createdAt: input.createdAt,
      leakageAuditSha256: core.leakage.auditSha256,
      manifestSha256: core.manifestSha256,
      profile,
      readinessCoreSha256: coreSha256,
    }),
  );
  const requestBytes = buildC4ReviewRequest({
    inputBundleSha256: sha256(inputBundleBytes),
    profile,
  });
  const dispatchBytes = serializeC4ReviewArtifact(
    buildC4IndependentReviewDispatch({
      profile,
      spawnMessage: buildC4IndependentReviewSpawnMessage(profile),
    }),
  );
  if (input.replace) {
    await rm(reviewRoot, { force: true, recursive: true });
  }
  await mkdir(reviewRoot, { recursive: true });
  await Promise.all([
    writeFile(join(reviewRoot, "dispatch.json"), dispatchBytes, {
      encoding: "utf8",
      flag: "wx",
    }),
    writeFile(join(reviewRoot, "input-bundle.json"), inputBundleBytes, {
      encoding: "utf8",
      flag: "wx",
    }),
    writeFile(join(reviewRoot, "request.md"), requestBytes, {
      encoding: "utf8",
      flag: "wx",
    }),
  ]);
  return {
    dispatchSha256: sha256(dispatchBytes),
    inputBundleSha256: sha256(inputBundleBytes),
    requestSha256: sha256(requestBytes),
    reviewRoot,
  };
}

function parseOptions(args: readonly string[]): {
  corePath: string;
  createdAt: string;
  datasetRoot: string;
  replace: boolean;
} {
  let corePath = DEFAULT_CORE_PATH;
  let createdAt = new Date().toISOString();
  let datasetRoot = DEFAULT_DATASET_ROOT;
  let replace = false;
  for (const argument of args) {
    if (argument === "--replace") {
      replace = true;
    } else if (argument.startsWith("--core=")) {
      corePath = resolve(argument.slice("--core=".length));
    } else if (argument.startsWith("--created-at=")) {
      createdAt = argument.slice("--created-at=".length);
    } else if (argument.startsWith("--dataset-root=")) {
      datasetRoot = resolve(argument.slice("--dataset-root=".length));
    } else {
      throw new Error(`unknown C4 review preparation argument ${argument}`);
    }
  }
  return { corePath, createdAt, datasetRoot, replace };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

if (import.meta.main) {
  const result = await prepareC4IndependentReview(
    parseOptions(process.argv.slice(2)),
  );
  console.log(JSON.stringify(result, null, 2));
}
