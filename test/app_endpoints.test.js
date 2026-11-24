import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { fresh, respond, rows } from './helpers.js';
import { calls } from './telegram.js';
import appChats from '../tgcloud/endpoints/app_chats.js';
import appChat from '../tgcloud/endpoints/app_chat.js';
import appUpdate from '../tgcloud/endpoints/app_update.js';
import { APP_PER_MINUTE } from '../tgcloud/lib/app_chat.js';
import { CHATS_PER_MINUTE } from '../tgcloud/lib/core/admins.js';
import * as chats from '../tgcloud/lib/storage/chats.js';
import * as billing from '../tgcloud/lib/storage/billing.js';
import * as trust from '../tgcloud/lib/storage/trust.js';
import { addDays, now, stamp } from '../tgcloud/lib/clock.js';

const GROUP = -100123;
const ADMIN = 777;
const BYSTANDER = 888;
const as = (id) => ({ initData: { user: { id } } });

async function refusal(promise) {
  try { await promise; } catch (e) { return e.parameters && e.parameters.code; }
  return null;
}

beforeEach(async () => {
  fresh();
  await chats.ensureChat(GROUP, 'Python Chat');
  await trust.seen(GROUP, ADMIN);
  respond('getChatMember', (p) => ({ status: p.user_id === ADMIN ? 'administrator' : 'member' }));
});

test('app_chats lists the chats the caller administers', async () => {
  const result = await appChats({}, as(ADMIN));
  assert.deepEqual(result.chats.map((c) => [c.chat_id, c.title, c.plan]), [[GROUP, 'Python Chat', 'free']]);
});

test('app_chats is rate-limited per user', async () => {
  for (let i = 0; i < CHATS_PER_MINUTE; i++) await appChats({}, as(ADMIN));
  assert.equal(await refusal(appChats({}, as(ADMIN))), 'RATE_LIMITED');
  assert.equal(await refusal(appChats({}, as(BYSTANDER))), null);
});

test('app_chat returns the full view to an admin', async () => {
  const view = await appChat({ chat_id: GROUP }, as(ADMIN));
  assert.equal(view.title, 'Python Chat');
  assert.equal(view.delete_threshold, 0.9);
  assert.deepEqual(view.cards, { kind: 'unset', id: null });
});

test('a non-admin learns nothing, not even whether the chat is known', async () => {
  assert.equal(await refusal(appChat({ chat_id: GROUP }, as(BYSTANDER))), 'NOT_ADMIN');
  assert.equal(await refusal(appChat({ chat_id: -555 }, as(BYSTANDER))), 'NOT_ADMIN');
  assert.equal(await refusal(appUpdate({ chat_id: GROUP, fields: { jev_enabled: false } }, as(BYSTANDER))), 'NOT_ADMIN');
  assert.equal((await chats.getChat(GROUP)).jev_enabled, true);
});

test('an admin of a chat the bot has no row for gets NOT_FOUND', async () => {
  assert.equal(await refusal(appChat({ chat_id: -555 }, as(ADMIN))), 'NOT_FOUND');
  assert.equal(await refusal(appUpdate({ chat_id: -555, fields: { lang: 'ru' } }, as(ADMIN))), 'NOT_FOUND');
});

test('a failed admin lookup fails closed', async () => {
  respond('getChatMember', () => { throw new Error('telegram down'); });
  assert.equal(await refusal(appChat({ chat_id: GROUP }, as(ADMIN))), 'NOT_ADMIN');
});

test('invalid chat_id is refused before calling Telegram', async () => {
  assert.equal(await refusal(appChat({ chat_id: 123 }, as(ADMIN))), 'INVALID');
  assert.equal(await refusal(appUpdate({ chat_id: 'bad', fields: { lang: 'ru' } }, as(ADMIN))), 'INVALID');
  assert.deepEqual(calls('getChatMember'), []);
});

test('app_update writes the change and returns the new view', async () => {
  const view = await appUpdate({ chat_id: GROUP, fields: { delete_threshold: 0.8, lang: 'ru' } }, as(ADMIN));
  assert.equal(view.delete_threshold, 0.8);
  assert.equal(view.lang, 'ru');
  assert.equal((await chats.getChat(GROUP)).delete_threshold, 0.8);
});

test('an invalid update writes nothing', async () => {
  const before = await chats.getChat(GROUP);
  assert.equal(await refusal(appUpdate({ chat_id: GROUP, fields: { lang: 'ru', review_threshold: 0.95 } }, as(ADMIN))), 'INVALID');
  assert.equal(await refusal(appUpdate({ chat_id: GROUP, fields: { log_chat_id: 1 } }, as(ADMIN))), 'INVALID');
  assert.deepEqual(await chats.getChat(GROUP), before);
});

test('log_to_me points the cards at the caller', async () => {
  const view = await appUpdate({ chat_id: GROUP, fields: { log_to_me: true } }, as(ADMIN));
  assert.deepEqual(view.cards, { kind: 'me', id: ADMIN });
  assert.equal((await chats.getChat(GROUP)).log_chat_id, ADMIN);
});

test('end_observe ends the observation window', async () => {
  const view = await appUpdate({ chat_id: GROUP, fields: { end_observe: true } }, as(ADMIN));
  assert.equal(view.mode, 'active');
  assert.equal(view.observing, false);
});

test('the subscribe link is offered exactly when the plan allows it', async () => {
  assert.equal((await appChat({ chat_id: GROUP }, as(ADMIN))).subscribe_url, null);
  assert.deepEqual(calls('createInvoiceLink'), []);

  await billing.setMemberCount(GROUP, 640);
  const noneView = await appChat({ chat_id: GROUP }, as(ADMIN));
  assert.ok(noneView.subscribe_url);
  assert.ok(noneView.subscribe_stars > 0);

  await billing.startGrace(GROUP);
  const graceView = await appChat({ chat_id: GROUP }, as(ADMIN));
  assert.equal(graceView.plan.kind, 'grace');
  assert.ok(graceView.subscribe_url);
  assert.ok(graceView.subscribe_stars > 0);

  const countBeforeSubscribed = calls('createInvoiceLink').length;
  await billing.recordPayment({
    chargeId: 'ch_1',
    chatId: GROUP,
    payerUserId: ADMIN,
    stars: graceView.subscribe_stars,
    isRecurring: true,
    expiresAt: stamp(addDays(now(), 30)),
  });
  const paidView = await appChat({ chat_id: GROUP }, as(ADMIN));
  assert.equal(paidView.plan.kind, 'subscribed');
  assert.equal(paidView.subscribe_url, null);
  assert.equal(paidView.subscribe_stars, null);
  assert.equal(calls('createInvoiceLink').length, countBeforeSubscribed);
});

test('app_chat and app_update share a per-user budget', async () => {
  for (let i = 0; i < APP_PER_MINUTE; i++) await appChat({ chat_id: GROUP }, as(ADMIN));
  assert.equal(await refusal(appUpdate({ chat_id: GROUP, fields: { lang: 'ru' } }, as(ADMIN))), 'RATE_LIMITED');
  assert.equal(rows('SELECT lang FROM chats')[0].lang, 'en');
  assert.equal(await refusal(appChat({ chat_id: GROUP }, as(BYSTANDER))), 'NOT_ADMIN');
});
