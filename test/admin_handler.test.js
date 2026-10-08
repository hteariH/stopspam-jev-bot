import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { fresh, respond, BotApiError } from './helpers.js';
import { bot, calls } from './telegram.js';
import { dispatchCallbackQuery, dispatchMessage } from '../tgcloud/lib/dispatch.js';
import * as admin from '../tgcloud/lib/handlers/admin.js';
import * as billing from '../tgcloud/lib/storage/billing.js';
import * as chats from '../tgcloud/lib/storage/chats.js';
import * as trust from '../tgcloud/lib/storage/trust.js';
import { STRINGS } from '../tgcloud/lib/texts.js';
import { addDays, stamp } from '../tgcloud/lib/clock.js';

const GROUP = -100123;
const ADMIN = 777;
const BYSTANDER = 888;
let invoiceFails = false;

beforeEach(async () => {
  fresh();
  invoiceFails = false;
  await chats.ensureChat(GROUP, 'Python Chat');
  // /chats only considers chats this user is plausibly in; an admin who has
  // posted in their own group is the ordinary case.
  await trust.seen(GROUP, ADMIN);
  // Telegram's HTML mode does not understand "<chat>", so an unescaped title
  // containing it would be rejected; this simulates that rejection.
  respond('sendMessage', (p) => {
    if ((p.text || '').includes('<chat>')) throw new BotApiError(400, "Bad Request: can't parse entities");
    return { message_id: 1, date: 1, chat: { id: p.chat_id, type: 'private' }, text: p.text };
  });
  respond('createInvoiceLink', () => {
    if (invoiceFails) throw new BotApiError(400, 'Bad Request: nope');
    return 'https://t.me/$invoice_test';
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
const edits = () => calls('editMessageText');
const lookups = () => calls('getChatMember');
const buttons = (markup) => markup.inline_keyboard.flat();

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

test('toggling jev persists', async () => {
  await tap(`cfg:${GROUP}:jev`);
  assert.equal((await chats.getChat(GROUP)).jev_enabled, false);
  await tap(`cfg:${GROUP}:jev`);
  assert.equal((await chats.getChat(GROUP)).jev_enabled, true);
});

test('the mode toggle persists', async () => {
  await tap(`cfg:${GROUP}:mode`);
  assert.equal((await chats.getChat(GROUP)).mode, 'active');
});

test('the threshold step is clamped to the unit interval', async () => {
  for (let i = 0; i < 30; i++) await tap(`cfg:${GROUP}:thr:delete_threshold:+`);
  assert.equal((await chats.getChat(GROUP)).delete_threshold, 1.0);
  await tap(`cfg:${GROUP}:thr:review_threshold:-`);
  assert.equal((await chats.getChat(GROUP)).review_threshold, 0.5);
});

test('a non-admin cannot change anything', async () => {
  const before = (await chats.getChat(GROUP)).jev_enabled;
  await tap(`cfg:${GROUP}:jev`, BYSTANDER);
  assert.equal((await chats.getChat(GROUP)).jev_enabled, before);
  const alerts = calls('answerCallbackQuery');
  assert.ok(alerts.at(-1).text);
});

test('the language switch changes the menu language', async () => {
  await tap(`cfg:${GROUP}:lang`);
  assert.equal((await chats.getChat(GROUP)).lang, 'ru');
});

// Flipping mode is not how a chat leaves or re-enters its observation window.
test('the mode toggle does not touch observe_until', async () => {
  const before = (await chats.getChat(GROUP)).observe_until;
  assert.notEqual(before, null);
  await tap(`cfg:${GROUP}:mode`);
  assert.equal((await chats.getChat(GROUP)).observe_until, before);
});

test('a bare chat callback re-renders the menu without changing state', async () => {
  const before = await chats.getChat(GROUP);
  await tap(`cfg:${GROUP}`);
  assert.deepEqual(await chats.getChat(GROUP), before);
  assert.ok(edits().at(-1).reply_markup);
});

test('malformed callback data is answered without touching anything', async () => {
  for (const data of ['cfg:', 'cfg:x:mode', `cfg:${GROUP}:evil`, `cfg:${GROUP}:thr:mode:+`, `cfg:${2n ** 63n}:mode`]) {
    await tap(data);
  }
  assert.equal(calls('answerCallbackQuery').length, 5);
  assert.deepEqual(lookups(), []);
});

// chat.title is free text rendered into an HTML message: unescaped, a real
// send would be rejected.
test('a group title with markup is escaped and does not crash /chats', async () => {
  await chats.updateChat(GROUP, { title: 'R&D <chat>' });
  await dm('/chats');
  const text = sent().at(-1).text;
  assert.ok(!text.includes('<chat>'));
  assert.ok(text.includes('&lt;chat&gt;'));
  assert.ok(text.includes('&amp;'));
});

// /chats is public: it must not ask Telegram about every known chat.
test('a stranger costs no Telegram lookups', async () => {
  for (let i = 0; i < 5; i++) await chats.ensureChat(-200 - i, `Group ${i}`);
  await dm('/chats', BYSTANDER);
  assert.deepEqual(lookups(), [], 'no candidate chats means no Telegram calls at all');
  assert.ok(sent().at(-1).text.includes('not in any group'));
});

test('the candidate set is capped however many chats match', async () => {
  for (let i = 0; i < admin.MAX_MENU_CHATS + 10; i++) {
    await chats.ensureChat(-300 - i, `Group ${i}`);
    await trust.seen(-300 - i, ADMIN);
  }
  await dm('/chats');
  assert.ok(lookups().length <= admin.MAX_MENU_CHATS);
});

test('repeated /chats from one user is rate-limited', async () => {
  for (let i = 0; i < admin.CHATS_PER_MINUTE; i++) await dm('/chats');
  const before = lookups().length;
  await dm('/chats');
  assert.equal(lookups().length, before, 'a refused command must not reach Telegram at all');
  assert.ok(sent().at(-1).text.includes('Too many requests'));
});

// One noisy stranger must not lock a real admin out of their own menu.
test('the budget is per user, not global', async () => {
  for (let i = 0; i < admin.CHATS_PER_MINUTE + 1; i++) await dm('/chats', BYSTANDER);
  await dm('/chats');
  assert.ok(!sent().at(-1).text.includes('Too many requests'));
});

test('the log button redirects cards to the pressing admin', async () => {
  assert.equal((await chats.getChat(GROUP)).log_chat_id, null);
  await tap(`cfg:${GROUP}:log`);
  assert.equal((await chats.getChat(GROUP)).log_chat_id, ADMIN);
});

test('a non-admin cannot claim the review queue', async () => {
  await tap(`cfg:${GROUP}:log`, BYSTANDER);
  assert.equal((await chats.getChat(GROUP)).log_chat_id, null);
});

test('the menu says where cards go when nowhere', async () => {
  await dm('/chats');
  const line = sent().at(-1).text.split('Review cards go to')[1].split('\n')[0];
  assert.ok(line.includes('no destination is set'));
  assert.ok(line.includes('cards are not delivered'));
});

test('the menu names the admin whose DM receives the cards', async () => {
  await chats.updateChat(GROUP, { log_chat_id: ADMIN });
  await dm('/chats');
  assert.ok(sent().at(-1).text.includes(`admin ${ADMIN}`));
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

test('the menu names the plan for a free group', async () => {
  await billing.setMemberCount(GROUP, 150);
  const [body] = admin.menu(await chats.getChat(GROUP), await billing.get(GROUP));
  assert.ok(body.includes('Plan'));
  assert.ok(body.includes('150'));
});

test('the menu tells an unpaid large group that nothing is deleted', async () => {
  await billing.setMemberCount(GROUP, 5000);
  const [body] = admin.menu(await chats.getChat(GROUP), await billing.get(GROUP));
  assert.ok(body.includes('no subscription'));
});

test('the start-deleting button appears only while observing', async () => {
  const [, observing] = admin.menu(await chats.getChat(GROUP), await billing.get(GROUP));
  assert.ok(buttons(observing).some((b) => (b.callback_data || '').endsWith(':gonow')));
  await chats.updateChat(GROUP, { mode: 'active', observe_until: '2020-01-01T00:00:00+00:00' });
  const [, done] = admin.menu(await chats.getChat(GROUP), await billing.get(GROUP));
  assert.ok(!buttons(done).some((b) => (b.callback_data || '').endsWith(':gonow')));
});

test('pressing start deleting ends the observation window', async () => {
  await tap(`cfg:${GROUP}:gonow`);
  const chat = await chats.getChat(GROUP);
  assert.equal(chat.mode, 'active');
  assert.equal(chats.isObserving(chat), false);
});

test('a non-admin cannot end the observation window', async () => {
  await tap(`cfg:${GROUP}:gonow`, BYSTANDER);
  assert.equal(chats.isObserving(await chats.getChat(GROUP)), true);
});

test('gonow is an accepted callback field', () => {
  assert.deepEqual(admin.parseCallback('cfg:-100123:gonow'), [-100123, 'gonow', null]);
});

// An admin who presses "start deleting now" on an unpaid large group is at
// the exact moment enforcement becomes payment-gated.
test('the subscribe button survives a button press', async () => {
  await billing.setMemberCount(GROUP, 5000);
  await tap(`cfg:${GROUP}:gonow`);
  assert.ok(edits().length, 'the menu was never re-rendered');
  assert.ok(buttons(edits().at(-1).reply_markup).some((b) => b.url), 'the re-rendered menu offers no way to subscribe');
});

test('a language toggle does not lose the subscribe button either', async () => {
  await billing.setMemberCount(GROUP, 5000);
  await tap(`cfg:${GROUP}:lang`);
  assert.ok(buttons(edits().at(-1).reply_markup).some((b) => b.url));
});

test('a re-render says so when no invoice link can be made', async () => {
  await billing.setMemberCount(GROUP, 5000);
  invoiceFails = true;
  await tap(`cfg:${GROUP}:mode`);
  assert.ok(!buttons(edits().at(-1).reply_markup).some((b) => b.url));
  assert.ok(edits().at(-1).text.includes('<i>'), 'the menu does not say the link is unavailable');
});

test('a subscribed chat is not offered the button again', async () => {
  await billing.setMemberCount(GROUP, 5000);
  await billing.recordPayment({ chargeId: 'ch_1', chatId: GROUP, payerUserId: ADMIN, stars: 250,
    isRecurring: false, expiresAt: stamp(addDays(new Date(), 30)) });
  await tap(`cfg:${GROUP}:mode`);
  assert.ok(!buttons(edits().at(-1).reply_markup).some((b) => b.url));
});

test('/chats offers the subscription to an unpaid large group', async () => {
  await billing.setMemberCount(GROUP, 5000);
  await dm('/chats');
  assert.ok(buttons(sent().at(-1).reply_markup).some((b) => b.url));
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
