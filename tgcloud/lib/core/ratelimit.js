// A sliding-window rate limiter, used for several different keys.
//
// Enforcement is capped per group per minute so a raid cannot turn the bot
// into a flood source and get it banned. Public commands are capped per user
// per minute so a stranger cannot make the bot spend its Telegram budget on
// demand. Both are the same shape, so they are the same class keyed
// differently.
//
// The Python kept the window in a deque in process memory. An isolate keeps
// nothing between updates, so the window lives in the rate_events table,
// one row per event, scoped by limiter name.
import { db } from 'sdk';
import { sql } from 'sdk/db';

import { now } from '../clock.js';
import { logger } from '../log.js';

const log = logger('stopspam.ratelimit');

const WINDOW_MS = 60 * 1000;

export class RateLimiter {
  constructor(scope, perMinute) {
    this.scope = scope;
    this.perMinute = perMinute;
  }

  // True if this key still has budget, and spends one unit of it.
  //
  // `key` is a chat id for enforcement and a user id for commands - the
  // budget is per key, never global, so one busy group or one noisy stranger
  // cannot spend everybody else's.
  //
  // A storage failure allows the event: the window is a guard against floods,
  // and a locked database must not be what stops a group being moderated or
  // an admin opening their menu.
  async allow(key) {
    const at = now().getTime();
    try {
      // Strictly older than the window, as the Python deque popped them.
      await db.run(sql`DELETE FROM rate_events
                       WHERE scope = ${this.scope} AND key = ${key} AND at_ms < ${at - WINDOW_MS}`);
      const row = await db.get(sql`SELECT count(*) AS n FROM rate_events
                                   WHERE scope = ${this.scope} AND key = ${key}`);
      if (row.n >= this.perMinute) return false;
      await db.run(sql`INSERT INTO rate_events (scope, key, at_ms) VALUES (${this.scope}, ${key}, ${at})`);
    } catch (exc) {
      if (exc instanceof TypeError || exc instanceof ReferenceError) throw exc;
      log.warning('rate limiter %s unavailable, allowing key %s: %s', this.scope, key, exc);
    }
    return true;
  }
}
