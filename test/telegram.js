// A scripted Telegram for the handler tests: the Python suite's fake_call,
// as responders on the fake `api`.
import { api, respond, BotApiError } from './fakes/sdk.js';
import { makeBot } from '../tgcloud/lib/bot.js';

export const NOW = new Date(Date.UTC(2026, 0, 1));
export const GROUP = -100123;
export const SPAMMER = 555;
export const LOG = -100999;
// A card destination every send to fails, standing in for the admin who
// never pressed Start or who blocked the bot.
export const UNREACHABLE_LOG = -100888;
export const ADMIN = 777;
export const MODCHAT = -100777;
export const BOT_ID = 1;

export const world = {
  // User ids whose getChatMember lookup fails.
  unreachable: new Set(),
  // "chatId:userId" pairs reported as an ordinary member rather than owner.
  plainMembers: new Set(),
  members: 150,
  countCalls: 0,
  countFails: false,
};

function networkError(method, description) {
  return new BotApiError(502, description, method);
}

// Installs the default world: everyone but SPAMMER (and plainMembers) is the
// group's owner, sends succeed except to UNREACHABLE_LOG, and the group has
// `world.members` members.
export function installTelegram() {
  world.unreachable = new Set();
  world.plainMembers = new Set();
  world.members = 150;
  world.countCalls = 0;
  world.countFails = false;
  respond('getMe', { id: BOT_ID, is_bot: true, first_name: 'StopSpam', username: 'StopSpam_jev_bot' });
  respond('sendMessage', (p) => {
    if (p.chat_id === UNREACHABLE_LOG) throw networkError('sendMessage', 'chat not found');
    return { message_id: 9001, date: 1, chat: { id: p.chat_id, type: 'supergroup' }, text: p.text };
  });
  respond('getChatMember', (p) => {
    if (world.unreachable.has(p.user_id)) throw networkError('getChatMember', 'lookup failed');
    if (p.user_id === SPAMMER || world.plainMembers.has(`${p.chat_id}:${p.user_id}`)) {
      return { status: 'member', user: { id: p.user_id, is_bot: false, first_name: 'Ann' } };
    }
    return { status: 'creator', is_anonymous: false, user: { id: p.user_id, is_bot: false, first_name: 'Boss' } };
  });
  respond('createInvoiceLink', 'https://t.me/$invoice_test');
  respond('getChatMemberCount', () => {
    world.countCalls += 1;
    if (world.countFails) throw networkError('getChatMemberCount', 'count failed');
    return world.members;
  });
}

export function bot() {
  return makeBot(api);
}

export const calls = (method) => api.calls.filter((c) => c.method === method).map((c) => c.params);
export const deletions = () => calls('deleteMessage');
export const cardsTo = (chatId) => calls('sendMessage').filter((p) => p.chat_id === chatId);

export function groupMessage(text, { userId = SPAMMER, messageId = 1 } = {}) {
  return {
    message_id: messageId, date: 1,
    chat: { id: GROUP, type: 'supergroup', title: 'Python Chat' },
    from: { id: userId, is_bot: false, first_name: 'Ann', username: 'ann' },
    text,
  };
}

export function command(text, chatId, userId, chatType = 'supergroup') {
  return {
    message_id: 77, date: 1,
    chat: { id: chatId, type: chatType, title: 'Mod Room' },
    from: { id: userId, is_bot: false, first_name: 'Boss' },
    text,
    entities: [{ type: 'bot_command', offset: 0, length: text.split(/\s+/)[0].length }],
  };
}
