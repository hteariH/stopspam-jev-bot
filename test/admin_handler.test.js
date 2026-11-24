import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { fresh, respond, BotApiError } from './helpers.js';
import { bot, calls } from './telegram.js';
import { dispatchCallbackQuery, dispatchMessage } from '../tgcloud/lib/dispatch.js';
import * as admin from '../tgcloud/lib/handlers/admin.js';
import * as chats from '../tgcloud/lib/storage/chats.js';
import * as config from '../tgcloud/lib/config.js';
import * as trust from '../tgcloud/lib/storage/trust.js';
import { STRINGS } from '../tgcloud/lib/texts.js';

const GROUP = -100123;
const ADMIN = 777;

beforeEach(async () => {
  fresh();
  await chats.ensureChat(GROUP, 'Python Chat');
  // Even with a candidate chat on file, /chats asks Telegram nothing.
  await trust.seen(GROUP, ADMIN);
  // Telegram's HTML mode does not understand "<chat>", so an unescaped title
  // containing it would be rejected; this simulates that rejection.
  respond('sendMessage', (p) => {
    if ((p.text || '').includes('<chat>')) throw new BotApiError(400, "Bad Request: can't parse entities");
    return { message_id: 1, date: 1, chat: { id: p.chat_id, type: 'private' }, text: p.text };
  });
  respond('getChatMember', (p) => (p.user_id === ADMIN
    ? { status: 'administrator', can_delete_messages: true, user: { id: ADMIN, is_bot: false, first_name: 'Boss' } }
    : { status: 'member', user: { id: p.user_id, is_bot: false, first_name: 'Nobody' } }));
});

function dm(text, userId = ADMIN) {
  return dispatchMessage({ message_id: 1, date: 1, chat: { id: userId, type: 'private' },
    from: { id: userId, is_bot: false, first_name: 'Boss' }, text }, bot());
}

function tap(data, userId = ADMIN) {
  return dispatchCallbackQuery({ id: 'q', from: { id: userId, is_bot: false, first_name: 'Boss' },
    chat_instance: 'ci', data,
    message: { message_id: 5, date: 1, chat: { id: userId, type: 'private' }, text: 'menu' } }, bot());
}

const sent = () => calls('sendMessage');

test('/privacy names the third party and the retention', async () => {
  await dm('/privacy');
  const body = sent().at(-1).text.toLowerCase();
  assert.ok(body.includes('typesafe'));
  assert.ok(body.includes('united states'));
  assert.ok(body.includes('7 days'));
});

test('/start greets in English', async () => {
  await dm('/start');
  const text = sent().at(-1).text;
  assert.ok(text.toLowerCase().includes('spam'));
  assert.ok(text.includes('/chats'));
});

test('/start with a deep-link argument still greets', async () => {
  await dm('/start from_group');
  assert.ok(sent().at(-1).text.includes('/chats'));
});

test('an unknown command in a private chat is ignored', async () => {
  await dm('/nope');
  await dm('hello');
  assert.deepEqual(sent(), []);
});

test('/chats replies with one button that opens the Mini App', async () => {
  await dm('/chats');
  const markup = sent().at(-1).reply_markup;
  assert.deepEqual(markup.inline_keyboard, [[{ text: STRINGS.btn_open_settings.en, web_app: { url: config.APP_URL } }]]);
  assert.deepEqual(calls('getChatMember'), [], '/chats itself asks Telegram nothing');
});

test('/chats speaks the user’s language', async () => {
  await dispatchMessage({ message_id: 1, date: 1, chat: { id: ADMIN, type: 'private' },
    from: { id: ADMIN, is_bot: false, first_name: 'Boss', language_code: 'ru' }, text: '/chats' }, bot());
  assert.equal(sent().at(-1).text, STRINGS.chats_open.ru);
});

test('a button on an old menu says the settings moved', async () => {
  const before = await chats.getChat(GROUP);
  await tap(`cfg:${GROUP}:jev`);
  const answer = calls('answerCallbackQuery').at(-1);
  assert.equal(answer.text, STRINGS.menu_moved.en);
  assert.equal(answer.show_alert, true);
  assert.deepEqual(await chats.getChat(GROUP), before);
});

test('the privacy text admits the two cases it used to omit', async () => {
  await dm('/privacy');
  const body = sent().at(-1).text.toLowerCase();
  assert.ok(body.includes('flagged') && body.includes('does not stop'));
  assert.ok(body.includes('30 days'));
  assert.ok(body.includes('5 clean messages'));
});

test('the privacy text names what is never sent', async () => {
  await dm('/privacy');
  const body = sent().at(-1).text.toLowerCase();
  assert.ok(body.includes('never send'));
  assert.ok(body.includes('admins and owners'));
  assert.ok(body.includes('neither text nor a caption'));
});

// No unhandled exception may leave a handler.
test('a failed DM does not escape the handler', async () => {
  const original = STRINGS.help.en;
  STRINGS.help.en = 'broken <chat> text';
  try {
    await admin.onHelp(bot(), { chat: { id: ADMIN, type: 'private' }, from: { id: ADMIN } });
  } finally {
    STRINGS.help.en = original;
  }
});

test('the privacy text admits the permanent payment record', async () => {
  await dm('/privacy');
  const body = sent().at(-1).text.toLowerCase();
  assert.ok(body.includes('permanent record'));
  assert.ok(body.includes('who paid'));
  assert.ok(body.includes('refunded') || body.includes('disputed'));
});

// A promise about retained personal data that only English speakers get is
// not a promise.
test('every language admits the permanent payment record', () => {
  for (const [lang, marker] of [['en', 'permanent'], ['ru', 'навсегда'], ['uk', 'назавжди']]) {
    assert.ok(STRINGS.privacy[lang].toLowerCase().includes(marker), `${lang} privacy text omits the payment record`);
  }
});

test('the README and the privacy text agree about the payment record', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8').toLowerCase();
  assert.ok(readme.includes('who paid'));
  assert.ok(readme.includes('append-only'));
});
