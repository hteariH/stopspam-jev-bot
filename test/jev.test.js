import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { fresh, scriptFetch, fetchCalls, response } from './helpers.js';
import { FakeJevClient } from './fakes/jev.js';
import { JevError, QUESTIONS, TypeSafeJevClient } from '../tgcloud/lib/core/jev.js';
import { KINDS } from '../tgcloud/lib/core/verdict.js';
import * as settings from '../tgcloud/lib/storage/settings.js';
import * as config from '../tgcloud/lib/config.js';
import { CHATTER, SCAM } from './fixtures.js';

beforeEach(fresh);

test('the questions cover the spec', () => {
  assert.deepEqual(Object.keys(QUESTIONS).sort(),
    ['is_scam', 'is_spam', 'kind', 'looks_like_member', 'severity', 'solicits_contact']);
});

test('kind offers every spec category', () => {
  assert.deepEqual(Object.keys(QUESTIONS.kind.criteria).sort(), [...KINDS].sort());
});

test('the severity rubric has three levels', () => {
  assert.equal(QUESTIONS.severity.criteria.length, 3);
});

test('the fake matches on a state substring and records calls', async () => {
  const client = new FakeJevClient({ 'buy crypto': SCAM }, { fallback: CHATTER });
  assert.equal(await client.classify('please buy crypto now'), SCAM);
  assert.equal(await client.classify('good morning everyone'), CHATTER);
  assert.deepEqual(client.calls, ['please buy crypto now', 'good morning everyone']);
});

test('the fake can simulate an outage', async () => {
  const client = new FakeJevClient({}, { fallback: CHATTER, fail: true });
  await assert.rejects(client.classify('hello'), JevError);
});

// --- TypeSafeJevClient ------------------------------------------------------

function wellFormed(overrides = {}) {
  return {
    is_spam: { type: 'noul', noul: 0.91 },
    is_scam: { type: 'noul', noul: 0.77 },
    solicits_contact: { type: 'noul', noul: 0.64 },
    looks_like_member: { type: 'noul', noul: 0.12 },
    kind: { type: 'choice', choice: 'phishing', confidence: 0.8, probabilities: {} },
    severity: { type: 'score', score: 2, confidence: 0.83, legend: {}, probabilities: {} },
    ...overrides,
  };
}

function answering(...responses) {
  const queue = [...responses];
  scriptFetch(async () => {
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next;
  });
}

const client = (extra = {}) => new TypeSafeJevClient({ apiKey: 'test-key', model: 'jev-1', timeout: 1.5, ...extra });

test('the constructor falls back to config', () => {
  const made = new TypeSafeJevClient({ apiKey: 'k' });
  assert.equal(made.model, config.JEV_MODEL);
  assert.equal(made.timeout, config.JEV_TIMEOUT);
});

test('a well-formed response maps onto every verdict field', async () => {
  answering(response(200, { model: 'jev-2026-01', usage: {}, answers: wellFormed() }));
  const v = await client().classify('# Message\nhello');
  assert.deepEqual({ ...v }, { is_spam: 0.91, is_scam: 0.77, solicits_contact: 0.64,
    looks_like_member: 0.12, kind: 'phishing', severity: 2, severity_confidence: 0.83, model: 'jev-2026-01' });
});

// The request is the one typesafe-sdk 0.7 sends, captured from it.
test('the request matches the Python SDK wire format', async () => {
  answering(response(200, { model: 'm', answers: wellFormed() }));
  await new TypeSafeJevClient({ apiKey: 'test-key' }).classify('STATE');
  const [call] = fetchCalls;
  assert.equal(call.url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.Authorization, 'Bearer test-key');
  assert.equal(call.init.headers['Content-Type'], 'application/json');
  const captured = readFileSync(new URL('./fixtures/systemone_request.json', import.meta.url), 'utf8').trim();
  assert.equal(call.init.body, captured);
});

test('the score is truncated to its level, as int() did', async () => {
  answering(response(200, { model: 'm', answers: wellFormed({ severity: { score: 1.7, confidence: 0.5 } }) }));
  assert.equal((await client().classify('s')).severity, 1);
});

test('a response with no model field is labelled jev', async () => {
  answering(response(200, { answers: wellFormed() }));
  assert.equal((await client().classify('s')).model, 'jev');
});

for (const [name, answers] of [
  ['a missing answer key', (() => { const a = wellFormed(); delete a.severity; return a; })()],
  ['an answer of the wrong shape', wellFormed({ is_spam: { probability: 0.9 } })],
  ['a non-numeric score', wellFormed({ severity: { score: 'high', confidence: 0.9 } })],
]) {
  test(`${name} raises JevError`, async () => {
    answering(response(200, { model: 'm', answers }));
    await assert.rejects(client().classify('s'), JevError);
  });
}

test('a response with no answers at all raises JevError', async () => {
  answering(response(200, {}));
  await assert.rejects(client().classify('s'), JevError);
});

test('a body that is not JSON raises JevError', async () => {
  answering(response(200, 'not json'));
  await assert.rejects(client().classify('s'), JevError);
});

test('a 4xx is not retried and becomes a JevError naming the status', async () => {
  answering(response(401, { detail: 'bad key' }), response(200, { answers: wellFormed() }));
  await assert.rejects(client().classify('s'), /HTTP 401/);
  assert.equal(fetchCalls.length, 1);
});

test('a 5xx is retried once and the retry can succeed', async () => {
  answering(response(503, 'busy'), response(200, { model: 'm', answers: wellFormed() }));
  assert.equal((await client().classify('s')).kind, 'phishing');
  assert.equal(fetchCalls.length, 2);
  assert.equal(fetchCalls[1].init.headers['X-TypeSafe-Retry-Count'], '1');
});

test('a 429 that persists becomes a JevError after one retry', async () => {
  answering(response(429, 'slow down'), response(429, 'slow down'));
  await assert.rejects(client().classify('s'), /HTTP 429/);
  assert.equal(fetchCalls.length, 2);
});

test('a network failure becomes a JevError', async () => {
  answering(new TypeError('fetch failed'), new TypeError('fetch failed'));
  await assert.rejects(client().classify('s'), /TypeSafeAPIConnectionError/);
});

test('a timeout becomes a JevError naming the budget', async () => {
  scriptFetch(() => new Promise(() => {}));
  await assert.rejects(client({ timeout: 0.05 }).classify('s'), /0\.05/);
});

test('the key is read from settings when none is given', async () => {
  await settings.set(settings.TYPESAFE_API_KEY, ' stored-key \n');
  answering(response(200, { model: 'm', answers: wellFormed() }));
  await new TypeSafeJevClient().classify('s');
  assert.equal(fetchCalls[0].init.headers.Authorization, 'Bearer stored-key');
});

// A missing key is the classifier being unavailable, not a crash.
test('a missing key is a JevError and makes no request', async () => {
  answering(response(200, { answers: wellFormed() }));
  await assert.rejects(new TypeSafeJevClient().classify('s'), /TYPESAFE_API_KEY is not set/);
  assert.equal(fetchCalls.length, 0);
});
