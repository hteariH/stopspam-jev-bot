import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { fresh, respond } from './helpers.js';
import { bot, calls } from './telegram.js';
import { dispatchCallbackQuery } from '../tgcloud/lib/dispatch.js';
import * as chats from '../tgcloud/lib/storage/chats.js';
import * as reviews from '../tgcloud/lib/storage/reviews.js';
import * as trust from '../tgcloud/lib/storage/trust.js';
import { t } from '../tgcloud/lib/texts.js';

const GROUP = -100123;
const LOG = -100999;
const SPAMMER = 555;
const ADMIN = 777;
const BYSTANDER = 888;

let onAdminLookup = null;

beforeEach(async () => {
  fresh();
  onAdminLookup = null;
  await chats.ensureChat(GROUP, 'Python Chat');
  await chats.updateChat(GROUP, { log_chat_id: LOG });
  respond('getChatMember', async (p) => {
    if (p.user_id === ADMIN) {
      if (onAdminLookup) await onAdminLookup();
      return { status: 'administrator', can_delete_messages: true, user: { id: ADMIN, is_bot: false, first_name: 'Boss' } };
    }
    return { status: 'member', user: { id: p.user_id, is_bot: false, first_name: 'Nobody' } };
  });
});

const makeReview = () => reviews.create(GROUP, 42, SPAMMER, 'buy crypto now', '{}', 0.93);

function pressRaw(data, by = ADMIN, card = null) {
  return {
    id: 'q1', from: { id: by, is_bot: false, first_name: 'Boss' }, chat_instance: 'ci',
    message: card || { message_id: 9001, date: 1, chat: { id: LOG, type: 'supergroup' }, text: 'card' },
    data,
  };
}

const press = (action, reviewId, by = ADMIN) => dispatchCallbackQuery(pressRaw(`rv:${action}:${reviewId}`, by), bot());
const feedRaw = (data) => dispatchCallbackQuery(pressRaw(data), bot());
const answers = () => calls('answerCallbackQuery');
const destructive = () => [...calls('deleteMessage'), ...calls('banChatMember')];

test('not spam allowlists the author', async () => {
  const rid = await makeReview();
  await press('ok', rid);
  assert.equal((await trust.get(GROUP, SPAMMER)).status, 'allowlisted');
  assert.equal((await reviews.get(rid)).decision, 'not_spam');
  assert.deepEqual(calls('deleteMessage'), []);
});

test('delete removes the message', async () => {
  const rid = await makeReview();
  await press('del', rid);
  const deleted = calls('deleteMessage');
  assert.equal(deleted[0].message_id, 42);
  assert.equal(deleted[0].chat_id, GROUP);
  assert.equal((await reviews.get(rid)).decision, 'delete');
});

// A banned author must also be marked flagged, which keeps them from ever
// being silently re-trusted.
test('ban deletes and bans', async () => {
  const rid = await makeReview();
  await press('ban', rid);
  assert.ok(calls('deleteMessage').length);
  assert.equal(calls('banChatMember')[0].user_id, SPAMMER);
  assert.equal((await reviews.get(rid)).decision, 'delete_ban');
  assert.equal((await trust.get(GROUP, SPAMMER)).status, 'flagged');
});

test('a non-admin press changes nothing', async () => {
  const rid = await makeReview();
  await press('ban', rid, BYSTANDER);
  assert.equal((await reviews.get(rid)).decision, null);
  assert.deepEqual(calls('banChatMember'), []);
  assert.ok(answers().at(-1).text);
  assert.equal(answers().at(-1).show_alert, true);
});

test('a second press is refused', async () => {
  const rid = await makeReview();
  await press('del', rid);
  const before = calls('banChatMember').length;
  await press('ban', rid);
  assert.equal(calls('banChatMember').length, before);
});

// A second admin's press lands between this press reading "unresolved" and
// claiming it. The atomic claim must then fail for this press, and none of
// its destructive actions may run.
test('concurrent presses: only one wins', async () => {
  const rid = await makeReview();
  onAdminLookup = () => reviews.resolve(rid, 'delete', 999);
  await press('ban', rid);
  const row = await reviews.get(rid);
  assert.equal(row.decision, 'delete', "the racer's decision must not be overwritten");
  assert.equal(row.decided_by, 999);
  assert.deepEqual(destructive(), []);
  assert.ok(answers().length, 'the losing press must still get an answer, not a hanging spinner');
});

test('the card is edited to show the outcome', async () => {
  const rid = await makeReview();
  await press('del', rid);
  const edits = calls('editMessageText');
  assert.ok(edits.length);
  assert.ok(edits[0].text.includes(t('done_delete', 'en')));
  assert.equal(edits[0].chat_id, LOG);
  assert.equal(edits[0].message_id, 9001);
});

// The edit appends the outcome to the card's own HTML, rebuilt from its
// entities, so the formatting of the card survives the edit.
test('the edited card keeps its formatting', async () => {
  const rid = await makeReview();
  const card = { message_id: 9001, date: 1, chat: { id: LOG, type: 'supergroup' },
    text: 'Possible spam\nA & B', entities: [{ type: 'bold', offset: 0, length: 13 }] };
  await dispatchCallbackQuery(pressRaw(`rv:del:${rid}`, ADMIN, card), bot());
  assert.equal(calls('editMessageText')[0].text,
    `<b>Possible spam</b>\nA &amp; B\n\n<i>${t('done_delete', 'en')}</i>`);
});

test('an inaccessible card is answered without an edit', async () => {
  const rid = await makeReview();
  await dispatchCallbackQuery(pressRaw(`rv:del:${rid}`, ADMIN, { message_id: 9001, date: 0, chat: { id: LOG, type: 'supergroup' } }), bot());
  assert.deepEqual(calls('editMessageText'), []);
  assert.ok(answers().length);
  assert.equal((await reviews.get(rid)).decision, 'delete');
});

for (const [name, data] of [
  ['a missing id', 'rv:ban'],
  ['a non-numeric id', 'rv:ban:abc'],
  ['an id too large for SQLite', 'rv:ban:' + '9'.repeat(40)],
  ['a negative id', 'rv:ban:-5'],
]) {
  test(`callback data with ${name} is answered, not crashed`, async () => {
    await feedRaw(data);
    assert.deepEqual(destructive(), []);
    assert.ok(answers().length);
  });
}

test('an unknown verb is answered, not crashed', async () => {
  const rid = await makeReview();
  await feedRaw(`rv:xyz:${rid}`);
  assert.equal((await reviews.get(rid)).decision, null);
  assert.deepEqual(destructive(), []);
  assert.ok(answers().length);
});
