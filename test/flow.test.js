// One realistic sequence end to end, through the platform's own handler
// modules: a newcomer spams, gets deleted, another earns trust, an admin
// reverses a call, and the reversed user is left alone afterwards.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { fresh, respond, row, exec } from './helpers.js';
import { calls } from './telegram.js';
import { FakeJevClient } from './fakes/jev.js';
import onMessage from '../tgcloud/handlers/message.js';
import onCallbackQuery from '../tgcloud/handlers/callback_query.js';
import onPreCheckoutQuery from '../tgcloud/handlers/pre_checkout_query.js';
import onMyChatMember from '../tgcloud/handlers/my_chat_member.js';
import * as group from '../tgcloud/lib/handlers/group.js';
import * as billing from '../tgcloud/lib/storage/billing.js';
import * as chats from '../tgcloud/lib/storage/chats.js';
import * as trust from '../tgcloud/lib/storage/trust.js';
import { CHATTER, SCAM } from './fixtures.js';

const GROUP = -100123;
const LOG = -100999;
const SPAMMER = 555;
const REGULAR = 556;
const ADMIN = 777;
let members = 150;
let client;

beforeEach(() => {
  fresh();
  members = 150;
  client = new FakeJevClient({ 'buy crypto': SCAM }, { fallback: CHATTER });
  group.setClient(client);
  respond('getMe', { id: 1, is_bot: true, first_name: 'StopSpam', username: 'StopSpam_jev_bot' });
  respond('getChatMember', (p) => ([ADMIN, 1].includes(p.user_id)
    ? { status: 'administrator', can_delete_messages: true, user: { id: p.user_id, is_bot: false, first_name: 'Boss' } }
    : { status: 'member', user: { id: p.user_id, is_bot: false, first_name: 'Ann' } }));
  respond('getChatMemberCount', () => members);
  respond('createInvoiceLink', 'https://t.me/invoice/test');
});

function groupMessage(text, userId, messageId) {
  return { message_id: messageId, date: 1, chat: { id: GROUP, type: 'supergroup', title: 'Python Chat' },
    from: { id: userId, is_bot: false, first_name: 'Ann', username: 'ann' }, text };
}

const post = (text, userId, messageId) => onMessage(groupMessage(text, userId, messageId),
  { update: { update_id: messageId } });
const deletions = () => calls('deleteMessage');

async function activeGroup(count) {
  await chats.ensureChat(GROUP, 'Python Chat');
  await chats.updateChat(GROUP, { log_chat_id: LOG, mode: 'active', observe_until: '2020-01-01T00:00:00+00:00' });
  members = count;
}

// Opens the 14-day trial and pushes it into the past: an expired window must
// not reopen, which is exactly what these tests rely on.
async function burnTheTrial() {
  await billing.startGrace(GROUP);
  exec('UPDATE billing SET grace_until = ? WHERE chat_id = ?', '2020-01-01T00:00:00+00:00', GROUP);
}

// Review cards only: the billing notice also goes to LOG, but carries no
// rv: buttons.
const cardsSent = () => calls('sendMessage').filter((p) => p.chat_id === LOG && p.reply_markup
  && p.reply_markup.inline_keyboard.flat().some((b) => (b.callback_data || '').startsWith('rv:')));

function payment(updateId, chargeId, stars) {
  return { message_id: updateId, date: 1, chat: { id: ADMIN, type: 'private' },
    from: { id: ADMIN, is_bot: false, first_name: 'Boss' },
    successful_payment: { currency: 'XTR', total_amount: stars, invoice_payload: `sub:${GROUP}:${stars}`,
      telegram_payment_charge_id: chargeId, provider_payment_charge_id: 'p' } };
}

test('the full flow', async () => {
  await activeGroup(150);

  // 1. A newcomer posts a scam: deleted, card posted, author flagged.
  await post('buy crypto now', SPAMMER, 1);
  assert.equal(deletions().length, 1);
  assert.equal((await trust.get(GROUP, SPAMMER)).status, 'flagged');

  // 2. A different newcomer chats normally five times and becomes trusted.
  for (let i = 0; i < 5; i++) await post(`morning all ${i}`, REGULAR, 10 + i);
  assert.equal((await trust.get(GROUP, REGULAR)).status, 'trusted');

  // 3. The trusted member's plain messages no longer reach the API.
  let before = client.calls.length;
  await post('still here', REGULAR, 20);
  assert.equal(client.calls.length, before);

  // 4. An admin reverses the original call from the card.
  const reviewId = row('SELECT id FROM reviews WHERE chat_id = ? AND user_id = ?', GROUP, SPAMMER).id;
  await onCallbackQuery({ id: 'q', from: { id: ADMIN, is_bot: false, first_name: 'Boss' }, chat_instance: 'ci',
    message: { message_id: 9001, date: 1, chat: { id: LOG, type: 'supergroup' }, text: 'card' },
    data: `rv:ok:${reviewId}` }, { update: { update_id: 30 } });
  assert.equal((await trust.get(GROUP, SPAMMER)).status, 'allowlisted');

  // 5. The reversed user is now left alone even when posting the same text -
  // no deletion and no API call at all.
  const deletedBefore = deletions().length;
  before = client.calls.length;
  await post('buy crypto now', SPAMMER, 40);
  assert.equal(deletions().length, deletedBefore, 'an allowlisted user must never be acted upon');
  assert.equal(client.calls.length, before, 'an allowlisted user must never reach the API');
});

// The whole billing feature in one path: classified, carded, not deleted,
// sold to.
test('an unpaid large group reports spam without deleting it', async () => {
  await activeGroup(5000);
  await burnTheTrial();
  await post('buy crypto now', SPAMMER, 1);
  assert.deepEqual(deletions(), []);
  assert.equal(cardsSent().length, 1);
  assert.ok(cardsSent()[0].reply_markup.inline_keyboard.flat().some((b) => b.url),
    'the card must carry the subscribe button');
});

test('a large group inside its trial still deletes', async () => {
  await activeGroup(5000);
  await post('buy crypto now', SPAMMER, 1);
  assert.equal(deletions().length, 1);
  // A grace window is only opened for a paid tier, so this proves the count
  // was really read as LARGE.
  assert.notEqual((await billing.get(GROUP)).grace_until, null);
});

test('a small group deletes without ever paying', async () => {
  await activeGroup(150);
  await post('buy crypto now', SPAMMER, 1);
  assert.equal(deletions().length, 1);
});

test('paying turns deletion back on for the same message', async () => {
  await activeGroup(5000);
  await burnTheTrial();
  await post('buy crypto now', SPAMMER, 1);
  assert.deepEqual(deletions(), []);
  await onPreCheckoutQuery({ id: 'pcq', from: { id: ADMIN }, currency: 'XTR', total_amount: 250,
    invoice_payload: `sub:${GROUP}:250` }, { update: { update_id: 2 } });
  assert.equal(calls('answerPreCheckoutQuery')[0].ok, true);
  await onMessage(payment(2, 'ch_1', 250), { update: { update_id: 3 } });
  await post('buy crypto now', SPAMMER, 3);
  assert.equal(deletions().length, 1);
});

// Payment gates the action, never the judgment - and never the guard that
// admins are not acted upon.
test("an admin's message is untouched whatever the tier", async () => {
  await activeGroup(5000);
  await burnTheTrial();
  const before = client.calls.length;
  await post('buy crypto now', ADMIN, 1);
  assert.deepEqual(deletions(), []);
  assert.equal(client.calls.length, before, 'an admin must never reach the classifier');
});

test('adding the bot through the platform handler records the destination', async () => {
  await onMyChatMember({ chat: { id: GROUP, type: 'supergroup', title: 'G' },
    from: { id: ADMIN, is_bot: false, first_name: 'Boss' }, date: 1,
    old_chat_member: { status: 'left', user: { id: 1, is_bot: true, first_name: 'S' } },
    new_chat_member: { status: 'administrator', user: { id: 1, is_bot: true, first_name: 'S' } } },
  { update: { update_id: 1 } });
  assert.equal((await chats.getChat(GROUP)).log_chat_id, ADMIN);
});

// A bug must never make Telegram redeliver an update and repeat what already
// happened, so the platform handler swallows it after logging.
test('an exception inside a handler does not escape to the platform', async () => {
  group.setClient({ classify: () => { throw new TypeError('a bug'); } });
  await activeGroup(150);
  await post('buy crypto now', SPAMMER, 1);
});
