// The handful of Bot API calls the bot makes, in the shape the Python code
// called them through aiogram, so the ported modules read like the originals.
//
// Two things aiogram did implicitly happen here explicitly: every message
// goes out with parse_mode HTML (the Python Bot had it as its default), and
// getMe is cached rather than asked for on every group message.
import * as settings from './storage/settings.js';

let cachedMe = null;

export function _resetBotCache() {
  cachedMe = null;
}

export function makeBot(api) {
  return {
    api,

    sendMessage(chatId, text, { replyMarkup, threadId } = {}) {
      const params = { chat_id: chatId, text, parse_mode: 'HTML' };
      if (threadId) params.message_thread_id = threadId;
      if (replyMarkup) params.reply_markup = replyMarkup;
      return api.sendMessage(params);
    },

    // aiogram's Message.answer: a reply in the same chat, and in the same
    // forum topic when the message came from one.
    answer(message, text, { replyMarkup } = {}) {
      const threadId = message.is_topic_message ? message.message_thread_id : undefined;
      return this.sendMessage(message.chat.id, text, { replyMarkup, threadId });
    },

    editMessageText(chatId, messageId, text, { replyMarkup } = {}) {
      const params = { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML' };
      if (replyMarkup) params.reply_markup = replyMarkup;
      return api.editMessageText(params);
    },

    deleteMessage(chatId, messageId) {
      return api.deleteMessage({ chat_id: chatId, message_id: messageId });
    },

    banChatMember(chatId, userId) {
      return api.banChatMember({ chat_id: chatId, user_id: userId });
    },

    getChatMember(chatId, userId) {
      return api.getChatMember({ chat_id: chatId, user_id: userId });
    },

    getChatMemberCount(chatId) {
      return api.getChatMemberCount({ chat_id: chatId });
    },

    createInvoiceLink(params) {
      return api.createInvoiceLink(params);
    },

    answerCallbackQuery(id, { text, showAlert } = {}) {
      const params = { callback_query_id: id };
      if (text !== undefined && text !== null) params.text = text;
      if (showAlert) params.show_alert = true;
      return api.answerCallbackQuery(params);
    },

    answerPreCheckoutQuery(id, { ok, errorMessage }) {
      const params = { pre_checkout_query_id: id, ok };
      if (errorMessage) params.error_message = errorMessage;
      return api.answerPreCheckoutQuery(params);
    },

    setMyCommands(commands) {
      return api.setMyCommands({ commands });
    },

    // The bot's own User. Cached in module scope for as long as the isolate
    // lives, and in the settings table across isolates: the id and username
    // never change, and asking on every group message would double the
    // Bot API calls the busiest path makes.
    async me() {
      if (cachedMe) return cachedMe;
      try {
        const stored = await settings.get(settings.BOT_ME);
        if (stored) {
          cachedMe = JSON.parse(stored);
          return cachedMe;
        }
      } catch (exc) {
        if (exc instanceof TypeError || exc instanceof ReferenceError) throw exc;
        // A storage failure only costs the getMe call below.
      }
      const me = await api.getMe();
      cachedMe = me;
      try {
        await settings.set(settings.BOT_ME, JSON.stringify(me));
      } catch (exc) {
        if (exc instanceof TypeError || exc instanceof ReferenceError) throw exc;
      }
      return me;
    },
  };
}
