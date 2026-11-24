// Pure helpers for the Mini App. No DOM, no Telegram: tested under node.

export const STEP = 0.05;

export function uiLang(code) {
  return code === 'ru' || code === 'uk' ? code : 'en';
}

// The one thing a chat card in the list should say about the chat.
export function badge(summary) {
  if (summary.observing) return { key: 'badge_observe', days: summary.observe_days_left };
  if (summary.plan === 'none') return { key: 'badge_unpaid' };
  return { key: 'badge_active' };
}

const ERRORS = {
  NOT_ADMIN: 'err_not_admin',
  RATE_LIMITED: 'err_rate_limited',
  INVALID: 'err_invalid',
  NOT_FOUND: 'err_not_found',
};

// Serverless.call's err: type 'ENDPOINT_ERROR' when the endpoint threw an
// EndpointError, with our { code } in err.parameters.
export function errorKey(err) {
  const code = err && err.type === 'ENDPOINT_ERROR' && err.parameters && err.parameters.code;
  return ERRORS[code] || 'err_generic';
}

export function cardsKey(cards) {
  return `cards_${cards.kind}`;
}

export function fmt(x) {
  return Number(x).toFixed(2);
}

// What the screen shows between sending a change and the server's answer.
export function applyLocal(view, fields) {
  const next = { ...view };
  for (const [name, value] of Object.entries(fields)) {
    if (name === 'end_observe') {
      next.mode = 'active';
      next.observing = false;
    } else if (name === 'log_to_me') {
      next.cards = { kind: 'me', id: view.cards.id };
    } else {
      next[name] = value;
    }
  }
  return next;
}
