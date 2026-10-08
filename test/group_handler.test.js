import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { fresh, rows, exec, failNext } from './helpers.js';
import { FakeJevClient } from './fakes/jev.js';
import {
  installTelegram, world, bot, calls, deletions, cardsTo, groupMessage, command,
  GROUP, SPAMMER, LOG, UNREACHABLE_LOG, ADMIN, MODCHAT,
} from './telegram.js';
import { dispatchMessage, dispatchMyChatMember } from '../tgcloud/lib/dispatch.js';
import * as group from '../tgcloud/lib/handlers/group.js';
import * as tiers from '../tgcloud/lib/core/tiers.js';
import * as notices from '../tgcloud/lib/core/notices.js';
import * as chats from '../tgcloud/lib/storage/chats.js';
import * as billing from '../tgcloud/lib/storage/billing.js';
import { CHATTER, SCAM } from './fixtures.js';

beforeEach(() => {
  fresh();
  installTelegram();
});

async function feed(message, client, { active = true, logChat = LOG } = {}) {
  await chats.ensureChat(GROUP, 'Python Chat');
  await chats.updateChat(GROUP, {
    log_chat_id: logChat,
    mode: active ? 'active' : 'observe',
    observe_until: active ? '2020-01-01T00:00:00+00:00' : '2999-01-01T00:00:00+00:00',
  });
  group.setClient(client);
  await dispatchMessage(message, bot());
}

const auditRows = () => rows('SELECT * FROM audit WHERE chat_id = ?', GROUP);

test('a scam is deleted and logged', async () => {
  await feed(groupMessage('buy crypto now'), new FakeJevClient({ 'buy crypto': SCAM }));
  assert.equal(deletions().length, 1);
  assert.equal(deletions()[0].message_id, 1);
  assert.ok(cardsTo(LOG).length, 'a deletion is still reported to the log chat');
  assert.equal(cardsTo(LOG)[0].parse_mode, 'HTML');
});

test('an ordinary message is left alone', async () => {
  await feed(groupMessage('morning all'), new FakeJevClient({}, { fallback: CHATTER }));
  assert.deepEqual(deletions(), []);
  assert.deepEqual(cardsTo(LOG), []);
});

test('observation mode reports without deleting', async () => {
  await feed(groupMessage('buy crypto now'), new FakeJevClient({ 'buy crypto': SCAM }), { active: false });
  assert.deepEqual(deletions(), []);
  assert.ok(cardsTo(LOG).length, 'observation mode still shows admins what it would have done');
});

test('an admin message is never checked', async () => {
  const client = new FakeJevClient({}, { fallback: SCAM });
  await feed(groupMessage('buy crypto now', { userId: ADMIN, messageId: 2 }), client);
  assert.deepEqual(deletions(), []);
  assert.deepEqual(client.calls, []);
});

// A message with no link, forward or media caption is left alone in silence
// during an outage; the audit row proves the handler ran it all the way
// through rather than raising early.
test('an outage on a plain message says nothing', async () => {
  await feed(groupMessage('buy crypto now'), new FakeJevClient({}, { fail: true }));
  assert.deepEqual(deletions(), []);
  assert.deepEqual(cardsTo(LOG), []);
  const audit = auditRows();
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, 'failed');
  assert.equal(audit[0].reason, 'jev_unavailable');
});

test('a review row is created for the card', async () => {
  await feed(groupMessage('buy crypto now'), new FakeJevClient({ 'buy crypto': SCAM }));
  const reviews = rows('SELECT * FROM reviews');
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].text, 'buy crypto now');
});

// A transient getChatMember failure must not downgrade a possible admin to
// an ordinary member for this message.
test('a failed admin lookup never acts on a possible admin', async () => {
  world.unreachable.add(SPAMMER);
  const client = new FakeJevClient({ 'buy crypto': SCAM });
  await feed(groupMessage('buy crypto now'), client);
  assert.deepEqual(deletions(), [], 'a user whose admin status is unknown is not acted upon');
  assert.deepEqual(cardsTo(LOG), []);
  assert.deepEqual(client.calls, [], 'an unknown admin status costs no classifier call either');
});

test('a reachable lookup still acts', async () => {
  const client = new FakeJevClient({ 'buy crypto': SCAM });
  await feed(groupMessage('buy crypto now'), client);
  assert.equal(deletions().length, 1);
  assert.ok(client.calls.length);
});

function membership(chatId, adder, { left = false } = {}) {
  const member = { id: 1, is_bot: true, first_name: 'StopSpam' };
  return {
    chat: { id: chatId, type: 'supergroup', title: 'Python Chat' },
    from: { id: adder, is_bot: false, first_name: 'Boss' },
    date: 1,
    old_chat_member: { user: member, status: 'left' },
    new_chat_member: left ? { user: member, status: 'left' } : { user: member, status: 'member' },
  };
}

// With no destination set the old code fell back to the group itself and
// republished the message it had just deleted, with buttons every member
// could press.
test('a card is never posted into the moderated group', async () => {
  await feed(groupMessage('buy crypto now'), new FakeJevClient({ 'buy crypto': SCAM }), { logChat: null });
  assert.deepEqual(cardsTo(GROUP), [], 'the moderated group is never a card destination');
  assert.equal(deletions().length, 1, 'the deletion itself still happens');
});

test('a destination equal to the group is refused', async () => {
  await feed(groupMessage('buy crypto now'), new FakeJevClient({ 'buy crypto': SCAM }), { logChat: GROUP });
  assert.deepEqual(cardsTo(GROUP), []);
});

// An audit row saying "reviewed" would claim a human saw a message nobody saw.
test('an undelivered card is audited as degraded, not reviewed', async () => {
  await feed(groupMessage('buy crypto now'), new FakeJevClient({ 'buy crypto': SCAM }),
    { active: false, logChat: null });
  assert.deepEqual(deletions(), []);
  const enforcement = auditRows().filter((r) => r.action !== 'review');
  assert.deepEqual(enforcement.map((r) => r.action), ['degraded']);
  assert.ok(enforcement[0].reason.includes('card_undelivered'));
});

test('a delivered card is still audited as reviewed', async () => {
  await feed(groupMessage('buy crypto now'), new FakeJevClient({ 'buy crypto': SCAM }), { active: false });
  assert.ok(cardsTo(LOG).length);
  assert.ok(auditRows().map((r) => r.action).includes('reviewed'));
});

test('adding the bot records the adder as the destination', async () => {
  await dispatchMyChatMember(membership(GROUP, ADMIN), bot());
  assert.equal((await chats.getChat(GROUP)).log_chat_id, ADMIN);
});

test('the bot leaving records nothing', async () => {
  await dispatchMyChatMember(membership(GROUP, ADMIN, { left: true }), bot());
  assert.equal(await chats.getChat(GROUP), null);
});

test('an existing destination survives the bot being re-added', async () => {
  await chats.ensureChat(GROUP, 'Python Chat');
  await chats.updateChat(GROUP, { log_chat_id: MODCHAT });
  await dispatchMyChatMember(membership(GROUP, ADMIN), bot());
  assert.equal((await chats.getChat(GROUP)).log_chat_id, MODCHAT);
});

test('a membership change in a private chat is ignored', async () => {
  await dispatchMyChatMember({ ...membership(ADMIN, ADMIN), chat: { id: ADMIN, type: 'private' } }, bot());
  assert.equal(await chats.getChat(ADMIN), null);
});

test('setlog points the caller\'s groups at this chat', async () => {
  await chats.ensureChat(GROUP, 'Python Chat');
  await chats.updateChat(GROUP, { log_chat_id: ADMIN });
  await chats.ensureChat(MODCHAT, 'Mod Room');
  await dispatchMessage(command('/setlog', MODCHAT, ADMIN), bot());
  assert.equal((await chats.getChat(GROUP)).log_chat_id, MODCHAT);
});

test('setlog addressed to this bot by name still works, to another bot does not', async () => {
  await chats.ensureChat(GROUP, 'Python Chat');
  await chats.updateChat(GROUP, { log_chat_id: ADMIN });
  group.setClient(new FakeJevClient({}, { fallback: CHATTER }));
  await dispatchMessage(command('/setlog@OtherBot', MODCHAT, ADMIN), bot());
  assert.equal((await chats.getChat(GROUP)).log_chat_id, ADMIN);
  await dispatchMessage(command('/setlog@stopspam_JEV_bot', MODCHAT, ADMIN), bot());
  assert.equal((await chats.getChat(GROUP)).log_chat_id, MODCHAT);
});

// Run in the moderated group itself, /setlog must not aim that group's cards
// at that group.
test('setlog never makes a chat its own destination', async () => {
  await chats.ensureChat(GROUP, 'Python Chat');
  await chats.updateChat(GROUP, { log_chat_id: ADMIN });
  await dispatchMessage(command('/setlog', GROUP, ADMIN), bot());
  assert.equal((await chats.getChat(GROUP)).log_chat_id, ADMIN);
});

// Without the check on the destination chat a caller could dump GROUP's
// cards into a room GROUP's admins do not control.
test('setlog needs admin rights in the destination chat too', async () => {
  await chats.ensureChat(GROUP, 'Python Chat');
  await chats.updateChat(GROUP, { log_chat_id: ADMIN });
  await chats.ensureChat(MODCHAT, 'Mod Room');
  world.plainMembers.add(`${MODCHAT}:${ADMIN}`);
  await dispatchMessage(command('/setlog', MODCHAT, ADMIN), bot());
  assert.equal((await chats.getChat(GROUP)).log_chat_id, ADMIN);
  assert.ok(cardsTo(MODCHAT).length, 'the refusal is said out loud, not swallowed');
  assert.ok(cardsTo(MODCHAT).at(-1).text.includes('Only an admin'));
});

test('setlog only moves chats the caller administers', async () => {
  await chats.ensureChat(GROUP, 'Python Chat');
  await chats.updateChat(GROUP, { log_chat_id: ADMIN });
  await chats.ensureChat(MODCHAT, 'Mod Room');
  world.plainMembers.add(`${GROUP}:${ADMIN}`);
  await dispatchMessage(command('/setlog', MODCHAT, ADMIN), bot());
  assert.equal((await chats.getChat(GROUP)).log_chat_id, ADMIN);
});

test('setlog does not reach the classifier', async () => {
  await chats.ensureChat(MODCHAT, 'Mod Room');
  const client = new FakeJevClient({}, { fallback: SCAM });
  group.setClient(client);
  await dispatchMessage(command('/setlog', MODCHAT, ADMIN), bot());
  assert.deepEqual(client.calls, []);
});

test('setlog is rate-limited per user', async () => {
  await chats.ensureChat(MODCHAT, 'Mod Room');
  for (let i = 0; i < 3; i++) await dispatchMessage(command('/setlog', MODCHAT, ADMIN), bot());
  assert.ok(cardsTo(MODCHAT).at(-1).text.toLowerCase().includes('too many'));
});

// During an outage a message that carried triggers still reaches a human.
test('an outage on a trigger-bearing message reaches a human', async () => {
  await feed(groupMessage('look at https://evil.example/free'), new FakeJevClient({}, { fail: true }));
  const sent = cardsTo(LOG);
  assert.ok(sent.length, 'a trigger-bearing message left unchecked is reported');
  assert.deepEqual(deletions(), [], 'an outage never deletes');
  assert.equal(sent.at(-1).reply_markup, undefined, 'no verdict behind it and nothing to reverse, so no buttons');
  const body = sent.at(-1).text;
  assert.ok(body.includes('Not checked'));
  assert.ok(body.includes('evil.example'), 'an admin must be able to find the message');
  assert.ok(body.includes(String(SPAMMER)));
});

test('an outage notice is never posted into the moderated group', async () => {
  await feed(groupMessage('look at https://evil.example/free'), new FakeJevClient({}, { fail: true }), { logChat: null });
  assert.deepEqual(cardsTo(GROUP), []);
});

function serviceMessage(extra) {
  return { message_id: 55, date: 1, chat: { id: GROUP, type: 'supergroup', title: 'Python Chat' },
    from: { id: SPAMMER, is_bot: false, first_name: 'Ann' }, ...extra };
}

// The gate returns low_history for anyone new - so a join would otherwise
// cost a Jev call asking whether nothing is spam, plus two getChatMember
// calls.
test('a join costs no classifier call', async () => {
  const client = new FakeJevClient({}, { fallback: CHATTER });
  await feed(serviceMessage({ new_chat_members: [{ id: SPAMMER, is_bot: false, first_name: 'Ann' }] }), client);
  assert.deepEqual(client.calls, [], 'there is nothing in a join to classify');
  assert.deepEqual(calls('getChatMember'), []);
});

test('a captionless photo costs no classifier call', async () => {
  const client = new FakeJevClient({}, { fallback: CHATTER });
  await feed(serviceMessage({ photo: [] }), client);
  assert.deepEqual(client.calls, []);
});

// Media is judged by its caption, per the spec.
test('a captioned photo is still checked', async () => {
  const client = new FakeJevClient({ 'buy crypto': SCAM });
  await feed(serviceMessage({ message_id: 56, caption: 'buy crypto now', photo: [] }), client);
  assert.ok(client.calls.length, 'a caption is the message, and must still be checked');
  assert.equal(deletions().length, 1);
});

// A decision already made must reach Telegram when the database fails. The
// review row only decides whether the card can carry buttons.
test('a confident deletion survives a locked review table', async () => {
  await chats.ensureChat(GROUP, 'Python Chat');
  failNext(1, /INSERT INTO reviews/);
  await feed(groupMessage('buy crypto now'), new FakeJevClient({ 'buy crypto': SCAM }));
  assert.equal(deletions().length, 1, 'a confident deletion still happens');
  assert.equal(cardsTo(LOG).length, 1, 'and is still reported');
  assert.equal(cardsTo(LOG)[0].reply_markup, undefined, 'buttons would be bound to a review row that does not exist');
});

// Without a chat config there is nothing to decide with: skip, which means
// not deleting.
test('a message is skipped when the chat row cannot be read', async () => {
  await chats.ensureChat(GROUP, 'Python Chat');
  await chats.updateChat(GROUP, { log_chat_id: LOG, mode: 'active', observe_until: '2020-01-01T00:00:00+00:00' });
  const client = new FakeJevClient({ 'buy crypto': SCAM });
  group.setClient(client);
  failNext(1, /INSERT INTO chats/);
  await dispatchMessage(groupMessage('buy crypto now'), bot());
  assert.deepEqual(deletions(), [], 'no delete is attempted without a chat config');
  assert.deepEqual(cardsTo(LOG), []);
  assert.deepEqual(client.calls, [], 'and no classifier call is spent either');
});

// The audit row is the record of a decision, not a precondition for it.
test('a locked audit table does not cancel the action', async () => {
  await chats.ensureChat(GROUP, 'Python Chat');
  failNext(10, /INSERT INTO audit/);
  await feed(groupMessage('buy crypto now'), new FakeJevClient({ 'buy crypto': SCAM }));
  assert.equal(deletions().length, 1);
  assert.equal(cardsTo(LOG).length, 1);
});

test('a programming error in a handler is logged, not thrown to the platform', async () => {
  const { guarded } = await import('../tgcloud/lib/dispatch.js');
  await guarded('message', { update: { update_id: 5 } }, async () => { throw new TypeError('boom'); });
});

// --- entitlement ---

test('entitlement is free when the group is small', async () => {
  const chat = await chats.ensureChat(GROUP, 'Small Group');
  world.members = 150;
  const [ent] = await group._entitlement(bot(), chat);
  assert.equal(ent.tier, tiers.FREE);
  assert.equal(ent.active, true);
});

test('a large unpaid group outside observation gets grace once', async () => {
  await chats.ensureChat(GROUP, 'Big Group');
  const chat = await chats.updateChat(GROUP, { mode: 'active', observe_until: '2020-01-01T00:00:00+00:00' });
  world.members = 5000;
  const [first] = await group._entitlement(bot(), chat);
  assert.equal(first.tier, tiers.LARGE);
  assert.deepEqual([first.active, first.reason], [true, 'grace']);
  const opened = (await billing.get(GROUP)).grace_until;
  const [second] = await group._entitlement(bot(), chat);
  assert.equal((await billing.get(GROUP)).grace_until, opened, 'grace must be set once, ever');
  assert.equal(second.reason, 'grace');
});

// Otherwise half the trial burns during a week when nothing is deleted.
test('grace does not start while the chat is still observing', async () => {
  const chat = await chats.ensureChat(GROUP, 'Big New Group');
  world.members = 5000;
  const [ent] = await group._entitlement(bot(), chat);
  assert.equal((await billing.get(GROUP)).grace_until, null);
  assert.equal(ent.active, false);
});

test('the member count is not refetched within the cache window', async () => {
  const chat = await chats.ensureChat(GROUP, 'Group');
  await group._entitlement(bot(), chat);
  await group._entitlement(bot(), chat);
  assert.equal(world.countCalls, 1);
});

// A billing lookup must never be what stops a group being moderated.
test('a failed member count lookup does not disarm moderation', async () => {
  const chat = await chats.ensureChat(GROUP, 'Group');
  world.countFails = true;
  const [ent] = await group._entitlement(bot(), chat);
  assert.equal(ent.active, true);
});

// A paying large group whose refetch fails must not silently demote to free.
test('a failed refetch keeps the cached tier', async () => {
  await chats.ensureChat(GROUP, 'Big Group');
  await chats.updateChat(GROUP, { mode: 'active', observe_until: '2020-01-01T00:00:00+00:00' });
  await billing.setMemberCount(GROUP, 5000);
  exec('UPDATE billing SET member_count_at = ? WHERE chat_id = ?', '2020-01-01T00:00:00+00:00', GROUP);
  world.countFails = true;
  const [ent] = await group._entitlement(bot(), await chats.getChat(GROUP));
  assert.equal(world.countCalls, 1, 'the refetch must actually have been attempted');
  assert.equal(ent.tier, tiers.LARGE, 'a failed refetch must not demote a paying group to free');
});

// The row handed to notices must carry the window just opened, or the admin
// is told the trial "ends in 0 days" on the day it started.
test('the message that opens grace announces a trial that has days left', async () => {
  world.members = 5000;
  await feed(groupMessage('morning all'), new FakeJevClient({}, { fallback: CHATTER }));
  assert.notEqual((await billing.get(GROUP)).grace_until, null, 'grace was never opened');
  assert.equal((await billing.get(GROUP)).notified_stage, notices.STAGE_GRACE);
  const body = cardsTo(LOG).at(-1).text;
  assert.ok(body.includes('14 more days'), `wrong day count in the notice: ${body}`);
  assert.ok(!body.includes('ends in 0 days'));
});

test('a large group still observing is told nothing', async () => {
  world.members = 5000;
  await feed(groupMessage('morning all'), new FakeJevClient({}, { fallback: CHATTER }), { active: false });
  assert.deepEqual(cardsTo(LOG), [], 'an observing chat was told something');
  assert.equal((await billing.get(GROUP)).notified_stage, null);
});

// A billing problem must never disarm moderation.
test('a failed startGrace leaves the chat entitled', async () => {
  await chats.ensureChat(GROUP, 'Big Group');
  await chats.updateChat(GROUP, { mode: 'active', observe_until: '2020-01-01T00:00:00+00:00' });
  world.members = 5000;
  failNext(1, /grace_until = COALESCE/);
  const [ent] = await group._entitlement(bot(), await chats.getChat(GROUP));
  assert.equal(ent.active, true, 'a locked database disarmed moderation');
  assert.equal(ent.reason, 'billing_unavailable');
});

// core/notices records no stage when the send fails, so nothing else bounds
// this: a destination that never answers would cost an invoice link plus a
// failing send on every message, forever.
test('notices are evaluated once per cache window, not per message', async () => {
  world.members = 5000;
  const client = new FakeJevClient({}, { fallback: CHATTER });
  await feed(groupMessage('morning all', { messageId: 1 }), client, { logChat: UNREACHABLE_LOG });
  assert.equal((await billing.get(GROUP)).notified_stage, null);
  assert.equal(calls('createInvoiceLink').length, 1, 'the first message must evaluate the notice');
  await dispatchMessage(groupMessage('morning again', { messageId: 2 }), bot());
  assert.equal(calls('createInvoiceLink').length, 1,
    'a second message inside the same cache window evaluated the notice again');
});

test('a reply in a forum topic stays in that topic', async () => {
  await chats.ensureChat(MODCHAT, 'Mod Room');
  world.plainMembers.add(`${MODCHAT}:${ADMIN}`);
  await dispatchMessage({ ...command('/setlog', MODCHAT, ADMIN), is_topic_message: true, message_thread_id: 12 }, bot());
  assert.equal(cardsTo(MODCHAT).at(-1).message_thread_id, 12);
});
