/** Clean installed-package fixture; all data and model responses are synthetic. */
import assert from 'node:assert/strict';
import { mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatEngine } from '@hjqcan/tachikoma-core';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai';
import { createGoodMemory } from 'goodmemory';
import { createMemoryDecisionSnapshot, evaluateMemoryDecisionShadow, memoryShadowContextVersion } from 'goodmemory/experimental/shadow';
import { loadConfiguredMemoryShadow, evaluateConfiguredMemoryShadow } from './configured-host.mjs';
const outputPath = process.argv[2];
if (!outputPath) throw new Error('Expected OUTPUT_DIRECTORY');
async function createFauxHarness() {
  const dataDir = await mkdtemp(join(tmpdir(), 'shadow-package-host-'));
  const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false, refreshOnCreate: false });
  const faux = fauxProvider({ provider: `shadow-faux-${crypto.randomUUID()}`, models: [{ id: 'chat', reasoning: true }] });
  modelRuntime.registerNativeProvider(faux.provider);
  return { dataDir, modelRuntime, faux, async cleanup() { await rm(dataDir, { recursive: true, force: true }); } };
}
async function send(session, content) {
  const events = [];
  for await (const event of session.send(content)) events.push(event);
  assert.ok(events.some(event => event.type === 'message_complete' && event.status === 'success'), JSON.stringify(events));
  assert.ok(events.some(event => event.type === 'memory_status' && event.phase === 'writeback' && event.status === 'ready'));
  return events.filter(event => event.type === 'memory_status');
}
const results = [];
for (const scenario of [
  {
    id: 'quoted-source-kept',
    content: 'My coworker says: "I no longer prefer coffee for breakfast."',
    attribution: 'quoted_third_party',
    expected: 'advised',
  },
  {
    id: 'actual-write-invalidates-shadow',
    content: 'I no longer prefer coffee for breakfast.',
    attribution: 'direct_user',
    expected: 'stale_version',
  },
]) {
  const harness = await createFauxHarness();
  const sessions = [];
  try {
    harness.faux.setResponses([
      fauxAssistantMessage('Acknowledged.'),
      fauxAssistantMessage('Acknowledged.'),
    ]);
    const userId = `synthetic-${scenario.id}`;
    const engine = new ChatEngine(
      {
        dataDir: harness.dataDir,
        model: { provider: harness.faux.provider.id, model: 'chat' },
        memory: { userId },
      },
      { modelRuntime: harness.modelRuntime }
    );
    const seed = await engine.createSession();
    sessions.push(seed);
    const seedEvents = await send(seed, 'I prefer coffee for breakfast.');
    await seed.close();
    const memory = createGoodMemory({ storage: { provider: 'sqlite', url: seed.memoryStatus.databasePath } });
    const before = await memory.exportMemory({ scope: { userId } });
    const record = before.durable.preferences.find((item) => item.lifecycle === 'active');
    assert.ok(record);
    const context = (exported) => {
      const current = exported.durable.preferences.find((item) => item.id === record.id);
      if (!current) return null;
      const evidence = exported.durable.evidence.filter((item) =>
        item.linkedMemoryIds.includes(record.id)
      );
      const ids = new Set(evidence.flatMap((item) => item.sourceRecordIds ?? []));
      return {
        record: current,
        evidence,
        sources: (exported.durable.sourceMessages ?? []).filter((item) => ids.has(item.id)),
      };
    };
    const previous = context(before);
    assert.ok(
      previous?.evidence.length,
      'Requires the explicit unpublished preference-evidence candidate fixture'
    );
    const next = await engine.createSession();
    sessions.push(next);
    const nextEvents = await send(next, scenario.content);
    await next.close();
    const after = await memory.exportMemory({ scope: { userId } });
    const source = after.durable.sourceMessages?.find(
      (item) => item.role === 'user' && item.content === scenario.content
    );
    assert.ok(source, 'Use the actual persisted, policy-safe ChatSession user source');
    const scope = {
      userId: source.userId,
      tenantId: source.tenantId,
      workspaceId: source.workspaceId,
      agentId: source.agentId,
      sessionId: source.sessionId,
    };
    const baseline =
      context(after)?.record.lifecycle === 'superseded' || !context(after) ? 'supersede' : 'keep';
    const snapshot = createMemoryDecisionSnapshot({
      scope,
      source,
      previous,
      candidate: { id: scenario.id, content: source.content, kindHint: 'preference' },
      span: { start: 0, end: source.content.length, attribution: scenario.attribution },
      allowedChoices: ['keep', 'supersede', 'abstain'],
      baseline,
    });
    let providerCalls = 0;
    const configPath = join(harness.dataDir, 'shadow.config.json');
    await writeFile(configPath, JSON.stringify({ memory: { shadow: {
      enabled: true, apiKeyEnv: 'JEV_API_KEY', model: 'fixture-model', maxReplayRecords: 1,
    } } }));
    const configured = await loadConfiguredMemoryShadow({ configPath,
      readEnv: name => { assert.equal(name, 'JEV_API_KEY'); return 'fake-host-key'; },
      fetch: async (_url, request) => {
        providerCalls++;
        assert.equal(request.headers.Authorization, 'Bearer fake-host-key');
        assert.equal(request.redirect, 'error');
        const body = JSON.parse(request.body);
        const keys = Object.keys(body.questions.next.criteria);
        assert.ok(keys.includes('c0'));
        return Response.json({ model: 'fixture-model', answers: { next: {
          type: 'choice', choice: 'c0', confidence: 1,
          probabilities: Object.fromEntries(keys.map(key => [key, key === 'c0' ? 1 : 0])),
        } }, usage: { input_tokens: 1, output_tokens: 1 } });
      },
    });
    assert.equal(configured.enabled, true);
    const provider = configured.provider;
    const report = await evaluateConfiguredMemoryShadow({
      configured,
      createSnapshot: () => snapshot,
      evaluate: evaluateMemoryDecisionShadow,
      async readCurrentVersion() {
        const current = context(await memory.exportMemory({ scope: { userId } }));
        return current ? memoryShadowContextVersion(current) : null;
      },
    });
    assert.equal(report.code, scenario.expected);
    assert.equal(report.authorized, false);
    assert.equal(report.memoryMutated, false);
    assert.deepEqual((await memory.exportMemory({ scope: { userId } })).durable, after.durable);
    assert.equal(providerCalls, scenario.expected === 'stale_version' ? 0 : 1);
    for (const replay of provider.history) {
      assert.equal(replay.dispatched, 0);
      assert.equal(replay.journalEntries, 0);
    }
    results.push({
      id: scenario.id,
      baseline,
      report,
      providerCalls,
      seedEvents,
      nextEvents,
      snapshot,
      hubHistory: provider.history,
    });
  } finally {
    for (const session of sessions) await session.close();
    await harness.cleanup();
  }
}
await mkdir(outputPath, { recursive: true });
await writeFile(
  `${outputPath}/tachikoma-replay.json`,
  JSON.stringify(
    {
      synthetic: true,
      sourcePackage: import.meta.resolve('goodmemory'),
      hostPackage: import.meta.resolve('@hjqcan/tachikoma-core'),
      adapterPackage: import.meta.resolve('goodmemory/experimental/shadow'),
      hubPackage: import.meta.resolve('@cognitive-hub/core/goodmemory-shadow'),
      liveModelCalls: 0,
      claim: 'Actual ChatSession wiring and read-only/stale safety only',
      results,
    },
    null,
    2
  )
);
console.log(
  JSON.stringify(
    {
      cases: results.length,
      passed: results.length,
      liveModelCalls: 0,
      outcomes: results.map((result) => ({
        id: result.id,
        code: result.report.code,
        providerCalls: result.providerCalls,
      })),
    },
    null,
    2
  )
);
