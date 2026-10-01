/** Explicit, opt-in example host. No implicit config discovery or optional-package loading. */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const disabled = () => Object.freeze({ enabled: false });
const configError = () => new Error('Shadow configuration must use a memory.shadow object with a boolean enabled field.');

function selectShadow(config) {
  if (!object(config)) throw configError();
  if (config.memory === undefined || config.memory === false) return undefined;
  if (!object(config.memory)) throw configError();
  if (config.memory.shadow === undefined) return undefined;
  const shadow = config.memory.shadow;
  if (!object(shadow) || (shadow.enabled !== undefined && typeof shadow.enabled !== 'boolean')) throw configError();
  return shadow;
}

/** Only explicitly supplied module paths/package specifiers are used, never installed or discovered. */
async function importHub(specifier) {
  if (specifier.startsWith('package:')) return import(specifier.slice('package:'.length));
  return import(pathToFileURL(resolve(specifier)).href);
}

/**
 * Read one explicitly selected JSON file, then construct the optional provider.
 * `readEnv` is host-local and lazy; the library factory itself has no ambient environment access.
 * All source transmission remains the caller's decision when it later evaluates an eligible snapshot.
 */
export async function loadConfiguredMemoryShadow({
  configPath,
  hubModule = 'package:@cognitive-hub/core/goodmemory-shadow',
  readEnv = name => process.env[name],
  fetch,
  loadHub = importHub,
}) {
  if (typeof configPath !== 'string' || !configPath.trim()) throw new Error('Shadow configuration file path is required.');
  let content;
  try { content = await readFile(configPath, 'utf8'); }
  catch { throw new Error('Shadow configuration file is not readable.'); }
  let config;
  try { config = JSON.parse(content); }
  catch { throw new Error('Shadow configuration file must contain valid JSON.'); }
  const shadow = selectShadow(config);
  if (shadow?.enabled !== true) return disabled();
  let module;
  try { module = await loadHub(hubModule); }
  catch { throw new Error('CognitiveHub shadow configuration module is unavailable.'); }
  if (typeof module?.createConfiguredGoodMemoryShadowAdvisor !== 'function') {
    throw new Error('CognitiveHub shadow configuration module is unavailable.');
  }
  // The Hub factory validates this subsection and exposes fixed, value-free configuration errors.
  return module.createConfiguredGoodMemoryShadowAdvisor(shadow, {
    readEnv,
    ...(fetch === undefined ? {} : { fetch }),
  });
}

/** Read-only hook for a host that already owns a trusted, eligible source-grounded snapshot. */
export async function evaluateConfiguredMemoryShadow({ configured, createSnapshot, readCurrentVersion, evaluate }) {
  if (configured.enabled !== true) {
    return Object.freeze({ code: 'disabled', authorized: false, memoryMutated: false });
  }
  return evaluate(await createSnapshot(), {
    enabled: true,
    provider: configured.provider,
    readCurrentVersion,
  });
}
