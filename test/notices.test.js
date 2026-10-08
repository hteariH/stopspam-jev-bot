import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { fresh, respond, callsTo, telegramError, api } from './helpers.js';
import * as notices from '../tgcloud/lib/core/notices.js';
import * as tiers from '../tgcloud/lib/core/tiers.js';
import * as billing from '../tgcloud/lib/storage/billing.js';
import * as chats from '../tgcloud/lib/storage/chats.js';
import { makeBot } from '../tgcloud/lib/bot.js';
import { stamp as toStamp, addSeconds } from '../tgcloud/lib/clock.js';

beforeEach(fresh);

const NOW = new Date(Date.UTC(2026, 8, 21, 12, 0, 0));
const stamp = (days) => toStamp(addSeconds(NOW, days * 86400));

function ent(reason, tier = tiers.LARGE) {
  return tiers.Entitlement({ tier, active: reason !== 'not_entitled', reason, price: 250 });
}

function next(entitlement, { graceUntil = null, notifiedStage = null, observing = false } = {}) {
  return notices.nextStage(entitlement, { graceUntil, notifiedStage, observing, now: NOW });
}

const sent = () => callsTo('sendMessage');

test('a fresh trial is announced', () => {
  assert.equal(next(ent('grace'), { graceUntil: stamp(14) }), notices.STAGE_GRACE);
});

test('a trial already announced is not announced again', () => {
  assert.equal(next(ent('grace'), { graceUntil: stamp(14), notifiedStage: notices.STAGE_GRACE }), null);
});

test('the end of the trial is warned about once', () => {
  assert.equal(next(ent('grace'), { graceUntil: stamp(2), notifiedStage: notices.STAGE_GRACE }),
    notices.STAGE_GRACE_ENDING);
  assert.equal(next(ent('grace'), { graceUntil: stamp(2), notifiedStage: notices.STAGE_GRACE_ENDING }), null);
});

// A chat that paid and lapsed never had a grace stage recorded.
test('losing entitlement is announced even with no trial before it', () => {
  assert.equal(next(ent('not_entitled')), notices.STAGE_LAPSED);
});

// Otherwise a chat oscillating around the threshold re-announces its trial
// every time it dips back.
test('stages only move forward', () => {
  assert.equal(next(ent('grace'), { graceUntil: stamp(14), notifiedStage: notices.STAGE_LAPSED }), null);
});

test('a paid chat is told nothing', () => {
  assert.equal(next(ent('subscribed')), null);
});

test('a free chat is told nothing', () => {
  assert.equal(next(ent('free_tier', tiers.FREE)), null);
});

test('an unknown recorded stage does not block a notice', () => {
  assert.equal(next(ent('not_entitled'), { notifiedStage: 'something_else' }), notices.STAGE_LAPSED);
});

async function graceChat(title = 'G', logChatId = 999) {
  await chats.ensureChat(-100123, title);
  if (logChatId !== null) await chats.updateChat(-100123, { log_chat_id: logChatId });
  await billing.startGrace(-100123);
  return chats.getChat(-100123);
}

async function notify(chat, entitlement = ent('grace'), observing = false) {
  await notices.maybeNotify(makeBot(api), { chat, row: await billing.get(-100123), entitlement, observing });
}

test('a notice is sent once and the stage is recorded', async () => {
  const chat = await graceChat();
  await notify(chat);
  assert.equal(sent().length, 1);
  assert.equal(sent()[0].chat_id, 999);
  assert.equal(sent()[0].parse_mode, 'HTML');
  assert.ok(sent()[0].reply_markup.inline_keyboard[0][0].url);
  assert.equal((await billing.get(-100123)).notified_stage, notices.STAGE_GRACE);
  await notify(chat);
  assert.equal(sent().length, 1);
});

// Otherwise the stage advances against a notice nobody received.
test('a chat with nowhere to send records no stage', async () => {
  const chat = await graceChat('G', null);
  await notify(chat);
  assert.deepEqual(sent(), []);
  assert.equal((await billing.get(-100123)).notified_stage, null);
});

test('a Telegram failure records no stage either', async () => {
  const chat = await graceChat();
  respond('sendMessage', telegramError('boom'));
  await notify(chat);
  assert.equal((await billing.get(-100123)).notified_stage, null);
});

// A brand-new large group reads as not_entitled on its very first message.
// Announcing that as "the subscription has ended" would also block every
// later notice, since stages only move forward.
test('a chat inside its observation window is told nothing', () => {
  assert.equal(next(ent('not_entitled'), { observing: true }), null);
});

test('observation silences the trial notices too', () => {
  assert.equal(next(ent('grace'), { graceUntil: stamp(14), observing: true }), null);
});

test('an observing chat records no stage at all', async () => {
  await chats.ensureChat(-100123, 'Big New Group');
  await chats.updateChat(-100123, { log_chat_id: 999 });
  await notify(await chats.getChat(-100123), ent('not_entitled'), true);
  assert.deepEqual(sent(), []);
  assert.equal((await billing.get(-100123)).notified_stage, null);
});

// A group named "Dogs & Cats" would otherwise fail its billing notice
// deterministically, forever.
test('the notice escapes a group title Telegram would reject', async () => {
  const chat = await graceChat('Dogs & Cats <b>');
  await notify(chat);
  assert.equal(sent().length, 1, 'the notice was not sent at all');
  const body = sent()[0].text;
  assert.ok(body.includes('Dogs &amp; Cats &lt;b&gt;'));
  assert.ok(!body.includes('Dogs & Cats'), 'raw ampersand left in an HTML send');
  assert.equal((await billing.get(-100123)).notified_stage, notices.STAGE_GRACE);
});
