import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { fresh, respond } from './helpers.js';
import { bot, calls } from './telegram.js';
import { adminChats, MAX_MENU_CHATS } from '../tgcloud/lib/core/admins.js';
import * as chats from '../tgcloud/lib/storage/chats.js';
import * as trust from '../tgcloud/lib/storage/trust.js';

const ADMIN = 777;
const STRANGER = 888;

beforeEach(() => {
  fresh();
  respond('getChatMember', (p) => ({ status: p.user_id === ADMIN ? 'administrator' : 'member' }));
});

test('only chats Telegram confirms the user administers are returned', async () => {
  await chats.ensureChat(-1, 'Mine');
  await chats.ensureChat(-2, 'Not mine');
  await trust.seen(-1, ADMIN);
  await trust.seen(-2, ADMIN);
  respond('getChatMember', (p) => ({ status: p.chat_id === -1 && p.user_id === ADMIN ? 'creator' : 'member' }));
  assert.deepEqual((await adminChats(bot(), ADMIN)).map((c) => c.title), ['Mine']);
});

test('a stranger costs no Telegram lookups', async () => {
  for (let i = 0; i < 5; i++) await chats.ensureChat(-200 - i, `Group ${i}`);
  assert.deepEqual(await adminChats(bot(), STRANGER), []);
  assert.deepEqual(calls('getChatMember'), []);
});

test('the candidate set is capped however many chats match', async () => {
  for (let i = 0; i < MAX_MENU_CHATS + 10; i++) {
    await chats.ensureChat(-300 - i, `Group ${i}`);
    await trust.seen(-300 - i, ADMIN);
  }
  await adminChats(bot(), ADMIN);
  assert.ok(calls('getChatMember').length <= MAX_MENU_CHATS);
});
