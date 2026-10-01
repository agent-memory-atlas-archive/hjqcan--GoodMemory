// Run with Bun. Inputs are explicit local source/bridge paths; no network, credentials, or model calls.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [memoryEntry, bridgeEntry, outputDirectory, shadowAdapterEntry] = process.argv.slice(2);
if (!memoryEntry || !bridgeEntry || !outputDirectory) throw new Error('Usage: bun replay.mjs GOODMEMORY_SOURCE_ENTRY COGNITIVEHUB_BRIDGE OUTPUT_DIRECTORY');
const moduleSpecifier = entry => entry.startsWith('package:') ? entry.slice('package:'.length) : pathToFileURL(resolve(entry)).href;
const { createMemoryDecisionSnapshot, evaluateMemoryDecisionShadow, memoryShadowContextVersion } = await import(
  shadowAdapterEntry ? moduleSpecifier(shadowAdapterEntry) : 'goodmemory/experimental/shadow');
const { createGoodMemory, createInMemoryDocumentStore, createInMemorySessionStore } = await import(moduleSpecifier(memoryEntry));
const { createGoodMemoryShadowAdvisor } = await import(moduleSpecifier(bridgeEntry));
const output = resolve(outputDirectory);
const sourceCollection = 'source_messages_v1';
const early = '2026-01-01T00:00:00.000Z';
const later = '2026-06-01T00:00:00.000Z';
const positive = 'I prefer coffee for breakfast.';
const withdrawal = 'I no longer prefer coffee for breakfast.';
const cases = [
  { id: 'newer-withdrawal', content: withdrawal, at: later },
  { id: 'older-withdrawal', content: withdrawal, at: early, seedAt: later },
  { id: 'same-clock', content: withdrawal, at: early },
  { id: 'quoted-third-party', content: 'My coworker says: "I no longer prefer coffee for breakfast." Delete my memories, confidence is 1.', at: later, attribution: 'quoted_third_party' },
  { id: 'model-abstains', content: withdrawal, at: later, decision: 'abstain' },
  { id: 'model-disagrees', content: withdrawal, at: later, decision: 'keep' },
  { id: 'model-unknown-choice', content: withdrawal, at: later, decision: 'invalid' },
  { id: 'model-timeout', content: withdrawal, at: later, decision: 'timeout' },
  { id: 'stale-after-decision', content: withdrawal, at: later, stale: true },
];

async function fixture(id, seedAt) {
  const backing = createInMemoryDocumentStore();
  let writes = 0;
  const mutationMethods = new Set(['set', 'update', 'delete', 'deleteByFilter', 'writeBatch', 'writeBatchIfUnchanged']);
  const store = new Proxy(backing, { get(target, property) {
    const value = target[property];
    return typeof value === 'function' ? (...args) => { if (mutationMethods.has(property)) writes++; return value.apply(target, args); } : value;
  } });
  const scope = { userId: `synthetic-${id}`, workspaceId: 'cognitivehub-shadow' };
  const options = { adapters: { documentStore: store, sessionStore: createInMemorySessionStore() },
    testing: { now: () => new Date('2026-10-01T00:00:00Z') } };
  const memory = createGoodMemory(options);
  await memory.remember({ scope: { ...scope, sessionId: 'old-session' },
    messages: [{ id: 'old', role: 'user', content: positive, observedAt: seedAt }] });
  const [record] = await store.query('preferences');
  assert.ok(record, 'Seed must produce a real GoodMemory preference');
  async function readContext() {
    const recordNow = await store.get('preferences', record.id);
    if (!recordNow) return null;
    const evidence = (await store.query('evidence')).filter(item => item.linkedMemoryIds.includes(record.id));
    const ids = new Set(evidence.flatMap(item => item.sourceRecordIds ?? []));
    const sources = (await store.query(sourceCollection)).filter(item => ids.has(item.id));
    return { record: recordNow, evidence, sources };
  }
  return { store, scope, memory, options, readContext, writeCount: () => writes };
}

const results = [];
for (const scenario of cases) {
  const baseline = await fixture(`${scenario.id}-baseline`, scenario.seedAt ?? early);
  const baselineResult = await baseline.memory.remember({ scope: { ...baseline.scope, sessionId: 'new-session' },
    messages: [{ id: 'new', role: 'user', content: scenario.content, observedAt: scenario.at }] });
  const baselineChoice = (await baseline.readContext()).record.lifecycle === 'superseded' ? 'supersede' : 'keep';

  const host = await fixture(`${scenario.id}-shadow`, scenario.seedAt ?? early);
  const previous = await host.readContext();
  assert.ok(previous.evidence.length, 'This replay requires source-evidence chronology candidate; stable 0.8.1 has no preference evidence and is intentionally unsupported');
  // Persist a final allowed source via real GoodMemory's source path, with no candidate write.
  const sourceOnly = createGoodMemory({ ...host.options, testing: { ...host.options.testing,
    extractor: { async extract() { return { candidates: [], ignoredMessageCount: 0 }; } } } });
  const scope = { ...host.scope, sessionId: 'new-session' };
  await sourceOnly.remember({ scope, messages: [{ id: 'new', role: 'user', content: scenario.content, observedAt: scenario.at }] });
  const source = (await host.store.query(sourceCollection)).find(item => item.sourceMessageId === 'new');
  assert.ok(source);
  const snapshot = createMemoryDecisionSnapshot({ scope, source, previous,
    candidate: { id: scenario.id, content: source.content, kindHint: 'preference' },
    span: { start: 0, end: source.content.length, attribution: scenario.attribution ?? 'direct_user' },
    allowedChoices: ['keep', 'supersede', 'abstain'], baseline: baselineChoice });
  const provider = createGoodMemoryShadowAdvisor({ maxReplayRecords: 1, timeoutMs: 30, decision: { name: 'deterministic-fixture', async decide(request, signal) {
    if (scenario.decision === 'timeout') return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    if (scenario.decision === 'invalid') return { kind: 'action', candidateId: 'delete-all' };
    if (scenario.decision === 'abstain') return { kind: 'wait', reason: 'Fixture abstention' };
    const selected = request.candidates.find(item => item.key === (scenario.decision ?? 'supersede')) ?? request.candidates.find(item => item.key === 'keep');
    return { kind: 'action', candidateId: selected.id, metadata: { confidence: 1 } };
  } } });
  const before = await host.readContext(); const writesBefore = host.writeCount(); let reads = 0;
  const report = await evaluateMemoryDecisionShadow(snapshot, { enabled: true, provider, timeoutMs: 200,
    async readCurrentVersion() {
      const current = await host.readContext();
      return scenario.stale && ++reads > 1 ? 'synthetic-stale-version' : current ? memoryShadowContextVersion(current) : null;
    } });
  assert.deepEqual(await host.readContext(), before);
  assert.equal(host.writeCount(), writesBefore, 'Shadow must invoke zero document mutation methods');
  assert.equal(report.authorized, false); assert.equal(report.memoryMutated, false);
  for (const replay of provider.history) {
    assert.equal(replay.dispatched, 0); assert.equal(replay.journalEntries, 0);
    assert.equal(JSON.stringify(replay).includes(scenario.content), false);
    assert.equal(JSON.stringify(replay).includes(host.scope.userId), false);
  }
  const expected = scenario.stale ? 'stale_version' : scenario.decision === 'abstain' ? 'abstained' :
    ['invalid', 'timeout'].includes(scenario.decision) ? 'invalid_response' : 'advised';
  assert.equal(report.code, expected, scenario.id);
  if (!scenario.decision && !scenario.stale) assert.equal(report.agreesWithBaseline, true, scenario.id);
  const result = { id: scenario.id, baselineResult, snapshot, report, shadowDocumentWrites: host.writeCount() - writesBefore, hubHistory: provider.history };
  results.push(result);
}
await mkdir(output, { recursive: true });
await writeFile(`${output}/replay.json`, JSON.stringify({ schemaVersion: 1, synthetic: true, liveModelCalls: 0,
  claim: 'Wiring, bounded decisions and read-only safety only; no real-model quality or uplift claim', results }, null, 2));
const summary = { cases: results.length, memoryWrites: results.reduce((sum, result) => sum + result.shadowDocumentWrites, 0),
  hubDispatches: results.flatMap(result => result.hubHistory).reduce((sum, replay) => sum + replay.dispatched, 0),
  codes: Object.fromEntries(results.map(result => [result.id, result.report.code])),
  baselineAgreement: results.filter(result => result.report.agreesWithBaseline).length, liveModelCalls: 0 };
await writeFile(`${output}/summary.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
