import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { fresh, logLines, respond, callsTo, telegramError } from './helpers.js';
import { FakeJevClient } from './fakes/jev.js';
import * as tiers from '../tgcloud/lib/core/tiers.js';
import * as pipeline from '../tgcloud/lib/core/pipeline.js';
import * as offer from '../tgcloud/lib/core/offer.js';
import { RateLimiter } from '../tgcloud/lib/core/ratelimit.js';
import { Action } from '../tgcloud/lib/core/policy.js';
import { MessageFacts } from '../tgcloud/lib/core/state.js';
import { makeBot } from '../tgcloud/lib/bot.js';
import { api } from './fakes/sdk.js';
import * as chats from '../tgcloud/lib/storage/chats.js';
import * as trust from '../tgcloud/lib/storage/trust.js';
import * as audit from '../tgcloud/lib/storage/audit.js';
import { _setNow } from '../tgcloud/lib/clock.js';
import { CHATTER, SCAM, UNSURE } from './fixtures.js';

beforeEach(fresh);

const ENTITLED = tiers.Entitlement({ tier: tiers.FREE, active: true, reason: 'free_tier', price: 0 });
const UNPAID = tiers.Entitlement({ tier: tiers.LARGE, active: false, reason: 'not_entitled', price: 250 });

function facts(overrides = {}) {
  return MessageFacts({ text: 'buy crypto now', link_domains: [], link_count: 0, has_invite_link: false,
    is_forward: false, media_type: null, is_caption: false, author_message_count: 0,
    author_days_in_group: 0.0, author_has_username: false, group_title: 'G', group_description: '',
    ...overrides });
}

async function activeChat(overrides = {}) {
  await chats.ensureChat(-100, 'G');
  return chats.updateChat(-100, { mode: 'active', observe_until: '2020-01-01T00:00:00+00:00', ...overrides });
}

async function trustRow() {
  await trust.seen(-100, 555);
  return trust.get(-100, 555);
}

async function run(client, { chat = null, messageFacts = null, isAdmin = false, canDelete = true,
  entitlement = ENTITLED } = {}) {
  return pipeline.evaluate(client, {
    chat: chat || await activeChat(),
    facts: messageFacts || facts(),
    trustRow: await trustRow(),
    isAdmin, canDelete, entitlement,
  });
}

test('an admin never reaches the API', async () => {
  const client = new FakeJevClient({}, { fallback: SCAM });
  const outcome = await run(client, { isAdmin: true });
  assert.equal(outcome.skipped, 'admin');
  assert.deepEqual(client.calls, []);
});

test('a scam from a newcomer is deleted', async () => {
  const outcome = await run(new FakeJevClient({ 'buy crypto': SCAM }));
  assert.equal(outcome.decision.action, Action.DELETE);
  assert.equal(outcome.verdict, SCAM);
});

test('a trusted member never reaches the API', async () => {
  await trust.seen(-100, 555);
  for (let i = 0; i < 5; i++) await trust.recordClean(-100, 555, 5);
  const client = new FakeJevClient({}, { fallback: CHATTER });
  const outcome = await pipeline.evaluate(client, { chat: await activeChat(), facts: facts({ text: 'morning all' }),
    trustRow: await trust.get(-100, 555), isAdmin: false, canDelete: true, entitlement: ENTITLED });
  assert.equal(outcome.skipped, 'trusted');
  assert.equal(outcome.decision, null);
  assert.deepEqual(client.calls, [], 'the gate must short-circuit before the API');
});

test('jev disabled for the chat skips the API', async () => {
  const client = new FakeJevClient({}, { fallback: SCAM });
  const outcome = await run(client, { chat: await activeChat({ jev_enabled: false }) });
  assert.equal(outcome.skipped, 'jev_disabled');
  assert.deepEqual(client.calls, []);
});

test('an outage never deletes', async () => {
  const outcome = await run(new FakeJevClient({}, { fail: true }));
  assert.equal(outcome.decision, null);
  assert.equal(outcome.skipped, 'jev_unavailable');
});

// The pipeline's half of "if it carried triggers it becomes a review card":
// a skip reason distinct from the silent one, and an audit row.
test('an outage with a trigger is marked for a human', async () => {
  const outcome = await run(new FakeJevClient({}, { fail: true }),
    { messageFacts: facts({ link_count: 1, link_domains: ['evil.example'] }) });
  assert.equal(outcome.skipped, pipeline.UNAVAILABLE_WITH_TRIGGER);
  assert.equal(outcome.decision, null, 'an outage never produces an action');
  const row = (await audit.recent(-100))[0];
  assert.equal(row.action, 'failed');
  assert.equal(row.reason, pipeline.UNAVAILABLE_WITH_TRIGGER);
});

test('an outage is audited', async () => {
  await run(new FakeJevClient({}, { fail: true }));
  const row = (await audit.recent(-100))[0];
  assert.equal(row.action, 'failed');
  assert.equal(row.reason, 'jev_unavailable');
});

test('an uncertain verdict is reviewed', async () => {
  assert.equal((await run(new FakeJevClient({ 'buy crypto': UNSURE }))).decision.action, Action.REVIEW);
});

test('observation mode downgrades to review', async () => {
  const outcome = await run(new FakeJevClient({ 'buy crypto': SCAM }),
    { chat: await activeChat({ observe_until: '2999-01-01T00:00:00+00:00' }) });
  assert.equal(outcome.decision.action, Action.REVIEW);
  assert.equal(outcome.decision.reason, 'observing');
});

test('a clean message builds trust', async () => {
  await run(new FakeJevClient({}, { fallback: CHATTER }), { messageFacts: facts({ text: 'morning all' }) });
  assert.equal((await trust.get(-100, 555)).clean_count, 1);
});

test('every evaluation is audited', async () => {
  await run(new FakeJevClient({ 'buy crypto': SCAM }));
  const row = (await audit.recent(-100))[0];
  assert.equal(row.action, 'delete');
  assert.equal(row.model, 'jev-test');
});

test('every successful classification logs its chat', async () => {
  await run(new FakeJevClient({}, { fallback: CHATTER }));
  const lines = logLines('stopspam.pipeline');
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes('jev call for chat -100 '));
});

test('the call log names the tier so free spend is visible', async () => {
  await run(new FakeJevClient({}, { fallback: CHATTER }), { entitlement: UNPAID });
  const line = logLines().find((l) => l.includes('jev call'));
  assert.ok(line.includes('tier=large'));
  assert.ok(line.includes('entitled=no'));
});

test('withheld enforcement is logged with its chat', async () => {
  const outcome = await run(new FakeJevClient({ 'buy crypto': SCAM }), { entitlement: UNPAID });
  assert.equal(outcome.decision.reason, 'not_entitled');
  assert.ok(logLines().some((l) => l.includes('enforcement withheld in chat -100')));
});

// Every call to TypeSafe produces one line naming its chat, whether it
// succeeded or failed - otherwise spend cannot be counted from the log.
test('a failed call still produces exactly one line for that chat', async () => {
  await run(new FakeJevClient({}, { fail: true }));
  const lines = logLines('stopspam.pipeline');
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes('jev unavailable for chat -100'));
});

// --- the rate limiter ---

test('the limiter refuses once the per-minute budget is spent', async () => {
  const limiter = new RateLimiter('t', 3);
  assert.deepEqual([await limiter.allow(1), await limiter.allow(1), await limiter.allow(1), await limiter.allow(1)],
    [true, true, true, false]);
});

// If the limiter tracked one shared window, the second chat would also be
// refused because chat 1 already spent it.
test('the budget is tracked per key, not globally', async () => {
  const limiter = new RateLimiter('t', 1);
  assert.equal(await limiter.allow(1), true);
  assert.equal(await limiter.allow(1), false);
  assert.equal(await limiter.allow(2), true);
});

test('limiters with different scopes do not share a budget', async () => {
  assert.equal(await new RateLimiter('a', 1).allow(1), true);
  assert.equal(await new RateLimiter('b', 1).allow(1), true);
  assert.equal(await new RateLimiter('a', 1).allow(1), false);
});

test('the window slides: an event exactly 60 s old still counts, an older one does not', async () => {
  const start = new Date(Date.UTC(2026, 0, 1));
  const limiter = new RateLimiter('t', 1);
  _setNow(start);
  assert.equal(await limiter.allow(1), true);
  _setNow(new Date(start.getTime() + 60000));
  assert.equal(await limiter.allow(1), false);
  _setNow(new Date(start.getTime() + 60001));
  assert.equal(await limiter.allow(1), true);
});

// --- offer ---

test('the invoice is a thirty-day Stars subscription', async () => {
  await offer.subscribeLink(makeBot(api), { chatId: -100123, title: 'My Group', stars: 50, lang: 'en' });
  const [call] = callsTo('createInvoiceLink');
  assert.equal(call.currency, 'XTR');
  assert.equal(call.subscription_period, 2592000);
  assert.deepEqual(call.prices.map((p) => p.amount), [50], 'Stars invoices must carry exactly one price');
});

test('the payload carries the chat and the price', async () => {
  await offer.subscribeLink(makeBot(api), { chatId: -100123, title: 'G', stars: 250, lang: 'en' });
  assert.equal(callsTo('createInvoiceLink')[0].payload, 'sub:-100123:250');
});

// Telegram rejects the whole call over these limits.
test('the title and description stay inside the Telegram limits', async () => {
  await offer.subscribeLink(makeBot(api), { chatId: -100123, title: 'G'.repeat(4000), stars: 50, lang: 'ru' });
  const [call] = callsTo('createInvoiceLink');
  assert.ok(call.title.length >= 1 && call.title.length <= 32);
  assert.ok(call.description.length >= 1 && call.description.length <= 255);
});

test('a Telegram failure returns null rather than raising', async () => {
  respond('createInvoiceLink', telegramError('nope'));
  assert.equal(await offer.subscribeLink(makeBot(api), { chatId: -1, title: 'G', stars: 50, lang: 'en' }), null);
});
