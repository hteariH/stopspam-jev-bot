// Pure helpers for the Mini App. No DOM, no Telegram: tested under node.

export const STEP = 0.05;

export function uiLang(code) {
  return code === 'ru' || code === 'uk' ? code : 'en';
}

// The one thing a chat card in the list (or the observe banner) should say.
export function badge(summary) {
  if (summary.observing) {
    return summary.observe_days_left > 0
      ? { key: 'badge_observe', days: summary.observe_days_left }
      : { key: 'badge_observe_only' };
  }
  const plan = summary.plan && typeof summary.plan === 'object' ? summary.plan.kind : summary.plan;
  if (plan === 'none') return { key: 'badge_unpaid' };
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
      next.observe_days_left = 0;
    } else if (name === 'mode') {
      next.mode = value;
      next.observing = value === 'observe' || next.observe_days_left > 0;
    } else if (name === 'log_to_me') {
      next.cards = { kind: 'me', id: next.cards.id };
    } else {
      next[name] = value;
    }
  }
  return next;
}

export function renderView(serverView, pending) {
  return serverView ? pending.reduce((v, p) => applyLocal(v, p.fields || p), serverView) : null;
}

export function syncChat(chats, view) {
  if (!chats) return chats;
  return chats.map((c) => (c.chat_id === view.chat_id ? {
    ...c,
    title: view.title,
    mode: view.mode,
    observing: view.observing,
    observe_days_left: view.observe_days_left,
    plan: view.plan.kind,
  } : c));
}

// Serializes app_update calls per screen against the last server-confirmed
// view; on failure drops queued follow-ups and restores serverView.
export function createSaveQueue({ send, onView, onServerView, onSaved, onError }) {
  let serverView = null;
  let pending = [];
  let chain = Promise.resolve();
  let closed = false;

  function setServerView(next) {
    if (onServerView) onServerView(next);
    if (closed) return;
    serverView = next;
    onView(renderView(serverView, pending));
  }

  function save(fields) {
    if (closed || !serverView) return;
    const entry = { fields, dropped: false };
    pending = [...pending, entry];
    onView(renderView(serverView, pending));
    chain = chain.then(() => {
      if (closed || entry.dropped) return;
      return send(fields).then((next) => {
        pending = pending.filter((p) => p !== entry);
        setServerView(next);
        if (!closed && onSaved) onSaved(next);
      }, (err) => {
        for (const p of pending) p.dropped = true;
        pending = [];
        chain = Promise.resolve();
        if (closed) return;
        onView(serverView);
        onError(err);
      });
    });
  }

  function close() {
    closed = true;
    for (const p of pending) p.dropped = true;
    pending = [];
  }

  return {
    setServerView,
    save,
    close,
    get serverView() { return serverView; },
  };
}

// Runs a Telegram popup (showAlert / showConfirm) only when none is open, and
// swallows WebAppPopupOpened if Telegram already had one open.
export function createPopupGuard() {
  let open = false;
  return function runPopup(run) {
    if (open) return false;
    open = true;
    try {
      run(() => { open = false; });
      return true;
    } catch {
      open = false;
      return false;
    }
  };
}
