// A fake Telegram.WebApp for `npm run dev` in a plain browser. Never built
// into dist/: main.jsx imports it only under import.meta.env.DEV.
const chat = {
  chat_id: -1001, title: 'Demo group', mode: 'observe', observing: true, observe_days_left: 5,
  jev_enabled: true, delete_threshold: 0.9, review_threshold: 0.55, confidence_floor: 0.75,
  trust_after: 5, lang: 'en', cards: { kind: 'unset', id: null },
  plan: { kind: 'none', days: null, members: 640, limit: 200, offer_stars: 250 },
  subscribe_url: 'https://t.me/$demo', subscribe_stars: 250,
};
const noop = () => {};
window.Telegram = { WebApp: {
  initData: 'dev', initDataUnsafe: { user: { id: 1, language_code: navigator.language.slice(0, 2) } },
  ready: noop, expand: noop,
  BackButton: { show: noop, hide: noop, onClick: noop, offClick: noop },
  HapticFeedback: { impactOccurred: noop },
  showAlert: (m, cb) => { window.alert(m); if (cb) cb(); },
  showConfirm: (m, cb) => cb(window.confirm(m)),
  openInvoice: (_u, cb) => cb('cancelled'),
  Serverless: { call(name, input, cb) {
    setTimeout(() => {
      if (name === 'app_chats') {
        return cb(null, { chats: [{ chat_id: chat.chat_id, title: chat.title, mode: chat.mode, observing: chat.observing, observe_days_left: chat.observe_days_left, plan: chat.plan.kind }] });
      }
      if (name === 'app_chat') return cb(null, { ...chat });
      if (name === 'app_update') {
        const merged = { ...chat, ...input.fields };
        if (merged.review_threshold > merged.delete_threshold) {
          return cb({ type: 'ENDPOINT_ERROR', parameters: { code: 'INVALID' } });
        }
        const { end_observe: endObserve, log_to_me: logToMe, ...rest } = input.fields;
        Object.assign(chat, rest);
        if (rest.mode) chat.observing = rest.mode === 'observe' || chat.observe_days_left > 0;
        if (endObserve) Object.assign(chat, { mode: 'active', observing: false, observe_days_left: 0 });
        if (logToMe) chat.cards = { kind: 'me', id: 1 };
        return cb(null, { ...chat });
      }
      return cb({ type: 'UNKNOWN' });
    }, 200);
  } },
} };
