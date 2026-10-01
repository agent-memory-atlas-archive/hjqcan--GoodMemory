import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createMemoryDecisionSnapshot, evaluateMemoryDecisionShadow } from 'goodmemory/experimental/shadow';
const source = (id, content, at) => ({ id, schemaVersion: 1, userId: 'synthetic-consumer', role: 'user', content,
  observedAt: at, ingestedAt: '2026-10-01T00:00:00Z', contentSha256: createHash('sha256').update(content).digest('hex') });
const old = source('old', 'I prefer tea.', '2026-01-01T00:00:00Z');
const next = source('next', 'I now prefer coffee.', '2026-06-01T00:00:00Z');
const snapshot = createMemoryDecisionSnapshot({ scope: { userId: 'synthetic-consumer' },
  candidate: { id: 'candidate', content: next.content, kindHint: 'preference' }, source: next,
  span: { start: 0, end: next.content.length, attribution: 'direct_user' }, allowedChoices: ['keep', 'supersede', 'abstain'], baseline: 'keep',
  previous: { record: { id: 'pref', userId: 'synthetic-consumer', category: 'beverage', value: 'tea', confidence: 1,
    source: { method: 'explicit', extractedAt: old.ingestedAt }, evidenceCount: 1, updatedAt: old.ingestedAt },
    sources: [old], evidence: [{ id: 'evidence', userId: 'synthetic-consumer', kind: 'conversation_excerpt', excerpt: old.content,
      source: { method: 'explicit', extractedAt: old.ingestedAt }, sourceMessageIds: [], sourceRecordIds: ['old'], linkedMemoryIds: ['pref'], linkedArchiveIds: [], createdAt: old.ingestedAt }] } });
let calls = 0;
const provider = { name: 'offline-fixture', async advise(request) { calls++; assert.equal('baseline' in request, false);
  return { choice: 'keep', evidenceSourceRecordIds: ['next'] }; } };
const readCurrentVersion = async () => snapshot.previousVersion;
assert.equal((await evaluateMemoryDecisionShadow(snapshot, { provider, readCurrentVersion })).code, 'disabled');
assert.equal(calls, 0);
const result = await evaluateMemoryDecisionShadow(snapshot, { enabled: true, provider, readCurrentVersion });
assert.equal(result.code, 'advised'); assert.equal(result.authorized, false); assert.equal(result.memoryMutated, false);
assert.equal((await evaluateMemoryDecisionShadow(snapshot, { enabled: true, provider, async readCurrentVersion() { return null; } })).code, 'stale_version');
assert.equal((await evaluateMemoryDecisionShadow(snapshot, { enabled: true, readCurrentVersion,
  provider: { name: 'abstain', async advise() { return { choice: 'abstain', evidenceSourceRecordIds: [] }; } } })).code, 'abstained');
assert.equal((await evaluateMemoryDecisionShadow(snapshot, { enabled: true, readCurrentVersion,
  provider: { name: 'invalid', async advise() { return { choice: 'delete', evidenceSourceRecordIds: ['next'] }; } } })).code, 'invalid_response');
console.log(JSON.stringify({ node: process.version, disabled: true, stale: true, abstain: true, invalid: true, authorized: false, memoryMutated: false }));
