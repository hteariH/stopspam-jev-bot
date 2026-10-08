// Shared per-test setup: a fresh in-memory database built from
// tgcloud/schema.js, an sdk with no recorded calls, and the real clock.
import * as schema from '../tgcloud/schema.js';
import { resetDb, rawDb, failNext } from './fakes/sdk-db.js';
import { resetSdk, api, respond, scriptFetch, fetchCalls, response, BotApiError } from './fakes/sdk.js';
import { _setNow } from '../tgcloud/lib/clock.js';
import { _resetBotCache } from '../tgcloud/lib/bot.js';

export { rawDb, failNext, api, respond, scriptFetch, fetchCalls, response, BotApiError };

export function fresh() {
  resetDb(schema);
  resetSdk();
  _setNow(null);
  _resetBotCache();
}

// Rows straight from the test database, bypassing the code under test.
export function rows(query, ...params) {
  return rawDb().prepare(query).all(...params).map((r) => ({ ...r }));
}

export function row(query, ...params) {
  const r = rawDb().prepare(query).get(...params);
  return r ? { ...r } : null;
}

export function exec(query, ...params) {
  return rawDb().prepare(query).run(...params);
}

export function callsTo(method) {
  return api.calls.filter((c) => c.method === method).map((c) => c.params);
}

export function telegramError(description = 'Bad Request: test', code = 400) {
  return () => { throw new BotApiError(code, description); };
}
