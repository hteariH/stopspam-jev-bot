// A stand-in for the platform's `sdk` module.
//
// `api` records every Bot API call and answers from per-method responders a
// test installs; `fetch` answers from a script a test installs. Both start
// empty for each test through reset().
import { db, sql } from './sdk-db.js';

export { db, sql };

export class BotApiError extends Error {
  constructor(code, description, method = '', parameters = undefined) {
    super(`${method}: ${code} ${description}`);
    this.name = 'BotApiError';
    this.code = code;
    this.description = description;
    this.method = method;
    this.parameters = parameters;
  }
}

export class EndpointError extends Error {
  constructor(description, parameters = undefined) {
    super(description);
    this.name = 'EndpointError';
    this.description = description;
    this.parameters = parameters;
  }
}

const calls = [];
const responders = new Map();
let messageId = 1000;

function defaultResponse(method, params) {
  switch (method) {
    case 'getMe':
      return { id: 42, is_bot: true, first_name: 'StopSpam', username: 'StopSpam_jev_bot' };
    case 'sendMessage':
    case 'editMessageText':
      messageId += 1;
      return { message_id: messageId, chat: { id: params.chat_id }, date: 0, text: params.text };
    case 'createInvoiceLink':
      return 'https://t.me/$invoice';
    default:
      return true;
  }
}

export const api = new Proxy({}, {
  get(_target, method) {
    if (method === 'calls') return calls;
    if (typeof method !== 'string' || method === 'then') return undefined;
    return async (params = {}) => {
      calls.push({ method, params });
      const responder = responders.get(method);
      if (responder === undefined) return defaultResponse(method, params);
      if (typeof responder === 'function') return responder(params);
      return responder;
    };
  },
});

// A responder is a value or a function of the params; a function may throw a
// BotApiError to simulate Telegram refusing the call.
export function respond(method, responder) {
  responders.set(method, responder);
}

let fetchScript = null;
export const fetchCalls = [];

export async function fetch(url, init = {}) {
  fetchCalls.push({ url, init });
  if (!fetchScript) throw new Error('fetch called with no script installed');
  return fetchScript(url, init);
}

export function scriptFetch(fn) {
  fetchScript = fn;
}

// A minimal Response, enough for code that reads status/ok/json/text.
export function response(status, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: String(status),
    headers: { get: (k) => lower[k.toLowerCase()] ?? null, has: (k) => k.toLowerCase() in lower },
    async json() { return JSON.parse(text); },
    async text() { return text; },
  };
}

export function resetSdk() {
  calls.length = 0;
  responders.clear();
  fetchScript = null;
  fetchCalls.length = 0;
}

export default { db, api, fetch, BotApiError, EndpointError };
