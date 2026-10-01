/** Run against local candidate tarballs only. All keys, records and HTTP responses are synthetic. */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGoodMemory, createInMemoryDocumentStore, createInMemorySessionStore } from 'goodmemory';
import { createMemoryDecisionSnapshot, evaluateMemoryDecisionShadow, memoryShadowContextVersion } from 'goodmemory/experimental/shadow';
import { loadConfiguredMemoryShadow, evaluateConfiguredMemoryShadow } from './configured-host.mjs';

const fakeKey = 'fake-config-fixture-key-never-a-real-credential';
const positive = 'I prefer coffee for breakfast.';
const withdrawal = 'I no longer prefer coffee for breakfast.';
const results = [];
const dir = await mkdtemp(join(tmpdir(), 'shadow-config-consumer-'));

async function fixture() {
  const backing = createInMemoryDocumentStore();
  let mutations = 0;
  const writes = new Set(['set', 'update', 'delete', 'deleteByFilter', 'writeBatch', 'writeBatchIfUnchanged']);
  const store = new Proxy(backing, { get(target, name) {
    const value = target[name];
    return typeof value !== 'function' ? value : (...args) => { if (writes.has(name)) mutations++; return value.apply(target, args); };
  } });
  const scope = { userId: 'synthetic-config-user', workspaceId: 'synthetic-config-workspace', sessionId: 'session' };
  const options = { adapters: { documentStore: store, sessionStore: createInMemorySessionStore() }, testing: { now: () => new Date('2026-10-01T00:00:00Z') } };
  const memory = createGoodMemory(options);
  await memory.remember({ scope, messages: [{ id: 'old', role: 'user', content: positive, observedAt: '2026-01-01T00:00:00Z' }] });
  const [record] = await store.query('preferences');
  assert.ok(record);
  async function context() {
    const current = await store.get('preferences', record.id);
    const evidence = (await store.query('evidence')).filter(entry => entry.linkedMemoryIds.includes(record.id));
    const ids = new Set(evidence.flatMap(entry => entry.sourceRecordIds ?? []));
    const sources = (await store.query('source_messages_v1')).filter(entry => ids.has(entry.id));
    return { record: current, evidence, sources };
  }
  const sourceOnly = createGoodMemory({ ...options, testing: { ...options.testing,
    extractor: { async extract() { return { candidates: [], ignoredMessageCount: 0 }; } },
  } });
  await sourceOnly.remember({ scope, messages: [{ id: 'new', role: 'user', content: withdrawal, observedAt: '2026-06-01T00:00:00Z' }] });
  const source = (await store.query('source_messages_v1')).find(entry => entry.sourceMessageId === 'new');
  const snapshot = createMemoryDecisionSnapshot({ scope, source, previous: await context(),
    candidate: { id: 'config-fixture', content: source.content, kindHint: 'preference' },
    span: { start: 0, end: source.content.length, attribution: 'direct_user' },
    allowedChoices: ['keep', 'supersede', 'abstain'], baseline: 'supersede' });
  return { snapshot, context, mutationCount: () => mutations };
}

try {
  for (const scenario of ['disabled', 'missing-key', 'blank-key', 'advised', 'abstain', 'http-failure', 'transport-failure', 'invalid-choice', 'timeout', 'stale']) {
    const configPath = join(dir, `${scenario}.json`);
    await writeFile(configPath, JSON.stringify({ memory: { shadow: { enabled: scenario !== 'disabled', apiKeyEnv: 'JEV_API_KEY', model: 'fixture-model', timeoutMs: 30, maxReplayRecords: 1 } } }));
    let keyReads = 0; let httpCalls = 0; let snapshots = 0; let versionReads = 0;
    const readEnv = name => { keyReads++; assert.equal(name, 'JEV_API_KEY'); return scenario === 'missing-key' ? undefined : scenario === 'blank-key' ? '  ' : fakeKey; };
    const fetch = async (_url, request) => {
      httpCalls++;
      assert.equal(request.headers.Authorization, `Bearer ${fakeKey}`);
      assert.equal(request.redirect, 'error');
      const body = JSON.parse(request.body);
      assert.equal(body.model, 'fixture-model');
      assert.equal(body.questions.next.type, 'choice');
      assert.equal(JSON.stringify(body).includes(fakeKey), false);
      if (scenario === 'http-failure') return new Response(fakeKey, { status: 401 });
      if (scenario === 'transport-failure') throw new Error(fakeKey);
      if (scenario === 'timeout') return new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error(fakeKey)), { once: true }));
      const keys = Object.keys(body.questions.next.criteria);
      const chosen = scenario === 'abstain' ? 'wait' : scenario === 'invalid-choice' ? 'delete-everything' : 'c1';
      return Response.json({ model: 'fixture-model', answers: { next: { type: 'choice', choice: chosen, confidence: 1,
        probabilities: Object.fromEntries(keys.map(key => [key, key === chosen ? 1 : 0])) } }, usage: { input_tokens: 1, output_tokens: 1 } });
    };
    let configured;
    try { configured = await loadConfiguredMemoryShadow({ configPath, readEnv, fetch }); }
    catch (error) {
      assert.ok(['missing-key', 'blank-key'].includes(scenario));
      assert.equal(error.code, 'shadow-key-unavailable');
      assert.equal(String(error).includes(fakeKey), false);
      assert.equal(error.cause, undefined);
      assert.equal(httpCalls, 0);
      results.push({ id: scenario, code: error.code, keyReads, httpCalls, mutations: 0 });
      continue;
    }
    assert.equal(JSON.stringify(configured).includes(fakeKey), false);
    const host = configured.enabled ? await fixture() : undefined;
    const before = host?.mutationCount() ?? 0;
    const report = await evaluateConfiguredMemoryShadow({ configured,
      createSnapshot: () => { snapshots++; return host.snapshot; },
      readCurrentVersion: async () => { versionReads++; return scenario === 'stale' ? 'changed-version' : memoryShadowContextVersion(await host.context()); },
      evaluate: evaluateMemoryDecisionShadow,
    });
    const expected = scenario === 'disabled' ? 'disabled' : scenario === 'stale' ? 'stale_version' : scenario === 'abstain' ? 'abstained' : scenario === 'advised' ? 'advised' : 'invalid_response';
    assert.equal(report.code, expected, scenario);
    assert.equal(report.authorized, false); assert.equal(report.memoryMutated, false);
    assert.equal((host?.mutationCount() ?? 0) - before, 0);
    assert.equal(JSON.stringify(report).includes(fakeKey), false);
    if (!configured.enabled) assert.deepEqual({ keyReads, httpCalls, snapshots, versionReads }, { keyReads: 0, httpCalls: 0, snapshots: 0, versionReads: 0 });
    if (scenario === 'stale') assert.equal(httpCalls, 0);
    for (const record of configured.enabled ? configured.provider.history : []) {
      assert.equal(record.dispatched, 0); assert.equal(record.journalEntries, 0);
      assert.equal(JSON.stringify(record).includes(fakeKey), false);
    }
    results.push({ id: scenario, code: report.code, keyReads, httpCalls, mutations: 0 });
  }
  console.log(JSON.stringify({ node: process.version, cases: results.length, passed: results.length, liveModelCalls: 0, results }, null, 2));
} finally { await rm(dir, { recursive: true, force: true }); }
